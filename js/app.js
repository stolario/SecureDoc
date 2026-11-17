'use strict';
// Wires the setup / editor views. The browser OWNS the open document (DESIGN.md §1): its content
// lives in the editor, and its passphrase / title / created-time live here in memory. Decrypting on
// open, encrypting on save (sdoc.js) and DOCX import (import.js) all run in this page — nothing is
// sent to a server. Saving writes the .sdoc back to the file the user picked once (File System Access API),
// falling back to a download where that API is missing. The passphrase never leaves the page.
(function () {
    let dirty = false;
    // Owned by the browser for the open document. The passphrase is kept in memory (never written to
    // disk) so re-encrypting on save needs no re-prompt; JS strings can't be zeroed like a char[].
    let passphrase = null;
    // Changes whenever a different document/passphrase context is installed. Save caching uses this
    // opaque number instead of retaining the passphrase inside a JSON cache key.
    let secretVersion = 0;
    let title = 'New document';
    let createdAt = null;        // ISO instant from a decrypted/opened doc; null for a fresh one
    let docName = 'untitled.sdoc';
    // A newly created/imported document has no .sdoc yet, so Save is its only meaningful choice.
    // Once it has been saved — or when an existing .sdoc was opened — expose Save as / Save a copy.
    let hasDocumentFile = false;
    // Where Save writes. A FileSystemFileHandle from showSaveFilePicker: asked for ONCE, then
    // every later save overwrites that file silently. null = no target yet (fresh/imported/just-opened
    // doc, or a browser without the API), so the next save asks where.
    let fileHandle = null;

    const $ = function (id) { return document.getElementById(id); };

    function setSaveOptionsAvailable(available) {
        hasDocumentFile = available;
        $('save-menu-btn').hidden = !available;
        $('save-control').classList.toggle('single', !available);
        if (!available) {
            $('save-menu').hidden = true;
            $('save-menu-btn').setAttribute('aria-expanded', 'false');
        }
    }

    function showView(which) {
        $('setup-view').hidden = which !== 'setup';
        $('editor-view').hidden = which !== 'editor';
    }
    function setupError(msg) {
        const b = $('setup-error');
        if (!msg) { b.hidden = true; return; }
        b.textContent = msg;
        b.hidden = false;
    }
    function status(msg) { $('status').textContent = msg || ''; }

    // ── modified mark ──
    // "*" on the save button and in the tab title while the document differs from what is on disk.
    // An edit sets it at once; a moment later the content is compared with the last saved snapshot,
    // so typing and then undoing back to the saved text clears it again.
    let savedContent = null;     // Editor.serialize() as last saved / opened; null = not on disk yet
    let editRevision = 0;        // cheap identity for the current editor state; avoids content-sized keys
    let savedRevision = 0;
    let pendingPassword = false; // true only while a passphrase change is being saved
    let needsKdfUpgrade = false; // weak legacy KDF: the next save migrates it to today's profile
    let dirtyCheck = 0;

    function cancelDirtyCheck() {
        if (!dirtyCheck) return;
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(dirtyCheck);
        else clearTimeout(dirtyCheck);
        dirtyCheck = 0;
    }

    function scheduleDirtyCheck() {
        cancelDirtyCheck();
        const revision = editRevision;
        const check = function () {
            dirtyCheck = 0;
            if ($('editor-view').hidden || revision !== editRevision) return;
            // Exact comparison is deliberately idle work: it preserves the useful "undo back to the
            // saved text is clean" behaviour without serializing the document in the typing path.
            recheckDirty(Editor.serialize());
        };
        dirtyCheck = typeof requestIdleCallback === 'function'
            ? requestIdleCallback(check, { timeout: 2000 })
            : setTimeout(check, 1200);
    }

    function setDirty(v) {
        dirty = v;
        $('dirty-mark').hidden = !v;
        document.title = (v ? '* ' : '') + (title || 'Document') + ' — SecureDoc';
    }
    function markDirty() {
        editRevision++;
        setDirty(true);
        status('Unsaved');
        scheduleDirtyCheck();
    }
    function recheckDirty(content) {
        if ($('editor-view').hidden) return;
        const contentMatches = content === undefined
            ? editRevision === savedRevision
            : content === savedContent;
        const changed = pendingPassword || needsKdfUpgrade || !contentMatches;
        if (!changed && dirty) status('');
        setDirty(changed);
    }
    // `content` is what just reached the disk; edits made while it was being written stay marked.
    function markSaved(content, revision) {
        savedContent = content;
        savedRevision = revision;
        cancelDirtyCheck();
        pendingPassword = false;
        needsKdfUpgrade = false;
        recheckDirty();
    }

    let busyNow = false;
    function setBusy(msg) {
        busyNow = !!msg;
        const b = $('setup-busy');
        if (!msg) { b.hidden = true; } else { b.textContent = msg; b.hidden = false; }
        ['create-btn', 'import-btn', 'open-file', 'import-file'].forEach(function (id) {
            $(id).disabled = busyNow;
        });
        refreshUnlock(); // Unlock & open stays off while something is running, and only then
    }

    function surface(msg) {
        if (!$('editor-view').hidden) status(msg); else setupError(msg);
    }
    window.addEventListener('error', function (e) {
        surface('JS error: ' + (e.message || (e.error && e.error.message) || 'unknown'));
    });
    window.addEventListener('unhandledrejection', function (e) {
        const r = e.reason;
        surface('Error: ' + ((r && r.message) || r || 'unknown'));
    });

    function sanitizeName(name) {
        return (name || 'untitled').replace(/[\\/:*?"<>|]/g, '_');
    }
    // Fallback for browsers without the File System Access API (Firefox, Safari): a plain download.
    // Those browsers ask where to put every download if the user configured them that way — there is
    // no way around it, because the page never gets a handle to the file on disk.
    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    }
    function blobAsDataUrl(blob) {
        return new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = function () { reject(reader.error || new Error('Could not read an image')); };
            reader.readAsDataURL(blob);
        });
    }
    const EXPORTED_FONT_FACES = {
        'Amstelvar': { key: 'Amstelvar', family: 'Amstelvar', script: 'js/font-data/amstelvar.js',
            weight: '100 1000', stretch: '50% 125%', style: 'normal' },
        'Amstelvar Italic': { key: 'Amstelvar Italic', family: 'Amstelvar', script: 'js/font-data/amstelvar-italic.js',
            weight: '100 900', stretch: '50% 125%', style: 'italic' },
        'Roboto Flex': { key: 'Roboto Flex', family: 'Roboto Flex', script: 'js/font-data/roboto-flex.js',
            weight: '100 1000', stretch: '25% 151%', style: 'normal' },
        'Roboto Serif': { key: 'Roboto Serif', family: 'Roboto Serif', script: 'js/font-data/roboto-serif.js',
            weight: '100 900', stretch: '50% 150%', style: 'normal' }
    };
    const exportedFontLoads = new Map();
    function loadExportedFont(face) {
        window.SecureDocFontData = window.SecureDocFontData || {};
        if (window.SecureDocFontData[face.key]) return Promise.resolve(window.SecureDocFontData[face.key]);
        if (!exportedFontLoads.has(face.key)) {
            exportedFontLoads.set(face.key, new Promise(function (resolve, reject) {
                const script = document.createElement('script');
                script.src = new URL(face.script, document.baseURI).href;
                script.onload = function () {
                    script.remove();
                    const data = window.SecureDocFontData[face.key];
                    if (data) resolve(data); else reject(new Error('Bundled font data is missing: ' + face.key));
                };
                script.onerror = function () {
                    script.remove();
                    exportedFontLoads.delete(face.key);
                    reject(new Error('Could not load bundled font data: ' + face.key));
                };
                document.head.appendChild(script);
            }));
        }
        return exportedFontLoads.get(face.key);
    }
    function usedExportedFontFaces(content) {
        const template = document.createElement('template');
        template.innerHTML = content;
        const used = new Set();
        const bundledFamilies = ['Amstelvar', 'Roboto Flex', 'Roboto Serif'];
        function familyFrom(value) {
            const first = String(value || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
            return bundledFamilies.filter(function (family) {
                return family.toLowerCase() === first.toLowerCase();
            })[0] || null;
        }
        function walk(node, inheritedFamily, inheritedItalic) {
            if (node.nodeType === Node.TEXT_NODE) {
                if (node.nodeValue.length && inheritedFamily) {
                    used.add(inheritedFamily);
                    if (inheritedFamily === 'Amstelvar' && inheritedItalic) used.add('Amstelvar Italic');
                }
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
            let family = inheritedFamily;
            let italic = inheritedItalic;
            if (node.nodeType === Node.ELEMENT_NODE) {
                const declaredFamily = node.style.fontFamily
                    || (node.tagName === 'FONT' ? node.getAttribute('face') : '');
                if (declaredFamily) family = familyFrom(declaredFamily);
                if (node.tagName === 'EM' || node.tagName === 'I') italic = true;
                if (node.style.fontStyle === 'normal') italic = false;
                else if (/^(italic|oblique)/i.test(node.style.fontStyle)) italic = true;
            }
            node.childNodes.forEach(function (child) { walk(child, family, italic); });
        }
        walk(template.content, 'Amstelvar', false);
        return Array.from(used).map(function (key) { return EXPORTED_FONT_FACES[key]; });
    }
    async function exportedFontCss(content) {
        const faces = usedExportedFontFaces(content);
        const data = await Promise.all(faces.map(loadExportedFont));
        return faces.map(function (face, i) {
            return '@font-face{font-family:"' + face.family + '";src:url("' + data[i]
                + '") format("truetype");font-weight:' + face.weight + ';font-stretch:'
                + face.stretch + ';font-style:' + face.style + ';font-display:swap}';
        }).join('');
    }
    function escapeHtmlText(value) {
        return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    // Load a decoded document's media (id -> Uint8Array) into the editor's client-side store.
    function loadMedia(mediaMap) {
        Editor.clearMedia();
        Object.keys(mediaMap || {}).forEach(function (id) {
            Editor.putMediaBytes(id, mediaMap[id]);
        });
    }

    // ── setup tabs ──
    // A real tablist: one tab stop, arrow keys / Home / End move between the tabs.
    const tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
    function selectTab(tab, focus) {
        tabs.forEach(function (t) {
            const on = t === tab;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
            t.tabIndex = on ? 0 : -1;
            $(t.getAttribute('aria-controls')).hidden = !on;
        });
        // progress and errors show under the passphrase of whichever panel is open
        if (tab.getAttribute('aria-controls') === 'tab-open') openMsgHome();
        else {
            $(tab.getAttribute('aria-controls')).querySelector('.field-msg')
                .append($('setup-busy'), $('setup-error'));
        }
        setupError(null);
        if (focus) tab.focus();
    }
    tabs.forEach(function (tab, i) {
        tab.addEventListener('click', function () { selectTab(tab); });
        tab.addEventListener('keydown', function (e) {
            const n = tabs.length;
            const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i + n - 1) % n, Home: 0, End: n - 1 }[e.key];
            if (to === undefined) return;
            e.preventDefault();
            selectTab(tabs[to], true);
        });
    });

    // ── passphrase fields: a live "n/12" and twelve bars, both in the accent colour at exactly 12 ──
    // Only feedback — too many or too few words are caught when the phrase is used.
    document.querySelectorAll('.phrase-field').forEach(function (field) {
        const input = field.querySelector('textarea');
        const count = field.querySelector('.word-count');
        const bars = field.querySelector('.word-bars');
        for (let i = 0; i < 12; i++) bars.appendChild(document.createElement('span'));
        function update() {
            const n = Passphrase.wordCount(input.value);
            count.textContent = n + '/12';
            count.classList.toggle('full', n === 12);
            bars.classList.toggle('full', n === 12);
            Array.prototype.forEach.call(bars.children, function (bar, i) { bar.classList.toggle('on', i < n); });
        }
        input.addEventListener('input', update);
        update();
    });
    function setPhrase(id, phrase) {
        $(id).value = phrase;
        $(id).dispatchEvent(new Event('input')); // a value set from script fires no input event
    }

    $('gen-btn').addEventListener('click', function () {
        setPhrase('new-phrase', Passphrase.generate());
        $('phrase-warn').hidden = false;
    });
    $('import-gen').addEventListener('click', function () {
        setPhrase('import-phrase', Passphrase.generate());
    });

    // Normalize a proposed file name: strip characters the OS rejects, always end in .sdoc. Used for
    // the name suggested in the Save dialog — renaming happens there, not in the UI.
    function toDocName(raw) {
        let n = sanitizeName((raw || '').trim());
        if (!n) n = 'untitled';
        if (!/\.sdoc$/i.test(n)) n += '.sdoc';
        return n;
    }

    // Show the editor with whatever content/media was just loaded into it. `clean`: the loaded
    // content has nothing to lose (opened from disk, or a fresh empty doc) — an import does.
    function openInEditor(clean) {
        showView('editor');
        clearSecretInputs();
        showFontFamily();
        showFontSize();
        pendingPassword = false;
        savedContent = clean ? Editor.serialize() : null;
        editRevision = 0;
        savedRevision = clean ? 0 : -1;
        setDirty(!clean || needsKdfUpgrade);
    }

    // Called after an open and on close: every entered word is overwritten, not merely hidden, and
    // the Open screen drops the file it was holding (SECUREDOC_OPEN_REDESIGN.md §5).
    function clearSecretInputs() {
        ['new-phrase', 'import-phrase', 'pw-old', 'pw-new'].forEach(function (id) {
            const field = $(id);
            field.value = '';
            field.dispatchEvent(new Event('input'));
        });
        showPick();
    }

    // ── file zones (open / import) ──
    // Choosing a file — in the picker, or by dropping it on the zone — acts at once. A file whose
    // attempt failed (a mistyped passphrase, say) stays held and named in the zone, so the quiet
    // button under it retries without picking the file again; with nothing held it opens the picker.
    // `act(file)` resolves to true once the file is in the editor. A File is already a Blob: it is
    // handed on as is, so decode / import reads the bytes once, and it stays readable after the
    // input is reset.
    function hasFiles(e) {
        return !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1;
    }
    function fileZone(inputId, buttonId, act) {
        const input = $(inputId);
        const zone = document.querySelector('.drop-zone[for="' + inputId + '"]');
        const name = zone.querySelector('.drop-title');
        const idleName = name.textContent;
        const ext = input.accept; // a single extension, e.g. ".sdoc"
        let held = null;

        async function run(file) {
            held = file;
            name.textContent = file.name;
            if (await act(file)) {
                held = null;
                name.textContent = idleName;
            }
        }
        input.addEventListener('change', function () {
            const file = input.files[0];
            input.value = ''; // reset so picking the same file again re-fires change
            if (file) run(file);
        });
        $(buttonId).addEventListener('click', function () {
            if (held) run(held); else input.click();
        });

        function over(e) {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = input.disabled ? 'none' : 'copy';
            zone.classList.toggle('drag-over', !input.disabled);
        }
        zone.addEventListener('dragenter', over);
        zone.addEventListener('dragover', over);
        zone.addEventListener('dragleave', function (e) {
            if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
        });
        zone.addEventListener('drop', function (e) {
            if (!hasFiles(e)) return;
            e.preventDefault();
            zone.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (!file || input.disabled) return;
            if (file.name.slice(-ext.length).toLowerCase() !== ext) {
                return setupError('That is not a ' + ext + ' file.');
            }
            run(file);
        });
    }
    // On the Open screen a .sdoc may be dropped anywhere in the window, not only on the zone; the
    // zone lights up wherever the pointer is. Elsewhere a file dropped beside a zone would be
    // opened or downloaded by the browser, leaving the page, so the drop is refused outright.
    function openDropArmed() {
        return !$('setup-view').hidden && !$('tab-open').hidden
            && !$('open-pick').hidden && !$('open-file').disabled;
    }
    document.addEventListener('dragover', function (e) {
        if ($('setup-view').hidden || e.defaultPrevented || !hasFiles(e)) return;
        e.preventDefault();
        const armed = openDropArmed();
        e.dataTransfer.dropEffect = armed ? 'copy' : 'none';
        $('open-drop').classList.toggle('drag-over', armed);
    });
    document.addEventListener('dragleave', function (e) {
        if (!e.relatedTarget) $('open-drop').classList.remove('drag-over'); // left the window
    });
    document.addEventListener('drop', function (e) {
        if ($('setup-view').hidden || e.defaultPrevented || !hasFiles(e)) return;
        e.preventDefault();
        $('open-drop').classList.remove('drag-over');
        if (!openDropArmed()) return;
        const file = e.dataTransfer.files[0];
        if (file) chooseOpenFile(file);
    });

    // ── open: the browser reads the .sdoc and decrypts it locally (sdoc.js) ──
    // The file comes first (SECUREDOC_OPEN_REDESIGN.md §2): an unprotected document opens the moment
    // it is picked, and only a protected one asks for its twelve words. A browser <input type=file>
    // (or a drop) hides the on-disk path, so the opened doc has no linked path yet; the first Save
    // asks where (native Save dialog) once, then writes there silently.
    //
    // Nothing about the file is remembered: `heldFile` is a File object in memory, dropped on Change,
    // on a successful open and when the editor closes. No name, path or size is written to any store,
    // and no name, word or prefix is ever logged.
    let heldFile = null;
    let noteKind = null;

    function openMsgHome() {
        const slot = $('open-unlock').hidden ? $('open-pick-msg') : $('open-unlock-msg');
        slot.append($('setup-busy'), $('setup-error'));
    }

    /** The plaque under the grid: 'error' (red) or 'ok' (green). */
    function openNote(msg, kind) {
        const n = $('phrase-note');
        n.classList.remove('note-error', 'note-ok');
        if (!msg) {
            noteKind = null;
            n.textContent = '';
            n.hidden = true;
            return;
        }
        noteKind = kind === 'ok' ? 'ok' : 'error';
        n.textContent = msg;
        n.classList.add(noteKind === 'ok' ? 'note-ok' : 'note-error');
        n.hidden = false;
    }

    // The words are typed in the same field the other tabs use — one textarea with the live n/12
    // counter and the twelve bars (wired above, with every .phrase-field). This reads it.
    const WORDS = new Set(window.BIP39);
    function phraseState() {
        const words = Passphrase.canonical($('open-phrase').value);
        const list = words ? words.split(' ') : [];
        let bad = -1;
        for (let i = 0; i < list.length; i++) {
            if (!WORDS.has(list[i])) { bad = i; break; }
        }
        return { words: list, phrase: words, bad: bad, complete: list.length === 12 && bad < 0 };
    }

    // The plaque and the button label follow the field: how many words are in it, whether they are
    // all in the list, and which one is not.
    function refreshUnlock() {
        const s = phraseState();
        const btn = $('open-btn');
        const icon = btn.querySelector('.unlock-icon');
        btn.disabled = busyNow || !s.complete;
        // An <svg> is not an HTMLElement: `.hidden = false` would only set a JS property.
        icon.toggleAttribute('hidden', !s.complete);
        if (s.complete) {
            $('open-btn-label').textContent = 'Unlock & open';
            // A failed attempt keeps its message: every word is in the list, the phrase still is not.
            if (noteKind !== 'error') openNote('All 12 words are in the word list', 'ok');
            return;
        }
        const left = 12 - s.words.length;
        $('open-btn-label').textContent = s.bad >= 0
            ? 'Fix word ' + (s.bad + 1)
            : left > 0
                ? 'Enter ' + left + ' more word' + (left === 1 ? '' : 's')
                : 'Remove ' + (-left) + ' word' + (left === -1 ? '' : 's');
        if (noteKind === 'ok') openNote(null);
    }

    function formatSize(bytes) {
        if (!Number.isFinite(bytes)) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // The words are dots until Show is pressed, and that lasts only for the file being opened
    // (SECUREDOC_OPEN_REDESIGN.md §5).
    function setPhraseShown(on) {
        const b = $('phrase-show');
        $('open-phrase').classList.toggle('masked', !on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.textContent = on ? 'Hide' : 'Show';
    }

    // Overwrite the words, don't just hide them (SECUREDOC_OPEN_REDESIGN.md §5).
    function clearPhrase() {
        const field = $('open-phrase');
        field.value = '';
        field.dispatchEvent(new Event('input')); // counter, bars and button follow
        setPhraseShown(false);
        openNote(null);
    }

    /** Back to step 1, with everything entered wiped — also the whole screen's reset. */
    function showPick() {
        heldFile = null;
        clearPhrase();
        $('open-file-name').textContent = '';
        $('open-file-meta').textContent = '';
        $('open-unlock').hidden = true;
        $('open-pick').hidden = false;
        openMsgHome();
        setupError(null);
    }

    function showUnlock(file) {
        clearPhrase();
        $('open-file-name').textContent = file.name;
        $('open-file-meta').textContent = formatSize(file.size) + ' · Encrypted with a passphrase';
        $('open-pick').hidden = true;
        $('open-unlock').hidden = false;
        openMsgHome();
        setupError(null);
        refreshUnlock();
        $('open-phrase').focus();
    }

    function installOpened(doc, file, phrase) {
        passphrase = phrase;
        secretVersion++;
        title = doc.title || file.name.replace(/\.sdoc$/i, '');
        createdAt = doc.createdAt || null;
        needsKdfUpgrade = !!doc.needsKdfUpgrade;
        docName = toDocName(file.name);
        fileHandle = null; // <input type=file> gives no writable handle: first save asks where
        setSaveOptionsAvailable(true);
        Sdoc.prepare(phrase);
        loadMedia(doc.media);
        Editor.load(doc.content);
        openInEditor(true);          // also wipes the words and returns the screen to step 1
        Editor.restoreCaret(doc.caret); // back where the caret was at the last save
        status(needsKdfUpgrade
            ? 'Opened — weak legacy encryption settings; save to upgrade them'
            : 'Opened');
    }

    /** -> 'opened' | 'locked' (the file needs a passphrase, or this one is wrong) | 'failed' */
    async function tryOpen(file, phrase) {
        try {
            setBusy(phrase ? 'Decrypting the document…' : 'Opening the document…');
            // Same freeze as a save when there is no worker: decrypting derives the key too.
            await showBusy(
                phrase ? 'Decrypting the document…' : 'Opening the document…',
                phrase
                    ? 'Deriving the key from your passphrase. This can take a couple of seconds.'
                    : 'Reading the file.'
            );
            const doc = await Sdoc.decode(file, phrase);
            installOpened(doc, file, phrase);
            return 'opened';
        } catch (e) {
            if (e && e.code === 'wrong_password') return 'locked';
            // Only what the file itself is wrong about, and only on screen — never in a log.
            const why = 'Could not open this file: ' + ((e && e.message) || 'unknown error') + '.';
            if ($('open-unlock').hidden) setupError(why); else openNote(why, 'error');
            return 'failed';
        } finally {
            setBusy(null);
            hideBusy();
        }
    }

    // Step 1 → step 2. Reading an encrypted file's header costs nothing: decode reports
    // 'wrong_password' from the header alone, before any key is derived.
    async function chooseOpenFile(file) {
        setupError(null);
        openNote(null);
        if (!/\.sdoc$/i.test(file.name)) {
            setupError('That is not a .sdoc file.');
            return;
        }
        if (await tryOpen(file, '') === 'locked') {
            heldFile = file;
            showUnlock(file);
        }
    }

    async function unlockHeld() {
        const s = phraseState();
        if (!heldFile || busyNow || !s.complete) return;
        const result = await tryOpen(heldFile, s.phrase);
        if (result !== 'locked') return;
        // Which of the twelve is wrong is not knowable — not by us either. The words stay, so a
        // single mistyped one can be corrected without typing the phrase again.
        openNote('That passphrase doesn’t open this file. Check the words and try again.', 'error');
        $('open-phrase').focus();
    }

    $('open-file').addEventListener('change', function () {
        const input = $('open-file');
        const file = input.files[0];
        input.value = ''; // reset so picking the same file again re-fires change
        if (file) chooseOpenFile(file);
    });
    $('open-change').addEventListener('click', showPick);
    $('open-btn').addEventListener('click', unlockHeld);
    // Typing clears whatever the last attempt said; the word that is not in the list is named once
    // the field is left, not on every letter.
    $('open-phrase').addEventListener('input', function () {
        if (noteKind === 'error') openNote(null);
        refreshUnlock();
    });
    $('open-phrase').addEventListener('blur', function () {
        const s = phraseState();
        if (s.bad >= 0) {
            openNote('Word ' + (s.bad + 1) + ' “' + s.words[s.bad] + '” isn’t in the word list.',
                'error');
        }
    });
    $('phrase-show').addEventListener('click', function () {
        setPhraseShown(this.getAttribute('aria-pressed') !== 'true');
    });
    // Enter opens; Shift+Enter still breaks the line.
    $('open-phrase').addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        unlockHeld();
    });

    // ── create: a fresh empty document, entirely in the browser (no server call) ──
    $('create-btn').addEventListener('click', function () {
        setupError(null);
        const t = $('new-title').value.trim() || 'New document';
        const phrase = Passphrase.canonical($('new-phrase').value);
        const bad = Passphrase.validate(phrase);
        if (bad) return setupError(bad);
        passphrase = phrase;
        secretVersion++;
        title = t;
        createdAt = null;
        needsKdfUpgrade = false;
        docName = toDocName(t);
        fileHandle = null;
        setSaveOptionsAvailable(false);
        Sdoc.prepare(phrase);
        Editor.clearMedia();
        Editor.load('<p><br></p>');
        openInEditor(true);
        status('Created — save it to write the file to disk');
    });

    // ── import: parse a DOCX into content+media (password entered above is used on save) ──
    async function importDocx(file) {
        setupError(null);
        const phrase = Passphrase.canonical($('import-phrase').value);
        const bad = Passphrase.validate(phrase);
        if (bad) {
            setupError(bad);
            return false;
        }
        try {
            setBusy('Importing the document…');
            await showBusy('Importing the document…',
                'Reading the .docx and converting it. A large file with images takes a moment.');
            const doc = await Importer.importFile(file, file.name);
            passphrase = phrase;
            secretVersion++;
            title = doc.title || file.name.replace(/\.[^.]+$/, '');
            createdAt = null;
            needsKdfUpgrade = false;
            docName = toDocName(title);
            fileHandle = null;
            setSaveOptionsAvailable(false);
            Sdoc.prepare(phrase);
            loadMedia(doc.media);
            Editor.load(doc.content);
            openInEditor(false);
            status('Imported — save the file');
            return true;
        } catch (e) {
            setupError('Could not import: ' + (e.message || e));
            return false;
        } finally {
            setBusy(null);
            hideBusy();
        }
    }
    fileZone('import-file', 'import-btn', importDocx);

    // ── toolbar ──
    document.querySelectorAll('.toolbar [data-cmd]').forEach(function (b) {
        b.addEventListener('mousedown', function (e) {
            e.preventDefault();
            Editor.exec(b.dataset.cmd);
            markDirty();
        });
    });

    // mousedown + preventDefault so the click never steals the selection we are about to strip
    function clearFormat() {
        if (Editor.clearFormat()) markDirty();
        else status('Select text to clear its formatting');
    }
    $('clear-fmt').addEventListener('mousedown', function (e) {
        e.preventDefault();
        clearFormat();
    });

    // ── hyperlinks ──
    // Keep the editor selection while the dialog owns focus. Ctrl+K follows the convention used by
    // browsers and document editors; at a collapsed caret it edits the surrounding link.
    const linkDlg = $('link-dialog');
    const linkUrl = $('link-url');
    function linkError(msg) {
        const box = $('link-error');
        box.textContent = msg || '';
        box.hidden = !msg;
    }
    function openLinkDialog() {
        const info = Editor.linkInfo();
        if (!info) {
            status('Select text to add a link');
            return;
        }
        linkError(null);
        linkDlg.querySelector('h3').textContent = info.existing ? 'Edit link' : 'Add link';
        linkUrl.value = info.href;
        $('link-remove').hidden = !info.existing;
        linkDlg.showModal();
        linkUrl.focus();
        linkUrl.select();
    }
    function applyLink() {
        if (!Editor.normalizeLinkUrl(linkUrl.value)) {
            linkError('Enter a valid web address, email address, or telephone link.');
            linkUrl.focus();
            return;
        }
        // A modal dialog makes the editor inert. Close it before createLink runs, or Chromium
        // reports success without changing the selected text.
        linkDlg.close();
        if (!Editor.setLink(linkUrl.value)) {
            status('The selected text is no longer available');
            return;
        }
        markDirty();
        status('Link applied');
    }
    $('link-btn').addEventListener('mousedown', function (e) { e.preventDefault(); });
    $('link-btn').addEventListener('click', openLinkDialog);
    $('link-cancel').addEventListener('click', function () { linkDlg.close(); Editor.focus(); });
    $('link-apply').addEventListener('click', applyLink);
    $('link-remove').addEventListener('click', function () {
        linkDlg.close();
        if (Editor.removeLink()) {
            markDirty();
            status('Link removed');
        }
    });
    linkUrl.addEventListener('input', function () { linkError(null); });
    linkUrl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
    });

    // A link inside contenteditable must not navigate by accident while it is being edited.
    // Ctrl/Cmd+click first shows the normalized destination and opens it only after confirmation.
    const openLinkDlg = $('open-link-dialog');
    let pendingLinkDestination = null;
    $('editor').addEventListener('click', function (e) {
        if (!e.ctrlKey && !e.metaKey) return;
        const link = e.target.closest && e.target.closest('a');
        if (!link || !$('editor').contains(link)) return;
        e.preventDefault();
        e.stopPropagation();
        const destination = Editor.normalizeLinkUrl(link.getAttribute('href'));
        if (!destination) return;
        pendingLinkDestination = destination;
        $('open-link-url').textContent = destination;
        openLinkDlg.showModal();
        $('open-link-confirm').focus();
    });
    $('open-link-cancel').addEventListener('click', function () { openLinkDlg.close('cancel'); });
    $('open-link-confirm').addEventListener('click', function () {
        const destination = pendingLinkDestination;
        openLinkDlg.close();
        if (!destination) return;
        const opened = window.open(destination, '_blank', 'noopener,noreferrer');
        if (!opened) status('The browser blocked the new tab');
    });
    openLinkDlg.addEventListener('close', function () {
        pendingLinkDestination = null;
        Editor.focus();
    });

    // ── font family and size ──
    // Clicking the <select> takes focus out of the editor; Editor keeps the last range for exactly
    // this reason, so the size lands on the text that was selected, not at the top of the document.
    // The families the picker offers, first one being what the page itself sets on .editor. Text
    // styled through this picker carries its own font-family, which outranks the page's: that is
    // why a family has to be listed here before it can be seen in a document that uses the picker.
    const DOC_FAMILIES = ['Amstelvar', 'Roboto Flex', 'Roboto Serif'];
    const fontFamilySel = $('font-family');
    fontFamilySel.addEventListener('change', function () {
        const family = fontFamilySel.value;
        if (DOC_FAMILIES.indexOf(family) === -1) return;
        Editor.focus();
        // fontName normally produces the deprecated <font face="…"> in Chromium. Ask it for CSS
        // just for this operation, then restore semantic-tag mode used by the other toolbar tools.
        document.execCommand('styleWithCSS', false, true);
        document.execCommand('fontName', false, family);
        document.execCommand('styleWithCSS', false, false);
        $('editor').dispatchEvent(new Event('input', { bubbles: true }));
        markDirty();
    });

    // Which of the offered families an element ends up in. Anything unrecognised counts as the
    // first one, which is what the page itself sets.
    function familyOf(node) {
        const el = node && node.nodeType === 3 ? node.parentNode : node;
        if (!el || !$('editor').contains(el)) { return DOC_FAMILIES[0]; }
        const shown = window.getComputedStyle(el).fontFamily.toLowerCase();
        return DOC_FAMILIES.filter(function (f) {
            return shown.indexOf(f.toLowerCase()) !== -1;
        })[0] || DOC_FAMILIES[0];
    }

    // Every family the selection touches, not just the one it starts in. A selection spanning two
    // fonts must leave the picker showing neither of them: it would otherwise display the font at
    // the start, and picking that same entry changes no <select> value, so the browser fires no
    // `change` event and the command never runs — the selection silently keeps both fonts.
    function familiesInSelection() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) { return [DOC_FAMILIES[0]]; }
        const range = sel.getRangeAt(0);
        if (range.collapsed) {
            let at = range.startContainer;
            if (at.nodeType === 1) { at = at.childNodes[range.startOffset] || at; }
            return [familyOf(at)];
        }
        const found = [];
        const walker = document.createTreeWalker($('editor'), NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
            const text = walker.currentNode;
            if (!text.nodeValue || !text.nodeValue.trim()) { continue; }
            if (!sel.containsNode(text, true)) { continue; }
            const family = familyOf(text);
            if (found.indexOf(family) === -1) { found.push(family); }
        }
        return found.length ? found : [DOC_FAMILIES[0]];
    }

    function showFontFamily() {
        if ($('editor-view').hidden) return;
        const families = familiesInSelection();
        fontFamilySel.value = families.length === 1 ? families[0] : ''; // '' = the "Mixed" entry
    }

    const fontSizeSel = $('font-size');
    fontSizeSel.addEventListener('change', function () {
        const pt = parseFloat(fontSizeSel.value);
        if (!pt) return;
        Editor.setFontSize(pt);
        markDirty();
    });

    // Reflect the size at the caret, the way Word's box follows the cursor. A document can carry
    // sizes that aren't in the list (imported, or a heading), so show those in a slot of their own
    // instead of leaving the box blank.
    function showFontSize() {
        if ($('editor-view').hidden) return;
        const pt = Editor.fontSizeAt();
        const v = pt == null ? '' : String(pt);
        if (v && !Array.prototype.some.call(fontSizeSel.options, function (o) { return o.value === v; })) {
            let custom = fontSizeSel.querySelector('option[data-custom]');
            if (!custom) {
                custom = document.createElement('option');
                custom.dataset.custom = '1';
                fontSizeSel.insertBefore(custom, fontSizeSel.firstChild);
            }
            custom.value = v;
            custom.textContent = v;
        }
        fontSizeSel.value = v;
    }

    // Ctrl+] / Ctrl+[ — step through the list, like Word. Keyed off e.code so other keyboard
    // layouts (e.g. Russian, where these physical keys type other letters) work too.
    function stepFontSize(up) {
        const sizes = Array.prototype.map.call(fontSizeSel.options, function (o) {
            return parseFloat(o.value);
        }).filter(function (n) { return !!n; }).sort(function (a, b) { return a - b; });
        const cur = Editor.fontSizeAt();
        if (cur == null) return;
        let next = null;
        if (up) {
            for (let i = 0; i < sizes.length; i++) { if (sizes[i] > cur) { next = sizes[i]; break; } }
        } else {
            for (let i = sizes.length - 1; i >= 0; i--) { if (sizes[i] < cur) { next = sizes[i]; break; } }
        }
        if (next == null) return; // already at the end of the list
        Editor.setFontSize(next);
        markDirty();
        showFontSize();
    }

    // table insert via a hover grid picker
    (function setupTablePicker() {
        const picker = $('table-picker');
        const grid = $('table-grid');
        const label = $('table-grid-label');
        const MAXR = 8, MAXC = 8;
        grid.style.gridTemplateColumns = 'repeat(' + MAXC + ', 16px)';
        for (let r = 1; r <= MAXR; r++) {
            for (let c = 1; c <= MAXC; c++) {
                const cell = document.createElement('div');
                cell.className = 'tg-cell';
                cell.dataset.r = r;
                cell.dataset.c = c;
                cell.addEventListener('mouseenter', function () { highlight(r, c); });
                cell.addEventListener('click', function () {
                    picker.hidden = true;
                    Editor.insertTable(r, c);
                    markDirty();
                });
                grid.appendChild(cell);
            }
        }
        function highlight(r, c) {
            [].forEach.call(grid.children, function (el) {
                el.classList.toggle('on', (+el.dataset.r <= r) && (+el.dataset.c <= c));
            });
            label.textContent = r + ' × ' + c;
        }
        // mousedown + preventDefault so opening the picker (and picking a size in it) never blurs
        // the editor — the table has to land at the caret, not at the top of the document.
        $('tbl-btn').addEventListener('mousedown', function (e) { e.preventDefault(); });
        picker.addEventListener('mousedown', function (e) { e.preventDefault(); });
        $('tbl-btn').addEventListener('click', function (e) {
            e.stopPropagation();
            if (picker.hidden) {
                const rect = $('tbl-btn').getBoundingClientRect();
                picker.style.left = rect.left + 'px';
                picker.style.top = (rect.bottom + 4) + 'px';
                picker.hidden = false;
                highlight(0, 0);
            } else {
                picker.hidden = true;
            }
        });
        document.addEventListener('click', function (e) {
            if (!picker.hidden && !picker.contains(e.target) && e.target !== $('tbl-btn')) {
                picker.hidden = true;
            }
        });
    })();

    // table row/column controls. While the fill picker is open its inputs hold focus, so the caret
    // is no longer in a cell — keep the group (and the fill button under the popover) visible anyway.
    function updateTableOps() {
        const filling = !$('fill-picker').hidden;
        const radiusFocused = $('table-radius') === document.activeElement;
        $('table-ops').hidden = $('editor-view').hidden || (!filling && !radiusFocused && !Editor.inTable());
        if (!filling && !radiusFocused) {
            showFillSwatch(Editor.cellColorAt());
            $('table-radius').value = Editor.tableRadiusAt();
        }
    }
    function showFillSwatch(css) { $('fill-swatch').style.background = css || 'transparent'; }

    // selectionchange fires on every keystroke and every mouse move of a drag, and both toolbar
    // updates read computed styles (a forced style recalc on a big document). Coalesce them into
    // one pass per frame.
    let toolbarFrame = 0;
    document.addEventListener('selectionchange', function () {
        if (toolbarFrame) return;
        toolbarFrame = requestAnimationFrame(function () {
            toolbarFrame = 0;
            showFontFamily();
            showFontSize();
            updateTableOps();
        });
    });
    function tblOp(id, fn) {
        $(id).addEventListener('mousedown', function (e) {
            e.preventDefault();
            fn();
            markDirty();
            updateTableOps();
        });
    }
    tblOp('row-add', function () { Editor.addRow(true); });
    tblOp('row-del', function () { Editor.deleteRow(); });
    tblOp('col-add', function () { Editor.addColumn(true); });
    tblOp('col-del', function () { Editor.deleteColumn(); });
    $('table-radius').addEventListener('change', function () {
        if (!Editor.setTableRadius(this.value)) return;
        this.value = Editor.tableRadiusAt();
        markDirty();
        updateTableOps();
    });
    $('table-radius').addEventListener('blur', updateTableOps);

    // ── cell fill colour ──
    // A palette for the quick picks, plus a saturation/brightness square, a hue strip, HEX and R/G/B
    // fields (arrow keys step by 1) for exact colours. Changes apply to the cells live. The target
    // cells are captured when the picker opens: its inputs take focus, so the caret leaves the table.
    (function setupCellFill() {
        const picker = $('fill-picker');
        const btn = $('cell-fill');
        const sv = $('fp-sv'), svKnob = $('fp-sv-knob');
        const hue = $('fp-hue'), hueKnob = $('fp-hue-knob');
        const hexIn = $('fp-hex'), native = $('fp-native'), preview = $('fp-preview');
        const rgbIn = [$('fp-r'), $('fp-g'), $('fp-b')];
        const RECENT_KEY = 'securedoc.recentFills';
        const RECENT_MAX = 10;

        let cells = [];
        let hsv = { h: 210, s: 0, v: 1 };
        let applied;        // colour written during this opening: hex, null (fill removed), undefined (nothing)

        // ── colour maths (h in degrees, s/v/l in 0..1, rgb in 0..255) ──
        function hsvToRgb(h, s, v) {
            const f = function (n) {
                const k = (n + h / 60) % 6;
                return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
            };
            return [f(5), f(3), f(1)].map(function (x) { return Math.round(x * 255); });
        }
        function hslToRgb(h, s, l) {
            const a = s * Math.min(l, 1 - l);
            const f = function (n) {
                const k = (n + h / 30) % 12;
                return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
            };
            return [f(0), f(8), f(4)].map(function (x) { return Math.round(x * 255); });
        }
        function rgbToHsv(rgb) {
            const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
            const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
            let h = 0;
            if (d) {
                if (max === r) h = ((g - b) / d) % 6;
                else if (max === g) h = (b - r) / d + 2;
                else h = (r - g) / d + 4;
                h *= 60;
                if (h < 0) h += 360;
            }
            return { h: h, s: max ? d / max : 0, v: max };
        }
        function toHex(rgb) {
            return '#' + rgb.map(function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
        }
        function parseHex(s) {
            s = (s || '').trim().replace(/^#/, '');
            if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, '$&$&');
            if (!/^[0-9a-f]{6}$/i.test(s)) return null;
            return [0, 2, 4].map(function (i) { return parseInt(s.substr(i, 2), 16); });
        }
        function parseCssRgb(css) {
            const m = css && css.match(/[\d.]+/g);
            if (!m || m.length < 3 || (m.length > 3 && parseFloat(m[3]) === 0)) return null;
            return m.slice(0, 3).map(function (x) { return Math.round(parseFloat(x)); });
        }
        function clamp01(x) { return Math.max(0, Math.min(1, x)); }

        // Move the picker to a colour without losing the hue on greys (where it is undefined) —
        // otherwise dragging to the white/black edge would snap the hue strip back to red.
        function setRgb(rgb) {
            const n = rgbToHsv(rgb);
            if (n.s === 0 || n.v === 0) n.h = hsv.h;
            if (n.v === 0) n.s = hsv.s;
            hsv = n;
        }

        // ── palette: greys + nine hues, from pale tints (the usual table fills) down to dark shades ──
        const HUES = [0, 25, 48, 90, 140, 180, 210, 240, 280];
        const LIGHT = [0.96, 0.9, 0.8, 0.68, 0.52, 0.36];
        const GREY = [1, 0.95, 0.85, 0.7, 0.5, 0.3];
        const PALETTE = [];
        LIGHT.forEach(function (l, row) {
            PALETTE.push(toHex(hslToRgb(0, 0, GREY[row])));
            HUES.forEach(function (h) { PALETTE.push(toHex(hslToRgb(h, 0.75, l))); });
        });
        function chip(hex) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'fp-chip';
            b.style.background = hex;
            b.title = hex;
            b.dataset.hex = hex;
            b.addEventListener('click', function () {
                setRgb(parseHex(hex));
                apply();
                close();
            });
            return b;
        }
        PALETTE.forEach(function (hex) { $('fp-palette').appendChild(chip(hex)); });

        function loadRecent() {
            try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (e) { return []; }
        }
        function pushRecent(hex) {
            const list = [hex].concat(loadRecent().filter(function (x) { return x !== hex; }))
                .slice(0, RECENT_MAX);
            try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* not kept */ }
        }
        function renderRecent() {
            const list = loadRecent();
            const box = $('fp-recent');
            box.textContent = '';
            list.forEach(function (hex) { box.appendChild(chip(hex)); });
            $('fp-recent-wrap').hidden = !list.length;
        }

        // Redraw every control from hsv; `from` is the control being typed in, left alone so the
        // caret doesn't jump while the user is mid-edit.
        function render(from) {
            const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
            const hex = toHex(rgb);
            sv.style.backgroundColor = 'hsl(' + hsv.h + ', 100%, 50%)';
            svKnob.style.left = (hsv.s * 100) + '%';
            svKnob.style.top = ((1 - hsv.v) * 100) + '%';
            hueKnob.style.left = (hsv.h / 360 * 100) + '%';
            preview.style.background = hex;
            if (from !== 'hex') hexIn.value = hex;
            if (from !== 'rgb') rgbIn.forEach(function (inp, i) { inp.value = rgb[i]; });
            if (from !== 'native') native.value = hex;
            picker.querySelectorAll('.fp-chip').forEach(function (c) {
                c.classList.toggle('current', c.dataset.hex === hex);
            });
            return hex;
        }
        function apply(from) {
            const hex = render(from);
            Editor.setCellColor(cells, hex);
            applied = hex;
            showFillSwatch(hex);
        }

        // Pointer drag on the square / strip; x, y come back as fractions of the element's box.
        function drag(area, onMove) {
            area.addEventListener('pointerdown', function (e) {
                area.setPointerCapture(e.pointerId);
                const move = function (ev) {
                    const r = area.getBoundingClientRect();
                    onMove(clamp01((ev.clientX - r.left) / r.width), clamp01((ev.clientY - r.top) / r.height));
                    apply();
                };
                const up = function () {
                    area.removeEventListener('pointermove', move);
                    area.removeEventListener('pointerup', up);
                    area.removeEventListener('pointercancel', up);
                };
                move(e);
                area.addEventListener('pointermove', move);
                area.addEventListener('pointerup', up);
                area.addEventListener('pointercancel', up);
            });
        }
        drag(sv, function (x, y) { hsv.s = x; hsv.v = 1 - y; });
        drag(hue, function (x) { hsv.h = Math.min(359.9, x * 360); });

        hexIn.addEventListener('input', function () {
            const rgb = parseHex(hexIn.value);
            if (rgb) { setRgb(rgb); apply('hex'); }
        });
        hexIn.addEventListener('blur', function () { if (applied) render(); }); // tidy a half-typed value
        rgbIn.forEach(function (inp) {
            inp.addEventListener('input', function () {
                const rgb = rgbIn.map(function (x) {
                    const n = parseInt(x.value, 10);
                    return isNaN(n) ? 0 : Math.max(0, Math.min(255, n));
                });
                setRgb(rgb);
                apply('rgb');
            });
        });
        native.addEventListener('input', function () {
            setRgb(parseHex(native.value));
            apply('native');
        });

        function open() {
            cells = Editor.selectedCells();
            if (!cells.length) { status('Put the caret in a table cell'); return; }
            applied = undefined;
            const rgb = parseCssRgb(Editor.cellColor(cells[0]));
            if (rgb) setRgb(rgb);
            renderRecent();
            render();
            if (!rgb) { // no fill yet: don't pretend the cell is white
                hexIn.value = '';
                picker.querySelectorAll('.fp-chip.current').forEach(function (c) { c.classList.remove('current'); });
            }
            picker.hidden = false;
            // Keep it on screen: pinned under the button, scrolling inside itself in a short window.
            const rect = btn.getBoundingClientRect();
            const top = Math.max(8, rect.bottom + 4);
            picker.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - picker.offsetWidth - 8)) + 'px';
            picker.style.top = top + 'px';
            picker.style.maxHeight = Math.max(160, window.innerHeight - top - 8) + 'px';
        }
        function close() {
            if (picker.hidden) return;
            if (applied) pushRecent(applied);
            const hadFocus = picker.contains(document.activeElement);
            picker.hidden = true;
            cells = [];
            if (hadFocus) Editor.focus(); // back to where the user was typing
            updateTableOps();
        }

        // Don't let clicks on the popover's chrome take the selection out of the editor; its
        // text/number inputs still need a real mousedown to take focus.
        picker.addEventListener('mousedown', function (e) {
            if (!e.target.closest('input')) e.preventDefault();
        });
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
        btn.addEventListener('click', function () { if (picker.hidden) open(); else close(); });
        $('fp-none').addEventListener('click', function () {
            Editor.setCellColor(cells, null);
            applied = null;
            close();
        });
        $('fp-done').addEventListener('click', close);
        hexIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') close(); });
        document.addEventListener('mousedown', function (e) {
            if (!picker.hidden && !picker.contains(e.target) && !btn.contains(e.target)) close();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !picker.hidden) { e.preventDefault(); close(); }
        });
    })();

    // ── background around the page ──
    // A view preference, not part of the document: kept in localStorage, never in the .sdoc.
    (function setupBackground() {
        const picker = $('bg-picker');
        const btn = $('bg-btn');
        const KEY = 'securedoc.background';
        const PATTERN_KEY = 'securedoc.backgroundPattern';
        const COLORS = { black: '#1e1e1e', navy: '#1c2b4a', darkgrey: '#66686d', grey: '#aaacb0',
            sepia: '#e9dcc3', white: '#ffffff' };
        const DARK = new Set(['black', 'navy', 'darkgrey']);
        const DEFAULT = 'darkgrey';
        // Each pattern is drawn in `ink` — a faint dark tone over light colours, a faint light one over
        // dark ones — on top of the chosen colour (`bg`, for the one that needs tones of its own).
        // `size` is the tile in px (null: the image tiles itself), `height` its height if not square,
        // `position` where the tiling is anchored if not at the top left.
        const PATTERNS = {
            none: function () { return { image: 'none', size: null }; },
            dots: function (ink) {
                return { image: 'radial-gradient(' + ink + ' 1.3px, transparent 1.8px)', size: 18 };
            },
            grid: function (ink) {
                return {
                    image: 'linear-gradient(' + ink + ' 1px, transparent 1px), linear-gradient(90deg, ' + ink + ' 1px, transparent 1px)',
                    size: 24
                };
            },
            lines: function (ink) {
                return { image: 'linear-gradient(' + ink + ' 1px, transparent 1px)', size: 22 };
            },
            diagonal: function (ink) {
                return { image: 'repeating-linear-gradient(45deg, ' + ink + ' 0 1px, transparent 1px 11px)', size: null };
            },
            waves: function (ink) {
                const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">'
                    + '<path d="M0 10 Q10 2 20 10 T40 10" fill="none" stroke="' + ink + '" stroke-width="1.2"/></svg>';
                return { image: 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")', size: 40 };
            },
            octagons: function (ink) {
                // Cutting each corner of a square leaves a regular octagon; four neighbouring
                // cuts form a square with the same edge length. The SVG repeats without gaps.
                const size = 64, cut = size / (2 + Math.sqrt(2)), far = size - cut;
                const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
                    + '<path d="M' + cut + ' 0H' + far + 'L64 ' + cut + 'V' + far
                    + 'L' + far + ' 64H' + cut + 'L0 ' + far + 'V' + cut + 'Z"'
                    + ' fill="none" stroke="' + ink + '" stroke-width="1.2"/></svg>';
                return { image: 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")', size: size };
            },
            voronoi: function (ink) {
                // Wider SVG edges need softer ink to visually approach the rasterized Penrose lines.
                const edgeInk = inkTimes(ink, 1.2);
                const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480">'
                    + '<path d="' + voronoiPath() + '" fill="none" stroke="' + edgeInk
                    + '" stroke-width="2" stroke-linejoin="round"/></svg>';
                return { image: 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")', size: 480 };
            },
            // Truchet: square tiles of 2 × 2 cells, each half inked and half bare — the inked half on
            // top, right, bottom or left. Which one follows the diagonals: every rising diagonal of
            // tiles (↗) carries a coin toss between upper right and lower left, every falling one (↘)
            // between upper left and lower right, and a tile inks the side both point to. The halves
            // join into a labyrinth of both tones, one cell wide, turning at every other step, with
            // squares nested in rings wherever four tiles face one corner.
            truchet: function (ink) {
                const n = 2 * TRUCHET.tiles, s = TRUCHET.cell;
                const body = '<path transform="scale(' + s + ')" d="' + truchetPath() + '" fill="'
                    + inkTimes(ink, TRUCHET.ink) + '"/>';
                return { image: svgTile(n * s, n * s, body), size: n * s };
            },
            penrose: function (ink) {
                const tiling = penroseImage(ink, PENROSE_FILLS);
                return tiling ? { image: 'url("' + tiling.url + '")', size: tiling.size } : { image: 'none', size: null };
            },
            // Animated: the same tiling as `penrose`, cross-fading with the copy that gives each kind
            // of rhombus the other's tone, so the two greys trade places — the light ones darken while
            // the dark ones lighten. The dividing lines are dark on every background (see lineVeil),
            // so they stand clear of both fills at every phase. `swap` is the second image; the
            // cross-fade itself is CSS (.bg-layer), see paint().
            'penrose-swap': function (ink, bg) {
                const veil = lineVeil(bg);
                const a = penroseImage(ink, SWAP_FILLS, veil);
                const b = penroseImage(ink, [SWAP_FILLS[1], SWAP_FILLS[0]], veil);
                if (!a || !b) return { image: 'none', size: null };
                return { image: 'url("' + a.url + '")', swap: 'url("' + b.url + '")', size: a.size };
            },

            // ── Illusions: drawings the eye does not take as they are ──
            // Reversible cubes: a rhombille tiling in three tones reads as a stack of cubes that keeps
            // turning over by itself — seen from above one moment, from below (or as hollow corners)
            // the next. Nothing in the drawing changes; the eye cannot settle on one way up.
            cubes: function (ink) {
                return { image: svgTile(28, 48, cubeFaces(ink, CUBE_TONES)), size: 28, height: 48 };
            },
            // Zöllner: the long diagonals are exactly parallel, but every other one carries short
            // horizontal crossings and the rest vertical ones, and the lines seem to lean towards
            // and away from each other.
            zollner: function (ink) {
                return { image: svgTile(ZOLLNER.tile, ZOLLNER.tile, zollnerPath(inkTimes(ink, ZOLLNER.ink))), size: ZOLLNER.tile };
            },
            // Café wall: straight, parallel rows of tiles, every other row shifted by half a tile, and
            // the mortar lines between them look like wedges. The illusion lives on the contrast of
            // the tiles and on the mortar lying halfway between them — a faint ink tints the tiles
            // but kills the tilt — so the tiles are drawn as tones of their own, one lighter and one
            // darker than the background by the same step, with the mortar in the middle: the wall
            // is as strong as it has to be, and the background keeps its brightness on average.
            'cafe-wall': function (ink, bg) {
                const t = tonePair(bg, CAFE.step), w = CAFE.tile, m = CAFE.mortar;
                const body = '<rect width="' + (2 * w) + '" height="' + (2 * (w + m)) + '" fill="' + t.light + '"/>'
                    + '<path d="M0 0h' + w + 'v' + w + 'h-' + w + 'Z'
                    + 'M' + (w / 2) + ' ' + (w + m) + 'h' + w + 'v' + w + 'h-' + w + 'Z" fill="' + t.dark + '"/>'
                    + '<path d="M0 ' + w + 'h' + (2 * w) + 'v' + m + 'H0Z'
                    + 'M0 ' + (2 * w + m) + 'h' + (2 * w) + 'v' + m + 'H0Z" fill="' + t.mid + '"/>';
                return { image: svgTile(2 * w, 2 * (w + m), body), size: 2 * w, height: 2 * (w + m) };
            },
            // Kanizsa: four notched discs and a square between them that nobody drew — its edges
            // are seen running across the empty background. See KANIZSA for what makes them hold.
            kanizsa: function (ink) {
                const T = KANIZSA.tile;
                return { image: svgTile(T, 2 * T, kanizsaPath(inkTimes(ink, KANIZSA.ink))), size: T, height: 2 * T, position: 'center' };
            },

            // Animated: the cubes lit from the other side. The flat rhombi go from the lightest tone
            // to the darkest while the side faces shift down a step, and since the eye takes light as
            // coming from above, a dark flat face is a bottom: the cubes turn inside out and back.
            'cubes-flip': function (ink) {
                return {
                    image: svgTile(28, 48, cubeFaces(ink, CUBE_TONES)),
                    swap: svgTile(28, 48, cubeFaces(ink, [CUBE_TONES[2], CUBE_TONES[0], CUBE_TONES[1]])),
                    size: 28, height: 48
                };
            }
        };
        const DEFAULT_PATTERN = 'penrose';
        // The tone each kind of rhombus is filled with, [thick, thin], as a grey on white — darker
        // carries more ink, null leaves the rhombus at the background colour. The static pattern
        // tints the thick ones faintly and leaves the rest bare. The animated one gives both kinds
        // a tone of their own, far apart, because that is what trades places: a faint tint that
        // merely comes and goes measures ~10 levels of 255 and reads as a still background.
        const PENROSE_FILLS = ['#b3b3b3', null];
        // The animated pair: the deep tone at 81% of the ink, the pale one at 11%.
        const SWAP_FILLS = ['#303030', '#e4e4e4'];
        // How much darker than the background each line of the animated Penrose is, in levels of 255.
        // Over the fills a line comes out about that much darker than the rhombus beside it, too:
        // slightly less on light backgrounds (the fills are darker than the background), more on
        // dark ones (they are lighter).
        const SWAP_LINE_DROP = 36;
        // The cubes' faces in ink, [flat rhombi, left sides, right sides]: the flat ones bare, as tops
        // in the light; the sides one and two steps darker, as faces turned away from it.
        const CUBE_TONES = [0, 0.7, 1.4];
        // Diagonals half a tile apart (34 px across), a crossing every `spacing` px along x (17 along
        // the line), each reaching `reach` px either side of it. Denser ink and a heavier stroke than
        // the plain line patterns: antialiasing smears a thin diagonal far more than the crisp
        // horizontal and vertical crossings, and once the long lines stop reading as lines the
        // pattern is a scatter of dashes with no tilt to see.
        const ZOLLNER = { tile: 96, spacing: 12, reach: 12, ink: 2.2, width: 1.5 };
        // Square tiles, the mortar a tenth of their size: the tilt needs thin mortar and weakens as it
        // thickens. `step` is the light-to-dark span of the tiles in levels of 255 (see tonePair).
        const CAFE = { tile: 22, mortar: 2, step: 56 };
        // The missing square is only seen when the eye takes the four discs as one group, so the
        // squares stand far apart: `tile` from one to the next, over twice the side, with every other
        // row shifted by half so the empty lanes between them don't form a grid of their own. Packed
        // closer, into an even lattice of notched discs, the eye groups them as it likes and no square
        // wins. The discs give away 2 × radius / side = 0.625 of each edge: more makes the contour
        // stronger, but the four discs then close into one ring-like glyph. They are solid areas of
        // dense ink, as the contour lives on their contrast.
        const KANIZSA = { tile: 128, side: 48, radius: 15, ink: 2.5 };
        // `tiles` Truchet tiles a side before the pattern repeats, each 2 × 2 cells of `cell` px; the
        // inked half at `ink` times the ink.
        const TRUCHET = { tiles: 48, cell: 10, ink: 1 };
        let color = DEFAULT, pattern = DEFAULT_PATTERN;

        function ink(name) { return DARK.has(name) ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.11)'; }
        function inkTimes(inkCss, k) {
            return inkCss.replace(/,([\d.]+)\)$/, function (_, alpha) { return ',' + (Number(alpha) * k) + ')'; });
        }
        function svgTile(w, h, body) {
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h
                + '" viewBox="0 0 ' + w + ' ' + h + '">' + body + '</svg>';
            return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
        }

        // Rhombille tiling — hexagons each cut into three rhombi, rows offset by half — in a 28×48
        // tile. The hexagons are 28 wide and 32 tall, a hair wider than regular (27.7), so the tile
        // lands on whole pixels. One path per tone: faces of a kind never overlap at a shared edge.
        function cubeFaces(inkCss, tones) {
            const d = ['', '', ''];
            [[0, 0], [28, 0], [14, 24], [0, 48], [28, 48]].forEach(function (c) {
                const x = c[0], y = c[1];
                d[0] += 'M' + x + ' ' + (y - 16) + 'L' + (x + 14) + ' ' + (y - 8) + 'L' + x + ' ' + y + 'L' + (x - 14) + ' ' + (y - 8) + 'Z';
                d[1] += 'M' + (x - 14) + ' ' + (y - 8) + 'L' + x + ' ' + y + 'L' + x + ' ' + (y + 16) + 'L' + (x - 14) + ' ' + (y + 8) + 'Z';
                d[2] += 'M' + x + ' ' + y + 'L' + (x + 14) + ' ' + (y - 8) + 'L' + (x + 14) + ' ' + (y + 8) + 'L' + x + ' ' + (y + 16) + 'Z';
            });
            return d.map(function (path, i) {
                return tones[i] ? '<path d="' + path + '" fill="' + inkTimes(inkCss, tones[i]) + '"/>' : '';
            }).join('');
        }

        // Diagonals y = x + c at every half tile, those at whole tiles crossed by horizontal strokes
        // and the rest by vertical ones — 45° to the line either way, as the illusion is classically
        // drawn. Copies from the neighbouring tiles are drawn as well and clipped, so strokes crossing
        // the tile edge stay whole; one path, so a crossing isn't inked twice.
        function zollnerPath(stroke) {
            const T = ZOLLNER.tile, s = ZOLLNER.spacing, a = ZOLLNER.reach;
            let d = '';
            [-T, -T / 2, 0, T / 2, T].forEach(function (c) {
                const vertical = (c / (T / 2)) % 2 !== 0;
                d += 'M' + (-T) + ' ' + (c - T) + 'L' + (2 * T) + ' ' + (c + 2 * T);
                for (let x = (vertical ? s / 2 : 0) - s; x <= T + s; x += s) {
                    const y = x + c;
                    if (y < -a || y > T + a) continue;
                    d += vertical ? 'M' + x + ' ' + (y - a) + 'V' + (y + a) : 'M' + (x - a) + ' ' + y + 'H' + (x + a);
                }
            });
            return '<path d="' + d + '" fill="none" stroke="' + stroke + '" stroke-width="' + ZOLLNER.width + '"/>';
        }

        // Four discs at the corners of each square, each with the quarter that points into the square
        // cut away. The tile is one tile wide and two tall, with a square in its very middle (so a
        // centred swatch shows a whole one) and the rows above and below shifted by half, on its
        // corners — cut in four there and joined by the repeat.
        function kanizsaPath(fill) {
            const T = KANIZSA.tile, h = KANIZSA.side / 2, r = KANIZSA.radius;
            let d = '';
            [[T / 2, T], [0, 0], [T, 0], [0, 2 * T], [T, 2 * T]].forEach(function (o) {
                [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) {
                    const cx = o[0] + q[0] * h, cy = o[1] + q[1] * h, sx = -q[0], sy = -q[1];
                    d += 'M' + cx + ' ' + cy + 'L' + (cx + sx * r) + ' ' + cy
                        + 'A' + r + ' ' + r + ' 0 1 ' + (sx * sy > 0 ? 0 : 1) + ' ' + cx + ' ' + (cy + sy * r) + 'Z';
                });
            });
            return '<path d="' + d + '" fill="' + fill + '"/>';
        }

        // Two opaque tones `step` levels apart (by luma) on the given background: one lighter and one
        // darker than it by the same amount where there is room both ways, pushed off the end of the
        // scale where there isn't (white, and nearly so on black), plus the tone halfway between.
        function tonePair(bgHex, step) {
            const c = rgbOf(bgHex), luma = lumaOf(c);
            const down = Math.min(luma, Math.max(step / 2, step - (255 - luma)));
            const up = Math.min(255 - luma, step - down);
            const light = c.map(function (v) { return v + (255 - v) * up / (255 - luma || 1); });
            const dark = c.map(function (v) { return v * (1 - down / (luma || 1)); });
            const mid = light.map(function (v, i) { return (v + dark[i]) / 2; });
            function css(v) { return 'rgb(' + v.map(Math.round).join(',') + ')'; }
            return { light: css(light), dark: css(dark), mid: css(mid) };
        }
        function rgbOf(hex) { return [1, 3, 5].map(function (i) { return parseInt(hex.slice(i, i + 2), 16); }); }
        function lumaOf(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

        // The animated Penrose draws its lines in black, as a veil that takes SWAP_LINE_DROP levels off
        // the background's brightness (all there is, on black). A line in the background's own ink is
        // light on dark backgrounds, lighter than both fills, and next to the deep one it all but
        // vanishes; a line that turned over with its fill (pale on deep, deep on pale) would have to
        // pass through the fill's tone somewhere in the cross-fade and vanish for that moment. Darker
        // than the background, a line is darker than both fills on a dark background, whose fills are
        // lighter, and on a light one darker than the rhombus under it by a fixed share of it — clear
        // of both at every phase either way.
        function lineVeil(bgHex) {
            return Math.min(1, SWAP_LINE_DROP / (lumaOf(rgbOf(bgHex)) || 1));
        }

        // Periodic, deterministically jittered seeds give irregular Voronoi cells with seamless
        // tile boundaries. Cache the geometry; changing the background only changes the ink.
        let cachedVoronoiPath = null;
        function voronoiPath() {
            if (cachedVoronoiPath !== null) return cachedVoronoiPath;
            const count = 10, step = 48;
            let state = 73129;
            function random() {
                state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                return state / 4294967296;
            }
            const seeds = Array.from({ length: count * count }, function () {
                return [0.1 + random() * 0.8, 0.1 + random() * 0.8];
            });
            function seed(x, y) {
                const offset = seeds[((y % count + count) % count) * count + (x % count + count) % count];
                return [(x + offset[0]) * step, (y + offset[1]) * step];
            }
            const paths = [];
            // Include the neighbouring cells outside the viewport, letting SVG clip actual edges
            // instead of drawing an artificial border around the repeating tile.
            for (let y = -1; y <= count; y++) {
                for (let x = -1; x <= count; x++) {
                    const p = seed(x, y), reach = step * 2;
                    let cell = [[p[0] - reach, p[1] - reach], [p[0] + reach, p[1] - reach],
                        [p[0] + reach, p[1] + reach], [p[0] - reach, p[1] + reach]];
                    for (let dy = -2; dy <= 2; dy++) {
                        for (let dx = -2; dx <= 2; dx++) {
                            if (dx === 0 && dy === 0) continue;
                            const q = seed(x + dx, y + dy), nx = q[0] - p[0], ny = q[1] - p[1];
                            const limit = (nx * nx + ny * ny) / 2;
                            const distance = function (v) { return (v[0] - p[0]) * nx + (v[1] - p[1]) * ny - limit; };
                            const clipped = [];
                            for (let i = 0; i < cell.length; i++) {
                                const a = cell[i], b = cell[(i + 1) % cell.length];
                                const da = distance(a), db = distance(b);
                                if (da <= 0) clipped.push(a);
                                if ((da <= 0) !== (db <= 0)) {
                                    const t = da / (da - db);
                                    clipped.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
                                }
                            }
                            cell = clipped;
                        }
                    }
                    paths.push('M' + cell.map(function (v) { return v[0].toFixed(3) + ' ' + v[1].toFixed(3); }).join('L') + 'Z');
                }
            }
            // One stroked path keeps shared cell edges at the same opacity as the other edges.
            cachedVoronoiPath = paths.join('');
            return cachedVoronoiPath;
        }

        // The inked cells of the Truchet tile, in cell units, as one path of row runs. The coins are a
        // fixed-seed LCG, so the pattern is the same on every start; the diagonals are counted modulo
        // the tile, so each one runs on unbroken across the repeat.
        let cachedTruchetPath = null;
        function truchetPath() {
            if (cachedTruchetPath !== null) return cachedTruchetPath;
            const n = TRUCHET.tiles;
            let state = 51977;
            function coins() {
                const b = [];
                for (let k = 0; k < n; k++) {
                    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                    b.push(state >>> 31);                 // the high bit: an LCG's low bits cycle
                }
                return b;
            }
            // rising[i + j]: 0 = upper right, 1 = lower left; falling[i - j]: 0 = upper left, 1 = lower
            // right. Both 0 ink the top half, both 1 the bottom; otherwise the right (falling = 1) or left.
            const rising = coins(), falling = coins();
            let d = '';
            for (let y = 0; y < 2 * n; y++) {
                let run = -1;
                for (let x = 0; x <= 2 * n; x++) {
                    let inked = false;
                    if (x < 2 * n) {
                        const i = x >> 1, j = y >> 1;
                        const a = rising[(i + j) % n], b = falling[(i - j + n) % n];
                        inked = a === b ? (y & 1) === a : (x & 1) === b;
                    }
                    if (inked && run < 0) run = x;
                    if (!inked && run >= 0) { d += 'M' + run + ' ' + y + 'h' + (x - run) + 'v1h-' + (x - run) + 'z'; run = -1; }
                }
            }
            cachedTruchetPath = d;
            return d;
        }

        // Penrose tiling (rhombus P3) has no repeating tile, so CSS gradients can't draw it: it is drawn
        // once per ink onto a canvas big enough to cover the screen, by deflating Robinson triangles from
        // a wheel of ten. Drawing is asynchronous (toBlob); until it's ready the pattern shows as none and
        // apply() runs again when the image arrives.
        const PENROSE_CACHE_LIMIT = 4;
        const penroseCache = new Map();
        function evictPenroseImages() {
            while (penroseCache.size > PENROSE_CACHE_LIMIT) {
                const oldestKey = penroseCache.keys().next().value;
                const oldest = penroseCache.get(oldestKey);
                penroseCache.delete(oldestKey);
                if (oldest.url) URL.revokeObjectURL(oldest.url);
            }
        }
        // `veil`: draw the lines in black at this opacity over the fills (see lineVeil) rather than in
        // the pattern's ink.
        function penroseImage(inkCss, fills, veil) {
            const key = inkCss + '|' + fills.join(',') + (veil ? '|veil ' + veil.toFixed(3) : '');
            const cached = penroseCache.get(key);
            if (cached) {
                // Map insertion order doubles as a tiny LRU list.
                penroseCache.delete(key);
                penroseCache.set(key, cached);
                return cached.url ? cached : null;
            }
            const pending = {};
            penroseCache.set(key, pending);
            evictPenroseImages();

            const cssSize = Math.min(Math.max(window.screen.width, window.screen.height, 1280), 2560);
            // at most 3200 device px a side: beyond that the pixel pass gets slow and memory-hungry
            const dpr = Math.min(window.devicePixelRatio || 1, 2, 3200 / cssSize);
            const S = Math.round(cssSize * dpr);
            const EDGE = 30 * dpr;                        // rhombus side, device px
            const PHI = (1 + Math.sqrt(5)) / 2;
            const R = S * 0.75;                           // the wheel covers the square's corners
            const half = S / 2;

            // [kind, ax, ay, bx, by, cx, cy]; kind 0 = half of a thick rhombus, 1 = half of a thin one
            let tris = [];
            for (let i = 0; i < 10; i++) {
                let b = (2 * i - 1) * Math.PI / 10, c = (2 * i + 1) * Math.PI / 10;
                if (i % 2 === 0) { const t = b; b = c; c = t; }
                tris.push([0, 0, 0, R * Math.cos(b), R * Math.sin(b), R * Math.cos(c), R * Math.sin(c)]);
            }
            function visible(t) {
                const m = EDGE * 2;
                return Math.max(t[1], t[3], t[5]) > -half - m && Math.min(t[1], t[3], t[5]) < half + m
                    && Math.max(t[2], t[4], t[6]) > -half - m && Math.min(t[2], t[4], t[6]) < half + m;
            }
            let side = R;
            while (side > EDGE) {
                const next = [];
                for (const t of tris) {
                    const ax = t[1], ay = t[2], bx = t[3], by = t[4], cx = t[5], cy = t[6];
                    if (t[0] === 0) {
                        const px = ax + (bx - ax) / PHI, py = ay + (by - ay) / PHI;
                        next.push([0, cx, cy, px, py, bx, by], [1, px, py, cx, cy, ax, ay]);
                    } else {
                        const qx = bx + (ax - bx) / PHI, qy = by + (ay - by) / PHI;
                        const rx = bx + (cx - bx) / PHI, ry = by + (cy - by) / PHI;
                        next.push([1, rx, ry, cx, cy, ax, ay], [1, qx, qy, rx, ry, bx, by], [0, rx, ry, qx, qy, ax, ay]);
                    }
                }
                tris = next.filter(visible);
                side /= PHI;
            }

            // Draw as grey levels (darker = more ink), then turn that into ink colour + alpha, so shared
            // edges and the seam inside each rhombus don't get painted twice at partial opacity. Lines
            // drawn as a veil go into the green channel instead, the fills keeping red to themselves.
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = S;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, S, S);
            ctx.translate(half, half);
            ctx.lineWidth = 1;
            fills.forEach(function (grey, kind) {    // kind 0 = thick rhombi, 1 = thin ones
                if (!grey) return;
                // stroked as well as filled: the seam inside each rhombus closes without a hairline
                ctx.fillStyle = ctx.strokeStyle = veil ? 'rgb(' + parseInt(grey.slice(1, 3), 16) + ',255,255)' : grey;
                ctx.beginPath();
                for (const t of tris) {
                    if (t[0] !== kind) continue;
                    ctx.moveTo(t[1], t[2]); ctx.lineTo(t[3], t[4]); ctx.lineTo(t[5], t[6]); ctx.closePath();
                }
                ctx.fill();
                ctx.stroke();
            });
            ctx.lineWidth = 1.3 * dpr;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            for (const t of tris) {                       // the two legs; the base is the rhombus diagonal
                ctx.moveTo(t[5], t[6]); ctx.lineTo(t[1], t[2]); ctx.lineTo(t[3], t[4]);
            }
            if (!veil) {
                ctx.strokeStyle = '#000';                 // the static pattern: one weight, full ink
            } else {
                // multiplying by magenta clears green where the line covers and leaves red alone
                ctx.globalCompositeOperation = 'multiply';
                ctx.strokeStyle = '#f0f';
            }
            ctx.stroke();

            const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(inkCss);
            const img = ctx.getImageData(0, 0, S, S), d = img.data;
            const r = +m[1], g = +m[2], b = +m[3], a = +m[4];
            for (let i = 0; i < d.length; i += 4) {
                // edges a bit stronger than the simple patterns
                const fill = (255 - d[i]) * a * 1.6 / 255;
                const line = veil ? (255 - d[i + 1]) / 255 * veil : 0;
                const alpha = line + fill * (1 - line);  // black line over the inked fill
                const share = alpha ? fill * (1 - line) / alpha : 0;
                d[i] = r * share; d[i + 1] = g * share; d[i + 2] = b * share;
                d[i + 3] = Math.round(alpha * 255);
            }
            ctx.putImageData(img, 0, 0);                  // putImageData ignores the transform
            canvas.toBlob(function (blob) {
                // The pending render may have been evicted while toBlob was working.
                if (penroseCache.get(key) !== pending) return;
                if (!blob) { penroseCache.delete(key); return; }
                penroseCache.delete(key);
                penroseCache.set(key, { url: URL.createObjectURL(blob), size: cssSize });
                evictPenroseImages();
                apply(color, pattern);
            });
            return null;
        }

        // An animated pattern cross-fades two images, which one element's background cannot do, so it
        // is painted on a pair of stacked layers appended to the element: behind the page for <body>,
        // inside the swatch in the picker. They are built on first use and kept for later.
        const animBoxes = new WeakMap();
        function animBox(el, wanted) {
            let box = animBoxes.get(el);
            if (!box) {
                if (!wanted) return null;
                box = document.createElement('span');
                box.className = 'bg-anim';
                box.setAttribute('aria-hidden', 'true');
                for (let i = 0; i < 2; i++) {
                    const layer = document.createElement('span');
                    layer.className = i === 0 ? 'bg-layer' : 'bg-layer bg-layer-b';
                    box.appendChild(layer);
                }
                el.appendChild(box);
                animBoxes.set(el, box);
            }
            box.hidden = !wanted;
            return wanted ? box : null;
        }

        function paint(el, colorName, patternName, scale) {
            const p = PATTERNS[patternName](ink(colorName), COLORS[colorName]);
            const tile = p.size ? (p.size * scale) + 'px ' + ((p.height || p.size) * scale) + 'px' : '';
            el.style.backgroundColor = COLORS[colorName];
            el.style.backgroundImage = p.swap ? 'none' : p.image;   // animated: the layers carry it
            el.style.backgroundSize = p.swap ? '' : tile;
            el.style.backgroundPosition = p.swap ? '' : (p.position || '');
            const box = animBox(el, !!p.swap);
            if (!box) return;
            box.children[0].style.backgroundImage = p.image;
            box.children[1].style.backgroundImage = p.swap;
            box.children[0].style.backgroundSize = box.children[1].style.backgroundSize = tile;
        }

        function apply(colorName, patternName) {
            color = COLORS[colorName] ? colorName : DEFAULT;
            pattern = PATTERNS[patternName] ? patternName : DEFAULT_PATTERN;
            paint(document.body, color, pattern, 1);
            picker.querySelectorAll('.bg-opt').forEach(function (o) {
                o.classList.toggle('current', o.dataset.bg === color);
            });
            // pattern swatches are previewed on the current colour — only while the picker is open, so
            // the Penrose image isn't drawn on every start just for its swatch
            if (picker.hidden) return;
            picker.querySelectorAll('.bg-pat').forEach(function (o) {
                o.classList.toggle('current', o.dataset.pattern === pattern);
                paint(o.querySelector('.bg-pat-chip'), color, o.dataset.pattern, 0.6);
            });
        }
        function save() {
            try {
                localStorage.setItem(KEY, color);
                localStorage.setItem(PATTERN_KEY, pattern);
            } catch (e) { /* not kept */ }
        }
        let saved = null, savedPattern = null;
        try { saved = localStorage.getItem(KEY); savedPattern = localStorage.getItem(PATTERN_KEY); } catch (e) { /* default */ }
        apply(saved, savedPattern);

        picker.querySelectorAll('.bg-opt').forEach(function (o) {
            o.querySelector('.bg-chip').style.background = COLORS[o.dataset.bg];
            o.addEventListener('click', function () {
                apply(o.dataset.bg, pattern);
                save();
            });
        });
        picker.querySelectorAll('.bg-pat').forEach(function (o) {
            o.addEventListener('click', function () {
                apply(color, o.dataset.pattern);
                save();
            });
        });
        // mousedown + preventDefault: picking a background must not take the caret out of the text
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
        picker.addEventListener('mousedown', function (e) { e.preventDefault(); });
        btn.addEventListener('click', function () {
            if (!picker.hidden) { picker.hidden = true; return; }
            picker.hidden = false;
            apply(color, pattern);                        // draws the pattern swatches
            const rect = btn.getBoundingClientRect();
            const top = rect.bottom + 4;
            picker.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - picker.offsetWidth - 8)) + 'px';
            picker.style.top = top + 'px';
            picker.style.maxHeight = Math.max(160, window.innerHeight - top - 8) + 'px';
        });
        document.addEventListener('mousedown', function (e) {
            if (!picker.hidden && !picker.contains(e.target) && !btn.contains(e.target)) picker.hidden = true;
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !picker.hidden) { e.preventDefault(); picker.hidden = true; }
        });
        window.addEventListener('pagehide', function () {
            penroseCache.forEach(function (entry) {
                if (entry.url) URL.revokeObjectURL(entry.url);
            });
            penroseCache.clear();
        });
    })();

    // section divider: a small drop-down of ornament characters
    (function setupDividerPicker() {
        const picker = $('div-picker');
        const btn = $('div-btn');
        // mousedown + preventDefault: the divider has to land at the caret, so the editor keeps focus
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
        picker.addEventListener('mousedown', function (e) { e.preventDefault(); });
        btn.addEventListener('click', function () {
            if (!picker.hidden) { picker.hidden = true; return; }
            picker.hidden = false;
            const rect = btn.getBoundingClientRect();
            picker.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - picker.offsetWidth - 8)) + 'px';
            picker.style.top = (rect.bottom + 4) + 'px';
        });
        picker.querySelectorAll('.div-opt').forEach(function (o) {
            o.addEventListener('click', function () {
                picker.hidden = true;
                Editor.insertDivider(o.dataset.symbol);
                markDirty();
            });
        });
        document.addEventListener('mousedown', function (e) {
            if (!picker.hidden && !picker.contains(e.target) && !btn.contains(e.target)) picker.hidden = true;
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !picker.hidden) { e.preventDefault(); picker.hidden = true; }
        });
    })();

    $('img-btn').addEventListener('click', function () { $('img-input').click(); });
    $('img-input').addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (file) {
            try { Editor.insertImageFile(file); markDirty(); }
            catch (err) { status('Could not insert: ' + err.message); }
        }
        e.target.value = '';
    });

    $('editor').addEventListener('input', markDirty);

    // ── save: encrypt (content + media), then write the .sdoc bytes to the linked file ──
    // The location is asked for ONCE (native "Save as" dialog); after that the handle is kept in
    // memory and every save overwrites the same file without a prompt.
    //
    // Encrypt FIRST, touch the disk after. Chrome creates — or empties — the chosen file the moment the
    // save dialog returns, so asking first and encrypting afterwards left a 0-byte .sdoc whenever the
    // encrypt failed or the tab went away in between, wiping the old document on a save-over. Now the
    // dialog opens only when the bytes are ready, and what follows is a local write, no network.
    const canWriteFiles = typeof window.showSaveFilePicker === 'function';
    // Encrypted bytes whose dialog the browser refused (the encrypt outlasted the click's user
    // activation). Reused by the next click as long as the document has not changed since.
    let ready = null; // { key, blob }

    /** 'ok' | 'cancel' | 'blocked' (no user activation left — needs another click). */
    async function pickFileHandle(suggestedName) {
        let handle;
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: suggestedName,
                types: [{
                    description: 'SecureDoc document',
                    accept: { 'application/octet-stream': ['.sdoc'] }
                }]
            });
        } catch (e) {
            if (e.name === 'AbortError') return { state: 'cancel' };
            if (e.name === 'SecurityError' || e.name === 'NotAllowedError') return { state: 'blocked' };
            throw e;
        }
        return { state: 'ok', handle: handle };
    }

    /** Returns true only if the .sdoc actually reached disk — callers must not discard on false. */
    // ── "Saving…" ──
    // Deriving the key from the passphrase takes a second or two. In a Web Worker that costs the
    // user nothing, but a page opened from disk gets no worker (Chrome refuses one on file://) and
    // Argon2 then runs on the main thread: clicks, the caret and even repainting stop until it is
    // done. So the work is announced first — and the browser is given a frame to actually paint the
    // dialog, because once the main thread is busy it will not paint anything at all.
    const busyDialog = $('busy-dialog');

    busyDialog.addEventListener('cancel', function (e) { e.preventDefault(); }); // Esc must not close it

    function painted() {
        return new Promise(function (resolve) {
            requestAnimationFrame(function () {
                requestAnimationFrame(function () { setTimeout(resolve, 0); });
            });
        });
    }

    async function showBusy(title, note) {
        $('busy-title').textContent = title;
        $('busy-note').textContent = note;
        if (!busyDialog.open) { busyDialog.showModal(); }
        await painted();
    }

    function hideBusy() {
        if (busyDialog.open) { busyDialog.close(); }
    }

    // The dialog is closed in one place, whichever way the save ends.
    async function saveNow(mode) {
        try {
            return await saveDocument(mode || 'save');
        } finally {
            hideBusy();
        }
    }

    async function saveDocument(mode) {
        if (passphrase === null) return false;
        const statusBeforeSave = $('status').textContent;
        const contentRevision = editRevision;
        const content = Editor.serialize();
        // The revision changes on every editor mutation, so the cache key remains constant-size even
        // for large documents. `content` is still the exact snapshot encoded below.
        const key = secretVersion + ':' + editRevision;
        let blob;
        if (ready && ready.key === key) {
            blob = ready.blob;
        } else {
            try {
                status(passphrase ? 'Encrypting…' : 'Preparing…');
                await showBusy(
                    passphrase ? 'Encrypting the document…' : 'Preparing the document…',
                    passphrase
                        ? 'Deriving the key from your passphrase. This can take a couple of seconds.'
                        : 'Packing the document into its file.'
                );
                blob = await Sdoc.encode({
                    passphrase: passphrase,
                    title: title,
                    createdAt: createdAt,
                    content: content,
                    caret: Editor.caretPosition(),
                    media: Editor.usedMedia(content)
                });
            } catch (e) {
                status('Could not prepare the document: ' + (e.message || e) + ' — the file on disk is untouched');
                return false;
            }
        }
        ready = null;
        if (!blob || blob.size === 0) {
            status('Could not prepare the document: the result is empty — the file on disk is untouched');
            return false;
        }
        let targetHandle = mode === 'save' ? fileHandle : null;
        let targetName = docName;
        if (!targetHandle && canWriteFiles) {
            let picked;
            hideBusy();   // the file picker is the user's turn — nothing of ours over it
            try {
                picked = await pickFileHandle(docName);
            } catch (e) {
                status('Could not choose a file: ' + (e.message || e));
                return false;
            }
            if (picked.state === 'cancel') { status(statusBeforeSave); return false; }
            if (picked.state === 'blocked') {
                ready = { key: key, blob: blob };
                status('Document ready — choose the save command again to select the file');
                return false;
            }
            targetHandle = picked.handle;
            targetName = targetHandle.name;
        }
        if (targetHandle) {
            try {
                await showBusy('Writing the file…', 'Putting ' + targetName + ' on disk.');
                // createWritable() writes to a temporary copy that replaces the file only on close(),
                // so a failure before that leaves the previous file intact.
                const writable = await targetHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                const onDisk = (await targetHandle.getFile()).size;
                if (onDisk !== blob.size) {
                    throw new Error(onDisk + ' bytes on disk instead of ' + blob.size);
                }
            } catch (e) {
                // Only forget the active target when it was that target which failed. A cancelled or
                // failed Save as / Save a copy must leave the original document linked to its file.
                if (mode === 'save' && targetHandle === fileHandle) fileHandle = null;
                status('Could not write the file: ' + (e.message || e));
                return false;
            }
            if (mode === 'copy') {
                status('Copy saved as ' + targetName);
                return true;
            }
            fileHandle = targetHandle;
            docName = targetName;
            setSaveOptionsAvailable(true);
            markSaved(content, contentRevision);
            status(docName);
            return true;
        }
        if (mode !== 'save') {
            const entered = window.prompt(mode === 'copy' ? 'Name for the copy' : 'Save document as', docName);
            if (entered === null) { status(statusBeforeSave); return false; }
            targetName = toDocName(entered);
        }
        downloadBlob(blob, targetName);
        if (mode === 'copy') {
            status('Copy downloaded as ' + targetName);
            return true;
        }
        docName = targetName;
        setSaveOptionsAvailable(true);
        markSaved(content, contentRevision);
        status(docName);
        return true;
    }
    // Save as changes the active target only after the new file was written successfully. Save a
    // copy never changes it and never marks edits as saved relative to the active document.
    async function saveAs() {
        if (passphrase === null) return false;
        if (!hasDocumentFile) return saveNow();
        return saveNow('saveAs');
    }
    async function saveCopy() {
        if (passphrase === null) return false;
        return saveNow('copy');
    }
    $('save-btn').addEventListener('click', function () { saveNow(); });
    $('save-as-btn').addEventListener('click', function () { closeSaveMenu(); saveAs(); });
    $('save-copy-btn').addEventListener('click', function () { closeSaveMenu(); saveCopy(); });

    const saveMenu = $('save-menu');
    const saveMenuBtn = $('save-menu-btn');
    function closeSaveMenu() {
        saveMenu.hidden = true;
        saveMenuBtn.setAttribute('aria-expanded', 'false');
    }
    function openSaveMenu() {
        saveMenu.hidden = false;
        saveMenuBtn.setAttribute('aria-expanded', 'true');
        const rect = saveMenuBtn.getBoundingClientRect();
        saveMenu.style.left = Math.max(8, Math.min(rect.right - saveMenu.offsetWidth, window.innerWidth - saveMenu.offsetWidth - 8)) + 'px';
        saveMenu.style.top = Math.min(rect.bottom + 4, window.innerHeight - saveMenu.offsetHeight - 8) + 'px';
        $('save-as-btn').focus();
    }
    saveMenuBtn.addEventListener('click', function () {
        if (saveMenu.hidden) openSaveMenu(); else closeSaveMenu();
    });
    document.addEventListener('mousedown', function (e) {
        if (!saveMenu.hidden && !saveMenu.contains(e.target) && !saveMenuBtn.contains(e.target)) closeSaveMenu();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !saveMenu.hidden) {
            e.preventDefault();
            closeSaveMenu();
            saveMenuBtn.focus();
        }
    });

    // ── download as PDF: use the browser's print engine (→ "Save as PDF") ──
    // The browser names the PDF after document.title, so set it to the file name (without .sdoc)
    // while printing, then restore. The @media print stylesheet outputs only the document content.
    $('pdf-btn').addEventListener('click', function () {
        const prevTitle = document.title;
        document.title = docName.replace(/\.sdoc$/i, '') || 'Document';
        const restore = function () {
            document.title = prevTitle;
            window.removeEventListener('afterprint', restore);
        };
        window.addEventListener('afterprint', restore);
        window.print();
    });

    // ── export to HTML: a portable, unencrypted snapshot with images embedded as data URLs ──
    // Editor.serialize() applies the same HTML allow-list as an .sdoc save. Embedding only media
    // referenced by that sanitized result keeps the exported file self-contained and offline.
    $('html-btn').addEventListener('click', async function () {
        const button = $('html-btn');
        button.disabled = true;
        status('Exporting HTML…');
        try {
            let content = Editor.serialize();
            const media = Editor.usedMedia(content);
            const urls = await Promise.all(media.map(function (item) { return blobAsDataUrl(item.blob); }));
            media.forEach(function (item, i) {
                content = content.split('media://' + item.id).join(urls[i]);
            });
            const fontCss = await exportedFontCss(content);

            const safeTitle = escapeHtmlText(title || docName.replace(/\.sdoc$/i, '') || 'Document');
            const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
                '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
                '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; font-src data:; style-src \'unsafe-inline\'">\n' +
                '<title>' + safeTitle + '</title>\n<style>\n' + fontCss +
                'html{background:#eef1f5}body{box-sizing:border-box;max-width:966px;min-height:100vh;margin:0 auto;padding:64px 72px;background:#fff;color:#15171c;font:16px/1.6 \"Amstelvar\",-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif;white-space:pre-wrap;tab-size:1.27cm}' +
                'p{margin:0 0 12px}a{color:#2459c4;text-decoration:underline;text-underline-offset:2px}img{max-width:100%;height:auto}' +
                '[style*=\"Roboto Serif\"]{font-size-adjust:.57;font-variation-settings:\"wdth\" 55}' +
                'math{font-size:1.12em;white-space:normal}math[display="block"]{display:block;margin:12px 0;text-align:center}' +
                'table.doc-table{border-collapse:separate;border-spacing:0;margin:10px 0;overflow:hidden;border-radius:var(--table-radius,0)}' +
                'table.doc-table td{border:1px solid #b9c0c8;padding:6px 10px;min-width:48px;vertical-align:top}' +
                'table.doc-table tr:first-child>:first-child{border-top-left-radius:var(--table-radius,0)}table.doc-table tr:first-child>:last-child{border-top-right-radius:var(--table-radius,0)}' +
                'table.doc-table tr:last-child>:first-child{border-bottom-left-radius:var(--table-radius,0)}table.doc-table tr:last-child>:last-child{border-bottom-right-radius:var(--table-radius,0)}' +
                'blockquote{margin:0 0 12px;padding-left:20px;border-left:3px solid #d7dce2}.doc-divider{text-align:center}' +
                '@media(max-width:700px){body{padding:28px 22px}}@media print{html{background:#fff}body{max-width:none;padding:0}}\n' +
                '</style>\n</head>\n<body>\n' + content + '\n</body>\n</html>\n';
            const filename = sanitizeName(docName.replace(/\.sdoc$/i, '') || title || 'document') + '.html';
            downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), filename);
            status('Exported as ' + filename);
        } catch (e) {
            status('Could not export HTML: ' + (e.message || e));
        } finally {
            button.disabled = false;
        }
    });
    document.addEventListener('keydown', function (e) {
        if ($('editor-view').hidden) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            if (e.shiftKey) saveAs(); else saveNow();
        } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
                && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            if (!linkDlg.open) openLinkDialog();
        } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'Space') {
            e.preventDefault(); // Ctrl+Space — as in Word: clear formatting
            clearFormat();
        } else if ((e.ctrlKey || e.metaKey) && !e.altKey
                && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
            e.preventDefault(); // Ctrl+] / Ctrl+[ — as in Word: larger / smaller
            stepFontSize(e.code === 'BracketRight');
        }
    });

    // ── change password: verify locally, re-encrypt, and save immediately ──
    const dlg = $('pw-dialog');
    let passwordSaving = false;
    $('pw-btn').addEventListener('click', function () {
        $('pw-error').hidden = true;
        $('pw-old').value = '';
        $('pw-new').value = '';
        dlg.showModal();
    });
    $('pw-cancel').addEventListener('click', function () { if (!passwordSaving) dlg.close(); });
    dlg.addEventListener('cancel', function (e) { if (passwordSaving) e.preventDefault(); });
    $('pw-gen').addEventListener('click', function () { $('pw-new').value = Passphrase.generate(); });
    function pwError(msg) { const b = $('pw-error'); b.textContent = msg; b.hidden = false; }
    $('pw-apply').addEventListener('click', async function () {
        if (passwordSaving) return;
        const oldP = Passphrase.canonical($('pw-old').value);
        const newP = Passphrase.canonical($('pw-new').value);
        if (oldP !== (passphrase || '')) return pwError('The current passphrase is wrong.');
        const bad = Passphrase.validate(newP);
        if (bad) return pwError(bad);
        const wasDirty = dirty;
        const wasPendingPassword = pendingPassword;
        passphrase = newP;
        secretVersion++;
        Sdoc.prepare(newP);
        pendingPassword = true;
        setDirty(true);
        passwordSaving = true;
        $('pw-apply').disabled = true;
        $('pw-cancel').disabled = true;
        let saved = false;
        try {
            saved = await saveNow();
        } catch (e) {
            status('Could not save the file: ' + (e.message || e));
        }
        if (saved) {
            dlg.close();
        } else {
            ready = null;
            passphrase = oldP;
            secretVersion++;
            Sdoc.prepare(oldP);
            pendingPassword = wasPendingPassword;
            setDirty(wasDirty);
            pwError('Could not save the document. The current passphrase was not changed.');
        }
        passwordSaving = false;
        $('pw-apply').disabled = false;
        $('pw-cancel').disabled = false;
    });

    // ── close ──
    // Closing drops the only copy of the document, so never do it on a save that did not land:
    // a failed save (encryption error, write refused) must leave the editor exactly as it was.
    $('close-btn').addEventListener('click', async function () {
        if (dirty) {
            if (confirm('Save changes before closing?')) {
                if (!await saveNow()) return; // saveNow() already showed why; keep the document open
            }
        }
        passphrase = null;
        secretVersion++;
        Sdoc.forget();
        ready = null;
        clearSecretInputs();
        cancelDirtyCheck();
        setDirty(false); // nothing is open any more — no unload prompt on the setup screen
        savedContent = null;
        editRevision = 0;
        savedRevision = 0;
        needsKdfUpgrade = false;
        createdAt = null;
        title = 'New document';
        docName = 'untitled.sdoc';
        setSaveOptionsAvailable(false);
        Editor.clearMedia();
        Editor.load('<p><br></p>');
        showView('setup');
        document.title = 'SecureDoc';
        status('');
    });

    // ── unload guard ──
    // The live document exists only in this tab — no server holds a copy and nothing is written
    // until a save succeeds. A reload or a closed tab with unsaved changes is unrecoverable, so let
    // the browser ask first. (This is the reflex to protect against when a save fails: "just reload".)
    window.addEventListener('beforeunload', function (e) {
        if (!dirty) return;
        e.preventDefault();
        e.returnValue = ''; // required by older browsers to trigger the prompt
    });

    // ── boot ──
    Editor.init($('editor'));
    showView('setup');
})();
