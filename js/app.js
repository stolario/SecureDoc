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
    let title = 'New document';
    let createdAt = null;        // ISO instant from a decrypted/opened doc; null for a fresh one
    let docName = 'untitled.sdoc';
    // Where Save writes. A FileSystemFileHandle from showSaveFilePicker: asked for ONCE, then
    // every later save overwrites that file silently. null = no target yet (fresh/imported/just-opened
    // doc, or a browser without the API), so the next save asks where.
    let fileHandle = null;

    const $ = function (id) { return document.getElementById(id); };

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
    let pendingPassword = false; // a changed passphrase only reaches the file on the next save
    let dirtyCheck = 0;

    function setDirty(v) {
        dirty = v;
        $('dirty-mark').hidden = !v;
        document.title = (v ? '* ' : '') + (title || 'Document') + ' — SecureDoc';
    }
    function markDirty() {
        setDirty(true);
        status('Unsaved');
        clearTimeout(dirtyCheck);
        dirtyCheck = setTimeout(recheckDirty, 300);
    }
    function recheckDirty() {
        if ($('editor-view').hidden) return;
        const changed = pendingPassword || Editor.serialize() !== savedContent;
        if (!changed && dirty) status('');
        setDirty(changed);
    }
    // `content` is what just reached the disk; edits made while it was being written stay marked.
    function markSaved(content) {
        savedContent = content;
        pendingPassword = false;
        recheckDirty();
    }

    function setBusy(msg) {
        const b = $('setup-busy');
        if (!msg) { b.hidden = true; } else { b.textContent = msg; b.hidden = false; }
        ['create-btn', 'open-btn', 'import-btn', 'open-file', 'import-file'].forEach(function (id) {
            $(id).disabled = !!msg;
        });
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
        $(tab.getAttribute('aria-controls')).querySelector('.field-msg')
            .append($('setup-busy'), $('setup-error'));
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
        showFontSize();
        pendingPassword = false;
        savedContent = clean ? Editor.serialize() : null;
        setDirty(!clean);
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
    // A file dropped beside the zone would be opened or downloaded by the browser, leaving the page.
    ['dragover', 'drop'].forEach(function (type) {
        document.addEventListener(type, function (e) {
            if ($('setup-view').hidden || e.defaultPrevented || !hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'none';
        });
    });

    // ── open: the browser reads the .sdoc and decrypts it locally (sdoc.js) ──
    // A browser <input type=file> (or a drop) hides the on-disk path, so the opened doc has no linked
    // path yet; the first Save asks where (native Save dialog) once, then writes there silently.
    async function openSdoc(file) {
        setupError(null);
        const phrase = Passphrase.canonical($('open-phrase').value);
        if (Passphrase.wordCount(phrase) < 6) {
            setupError('Enter the 12 words, then click Open.');
            return false;
        }
        try {
            setBusy('Decrypting the document…');
            const doc = await Sdoc.decode(file, phrase);
            passphrase = phrase;
            title = doc.title || file.name.replace(/\.sdoc$/i, '');
            createdAt = doc.createdAt || null;
            docName = toDocName(file.name);
            fileHandle = null; // <input type=file> gives no writable handle: first save asks where
            Sdoc.prepare(phrase);
            loadMedia(doc.media);
            Editor.load(doc.content);
            openInEditor(true);
            Editor.restoreCaret(doc.caret); // back where the caret was at the last save
            status('Opened');
            return true;
        } catch (e) {
            setupError(e.code === 'wrong_password'
                ? 'Wrong passphrase. Correct it and click Open.'
                : 'Could not open: ' + (e.message || e));
            return false;
        } finally {
            setBusy(null);
        }
    }
    fileZone('open-file', 'open-btn', openSdoc);

    // ── create: a fresh empty document, entirely in the browser (no server call) ──
    $('create-btn').addEventListener('click', function () {
        setupError(null);
        const t = $('new-title').value.trim() || 'New document';
        const phrase = Passphrase.canonical($('new-phrase').value);
        const bad = Passphrase.validate(phrase);
        if (bad) return setupError(bad);
        passphrase = phrase;
        title = t;
        createdAt = null;
        docName = toDocName(t);
        fileHandle = null;
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
            const doc = await Importer.importFile(file, file.name);
            passphrase = phrase;
            title = doc.title || file.name.replace(/\.[^.]+$/, '');
            createdAt = null;
            docName = toDocName(title);
            fileHandle = null;
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

    // ── font size ──
    // Clicking the <select> takes focus out of the editor; Editor keeps the last range for exactly
    // this reason, so the size lands on the text that was selected, not at the top of the document.
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
        $('table-ops').hidden = $('editor-view').hidden || (!filling && !Editor.inTable());
        if (!filling) showFillSwatch(Editor.cellColorAt());
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
        const DEFAULT = 'grey';
        // Each pattern is drawn in `ink` — a faint dark tone over light colours, a faint light one over
        // dark ones — on top of the chosen colour. `size` is the tile in px (null: the image tiles itself).
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
                const edgeInk = ink.replace(/,([\d.]+)\)$/, function (_, alpha) {
                    return ',' + (Number(alpha) * 1.2) + ')';
                });
                const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480">'
                    + '<path d="' + voronoiPath() + '" fill="none" stroke="' + edgeInk
                    + '" stroke-width="2" stroke-linejoin="round"/></svg>';
                return { image: 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")', size: 480 };
            },
            penrose: function (ink) {
                const tiling = penroseImage(ink, PENROSE_FILLS);
                return tiling ? { image: 'url("' + tiling.url + '")', size: tiling.size } : { image: 'none', size: null };
            },
            // Animated: the same tiling as `penrose`, cross-fading with the copy that gives each kind
            // of rhombus the other's tone, so the two greys trade places — the light ones darken while
            // the dark ones lighten, and the dividing lines turn over with them (contrastEdges), never
            // sinking into a fill of their own weight. `swap` is the second image; the cross-fade
            // itself is CSS (.bg-layer), see paint().
            'penrose-swap': function (ink) {
                const a = penroseImage(ink, SWAP_FILLS, true);
                const b = penroseImage(ink, [SWAP_FILLS[1], SWAP_FILLS[0]], true);
                if (!a || !b) return { image: 'none', size: null };
                return { image: 'url("' + a.url + '")', swap: 'url("' + b.url + '")', size: a.size };
            }
        };
        const DEFAULT_PATTERN = 'none';
        // The tone each kind of rhombus is filled with, [thick, thin], as a grey on white — darker
        // carries more ink, null leaves the rhombus at the background colour. The static pattern
        // tints the thick ones faintly and leaves the rest bare. The animated one gives both kinds
        // a tone of their own, far apart, because that is what trades places: a faint tint that
        // merely comes and goes measures ~10 levels of 255 and reads as a still background.
        const PENROSE_FILLS = ['#b3b3b3', null];
        const SWAP_FILLS = ['#2e2e2e', '#e6e6e6'];
        let color = DEFAULT, pattern = DEFAULT_PATTERN;

        function ink(name) { return DARK.has(name) ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.11)'; }

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

        // Penrose tiling (rhombus P3) has no repeating tile, so CSS gradients can't draw it: it is drawn
        // once per ink onto a canvas big enough to cover the screen, by deflating Robinson triangles from
        // a wheel of ten. Drawing is asynchronous (toBlob); until it's ready the pattern shows as none and
        // apply() runs again when the image arrives.
        const penroseCache = {};
        function penroseImage(inkCss, fills, contrastEdges) {
            const key = inkCss + '|' + fills.join(',') + (contrastEdges ? '|contrast' : '');
            const cached = penroseCache[key];
            if (cached) return cached.url ? cached : null;
            penroseCache[key] = {};

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
            // edges and the seam inside each rhombus don't get painted twice at partial opacity.
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
                ctx.fillStyle = ctx.strokeStyle = grey;
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
            if (!contrastEdges) {
                ctx.strokeStyle = '#000';                 // the static pattern: one weight, full ink
                ctx.stroke();
            } else {
                // Each line comes out as the inverse of the tone it lies on (white, differenced), so a
                // deep fill gets a pale line and a pale fill a deep one; where two kinds meet, the line
                // carries both, one tone to each side. When the fills trade places the lines turn over
                // with them, in antiphase.
                ctx.globalCompositeOperation = 'difference';
                ctx.strokeStyle = '#fff';
                ctx.stroke();
                // A plain inverse would leave the lines averaging exactly what the fills average, and
                // the cross-fade passes through that average: for a moment the whole tiling washes out.
                // Weighting every line towards the ink keeps the lines darker than the mean fill, so
                // the drawing survives the crossing as a line drawing.
                ctx.globalCompositeOperation = 'source-over';
                ctx.strokeStyle = 'rgba(0,0,0,0.3)';
                ctx.stroke();
            }

            const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(inkCss);
            const img = ctx.getImageData(0, 0, S, S), d = img.data;
            const r = +m[1], g = +m[2], b = +m[3], a = +m[4];
            for (let i = 0; i < d.length; i += 4) {
                const level = 255 - d[i];
                d[i] = r; d[i + 1] = g; d[i + 2] = b;
                d[i + 3] = Math.round(level * a * 1.6);   // edges a bit stronger than the simple patterns
            }
            ctx.putImageData(img, 0, 0);                  // putImageData ignores the transform
            canvas.toBlob(function (blob) {
                if (!blob) { delete penroseCache[key]; return; }
                penroseCache[key] = { url: URL.createObjectURL(blob), size: cssSize };
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
            const p = PATTERNS[patternName](ink(colorName));
            const tile = p.size ? (p.size * scale) + 'px ' + (p.size * scale) + 'px' : '';
            el.style.backgroundColor = COLORS[colorName];
            el.style.backgroundImage = p.swap ? 'none' : p.image;   // animated: the layers carry it
            el.style.backgroundSize = p.swap ? '' : tile;
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
    async function pickFileHandle() {
        try {
            fileHandle = await window.showSaveFilePicker({
                suggestedName: docName,
                types: [{
                    description: 'SecureDoc document',
                    accept: { 'application/octet-stream': ['.sdoc'] }
                }]
            });
        } catch (e) {
            if (e.name === 'AbortError') return 'cancel';
            if (e.name === 'SecurityError' || e.name === 'NotAllowedError') return 'blocked';
            throw e;
        }
        docName = fileHandle.name; // whatever the user typed in the dialog is the name from now on
        return 'ok';
    }

    /** Returns true only if the .sdoc actually reached disk — callers must not discard on false. */
    async function saveNow() {
        if (!passphrase) return false;
        const content = Editor.serialize();
        const key = JSON.stringify([passphrase, title, content]);
        let blob;
        if (ready && ready.key === key) {
            blob = ready.blob;
        } else {
            try {
                status('Encrypting…');
                blob = await Sdoc.encode({
                    passphrase: passphrase,
                    title: title,
                    createdAt: createdAt,
                    content: content,
                    caret: Editor.caretPosition(),
                    media: Editor.usedMedia(content)
                });
            } catch (e) {
                status('Encryption failed: ' + (e.message || e) + ' — the file on disk is untouched');
                return false;
            }
        }
        ready = null;
        if (!blob || blob.size === 0) {
            status('Encryption failed: the result is empty — the file on disk is untouched');
            return false;
        }
        if (!fileHandle && canWriteFiles) {
            let picked;
            try {
                picked = await pickFileHandle();
            } catch (e) {
                status('Could not choose a file: ' + (e.message || e));
                return false;
            }
            if (picked === 'cancel') { status('Save cancelled'); return false; }
            if (picked === 'blocked') {
                ready = { key: key, blob: blob };
                status('Document encrypted — click Save again to choose the file');
                return false;
            }
        }
        if (fileHandle) {
            try {
                // createWritable() writes to a temporary copy that replaces the file only on close(),
                // so a failure before that leaves the previous file intact.
                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                const onDisk = (await fileHandle.getFile()).size;
                if (onDisk !== blob.size) {
                    throw new Error(onDisk + ' bytes on disk instead of ' + blob.size);
                }
            } catch (e) {
                // Permission revoked (e.g. after a reload) or the file is gone — ask again next time.
                fileHandle = null;
                status('Could not write the file: ' + (e.message || e));
                return false;
            }
            markSaved(content);
            status(docName);
            return true;
        }
        downloadBlob(blob, docName);
        markSaved(content);
        status(docName);
        return true;
    }
    // "Save as…": drop the linked file so the next save asks for a new location.
    async function saveAs() {
        if (!passphrase) return false;
        fileHandle = null;
        return saveNow();
    }
    $('save-btn').addEventListener('click', saveNow);

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
    document.addEventListener('keydown', function (e) {
        if ($('editor-view').hidden) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            if (e.shiftKey) saveAs(); else saveNow();
        } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'Space') {
            e.preventDefault(); // Ctrl+Space — as in Word: clear formatting
            clearFormat();
        } else if ((e.ctrlKey || e.metaKey) && !e.altKey
                && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
            e.preventDefault(); // Ctrl+] / Ctrl+[ — as in Word: larger / smaller
            stepFontSize(e.code === 'BracketRight');
        }
    });

    // ── change password: client-side (verify current locally, swap the held one; applies on save) ──
    const dlg = $('pw-dialog');
    $('pw-btn').addEventListener('click', function () {
        $('pw-error').hidden = true;
        $('pw-old').value = '';
        $('pw-new').value = '';
        dlg.showModal();
    });
    $('pw-cancel').addEventListener('click', function () { dlg.close(); });
    $('pw-gen').addEventListener('click', function () { $('pw-new').value = Passphrase.generate(); });
    function pwError(msg) { const b = $('pw-error'); b.textContent = msg; b.hidden = false; }
    $('pw-apply').addEventListener('click', function () {
        const oldP = Passphrase.canonical($('pw-old').value);
        const newP = Passphrase.canonical($('pw-new').value);
        if (oldP !== (passphrase || '')) return pwError('The current passphrase is wrong.');
        const bad = Passphrase.validate(newP);
        if (bad) return pwError(bad);
        passphrase = newP;
        Sdoc.prepare(newP);
        pendingPassword = true;
        setDirty(true);
        dlg.close();
        status('Passphrase changed — save the file');
    });

    // ── close ──
    // Closing drops the only copy of the document, so never do it on a save that did not land:
    // a failed save (encryption error, write refused) must leave the editor exactly as it was.
    $('close-btn').addEventListener('click', async function () {
        if (dirty) {
            if (confirm('Save changes before closing?')) {
                if (!await saveNow()) return; // saveNow() already showed why; keep the document open
            } else if (!confirm('Close without saving? The changes will be lost for good.')) {
                return;
            }
        }
        passphrase = null;
        Sdoc.forget();
        clearTimeout(dirtyCheck);
        setDirty(false); // nothing is open any more — no unload prompt on the setup screen
        savedContent = null;
        createdAt = null;
        title = 'New document';
        docName = 'untitled.sdoc';
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
