'use strict';
// The contenteditable rich-text surface (DESIGN.md §7). Formatting uses document.execCommand.
// Images live in a client-side media store (id -> Blob) and are shown via blob: URLs; the saved
// HTML references them by a stable media://<id>. The bytes exist only in this page until a save
// encrypts them into the .sdoc.
window.Editor = (function () {
    let el = null;

    // media id -> { blob, url }. The blob is the raw image; url is an object URL for display.
    const media = new Map();

    // ── image resize state ──
    let selectedImg = null;
    let handle = null;
    let resizing = false;
    let startX = 0;
    let startW = 0;

    function init(editorEl) {
        el = editorEl;
        setupImageResize();
        setupTabKey();
        setupPaste();
        setupCaretMemory();
    }

    // ── caret memory ──
    // Clicking a toolbar control — or opening the file dialog for an image — moves focus out of the
    // editor and collapses the selection. A later el.focus() then drops the caret at the very start,
    // so the insert lands at the top of the document instead of where the user was typing. Remember
    // the last range that was inside the editor and put it back before inserting.
    let lastRange = null;

    function setupCaretMemory() {
        document.addEventListener('selectionchange', function () {
            if (!selectionOwned()) return;
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return;
            const r = sel.getRangeAt(0);
            if (el.contains(r.commonAncestorContainer)) lastRange = r.cloneRange();
        });
    }

    // Is the current selection still the user's editing selection? While a toolbar control has focus
    // (the font-size <select>, say) the browser may collapse or drop the selection in the editor;
    // recording that would overwrite the very range the control is about to act on.
    function selectionOwned() {
        const a = document.activeElement;
        return !a || a === document.body || el.contains(a);
    }

    // Focus the editor with the caret where the user left it. A range whose nodes have since been
    // removed from the editor is dropped (el.contains is false for a detached node).
    function focusEditor() {
        el.focus();
        const sel = window.getSelection();
        if (!sel) return;
        if (sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
        if (lastRange && el.contains(lastRange.commonAncestorContainer)) {
            sel.removeAllRanges();
            sel.addRange(lastRange);
        }
    }

    // Tab inserts a tab character (instead of moving focus out of the editor); Shift+Tab removes a
    // preceding tab. The editor CSS uses white-space: pre-wrap + tab-size so the tab renders.
    function setupTabKey() {
        el.addEventListener('keydown', function (e) {
            if (e.key !== 'Tab') return;
            e.preventDefault();
            if (e.shiftKey) {
                removePrecedingTab();
            } else {
                document.execCommand('insertText', false, '\t');
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    function removePrecedingTab() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        if (!range.collapsed) return;
        const node = range.startContainer;
        if (node.nodeType === 3 && range.startOffset > 0
                && node.nodeValue.charAt(range.startOffset - 1) === '\t') {
            document.execCommand('delete');
        }
    }

    // ── paste sanitizing ──
    // Pasting from a web page (or Word) dumps the source HTML with all its inline styling. The worst
    // offender is background-color: it paints a box behind the pasted text AND leaves a styled <span>
    // that the caret gets stuck inside, so everything you type afterwards keeps the background and you
    // can't get back out. So we intercept paste, strip external styling down to the few things the
    // editor itself can express (alignment, bold/italic/underline), and unwrap leftover wrapper spans.

    // Tags dropped with their whole subtree — active, interactive, or media we can't take ownership of.
    const PASTE_DROP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'IFRAME',
        'OBJECT', 'EMBED', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'FORM', 'VIDEO', 'AUDIO',
        'SOURCE', 'TRACK', 'CANVAS', 'SVG', 'MATH', 'NOSCRIPT', 'APPLET', 'FRAME', 'FRAMESET']);

    // Tags kept as-is (their contents are still cleaned). Anything neither kept nor dropped is
    // "unwrapped" — the tag goes but its children stay, so text and inline formatting survive.
    const PASTE_KEEP = new Set(['P', 'BR', 'HR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S',
        'STRIKE', 'DEL', 'INS', 'SUB', 'SUP', 'SMALL', 'A', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
        'BLOCKQUOTE', 'PRE', 'CODE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY',
        'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'COLGROUP', 'COL', 'IMG', 'FIGURE', 'FIGCAPTION']);

    // Attributes kept per tag (plus style/class, handled specially). Everything else — bgcolor,
    // color, align, aria-*, foreign data-* — is dropped; presentational attrs are where stray
    // backgrounds and colours sneak back in.
    const PASTE_ATTRS = {
        A: ['href', 'title'], IMG: ['src', 'alt', 'data-media-id', 'width', 'height'],
        TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan']
    };

    // Inline style properties worth keeping. Deliberately NOT background / background-color / color /
    // font-family, so pasted text takes on the editor's own look instead of the source page's.
    const PASTE_STYLES = new Set(['text-align', 'font-weight', 'font-style', 'text-decoration',
        'vertical-align', 'list-style-type']);

    // font-size is the exception among the font-* properties: the toolbar makes size part of the
    // document, so copying a paragraph — within the app, or out of Word — must not flatten it. Only
    // points are accepted, and only in a sane range: web pages express sizes in px/em/%, which is
    // where the stray 11px body text of a source page would otherwise come from.
    // background-color is the other exception, on table cells only: cell fill is part of the
    // document too, and a cell is a block — no caret-trapping span can come of it.
    function keepStyle(prop, val, tag) {
        if (prop === 'background-color') return tag === 'TD' || tag === 'TH';
        if (prop !== 'font-size') return PASTE_STYLES.has(prop);
        const pt = /^([0-9.]+)pt$/.exec(val);
        return !!pt && parseFloat(pt[1]) >= 6 && parseFloat(pt[1]) <= 96;
    }

    const PASTE_CLASSES = new Set(['doc-table']); // keep our table styling when copying within the app

    // Marks a pasted <img> whose bytes we don't own yet — see adoptPastedImages.
    const PASTE_ADOPT = 'data-paste-adopt';

    function setupPaste() {
        el.addEventListener('paste', function (e) {
            const cb = e.clipboardData || window.clipboardData;
            if (!cb) return; // no clipboard access — let the browser do its default thing
            const html = cb.getData('text/html');
            const file = imageFileFrom(cb);
            // "Copy image" in a browser, in Word, in most viewers puts BOTH the bitmap AND a scrap of
            // HTML on the clipboard — <img src="https://…"> or file:///…/clip_image001.png. That HTML
            // points at bytes we don't own: file:// never loads from an http page, remote hosts often
            // refuse the hotlink, and either way the image can't go into the .sdoc. The Windows snipping
            // tool puts only the bitmap, which is why that one always worked. So when the clipboard
            // carries real image bytes and no text worth keeping, take the bytes.
            if (file && !htmlHasText(html)) {
                e.preventDefault();
                try { insertImageFile(file); fireInput(); } catch (err) { /* leave as-is */ }
                return;
            }
            if (html) {
                e.preventDefault();
                document.execCommand('insertHTML', false, cleanPastedHtml(html));
                adoptPastedImages();
                fireInput();
                return;
            }
            const text = cb.getData('text/plain');
            if (text) {
                e.preventDefault();
                document.execCommand('insertText', false, text);
                fireInput();
            }
        });
    }

    function imageFileFrom(cb) {
        const items = cb.items;
        if (!items) return null;
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file' && /^image\//.test(items[i].type)) return items[i].getAsFile();
        }
        return null;
    }

    // Does this clipboard HTML carry anything besides the image itself? A "copy image" scrap is just
    // the <img> (plus a <meta> and the usual fragment comments), with no text of its own.
    function htmlHasText(html) {
        if (!html) return false;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return (doc.body.textContent || '').trim().length > 0;
    }

    function cleanPastedHtml(html) {
        // DOMParser builds the tree without running scripts or loading resources; we scrub it before
        // any of it reaches the live document.
        const doc = new DOMParser().parseFromString(html, 'text/html');
        cleanNodes(doc.body);
        // Any image we can't already resolve in the media store came from elsewhere — a remote URL, a
        // file:// path, or a blob: URL minted by some other window. Mark it so we can try to take
        // ownership of the bytes once it's in the document.
        doc.body.querySelectorAll('img').forEach(function (img) {
            const id = img.getAttribute('data-media-id');
            if (!id || !media.has(id)) img.setAttribute(PASTE_ADOPT, '1');
        });
        return doc.body.innerHTML;
    }

    // Pull the bytes of just-pasted foreign images into the media store, so they render from a local
    // blob: URL and get written into the .sdoc on save. Fetching is what can fail: file:// is blocked
    // outright, and a cross-origin host without CORS won't hand the bytes over. When it fails we keep
    // the image if the browser can at least display it (it still loads from its original URL, as
    // before), and drop it when it can't — a broken box is worse than nothing.
    function adoptPastedImages() {
        el.querySelectorAll('img[' + PASTE_ADOPT + ']').forEach(function (img) {
            img.removeAttribute(PASTE_ADOPT);
            blobFromSrc(img.getAttribute('src')).then(function (blob) {
                if (!img.isConnected) return;
                if (!/^image\//.test(blob.type)) throw new Error('not an image');
                const id = genId();
                img.setAttribute('data-media-id', id);
                img.setAttribute('src', putMedia(id, blob));
                fireInput();
            }).catch(function () {
                img.removeAttribute('data-media-id'); // stale id: whatever it pointed at isn't ours
                displaysOk(img).then(function (ok) {
                    if (!ok && img.isConnected) { img.remove(); fireInput(); }
                });
            });
        });
    }

    // fetch handles data: and http(s):; file:// and opaque cross-origin responses reject here.
    function blobFromSrc(src) {
        if (!src) return Promise.reject(new Error('no src'));
        return fetch(src).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.blob();
        });
    }

    function displaysOk(img) {
        if (img.complete) return Promise.resolve(img.naturalWidth > 0);
        return new Promise(function (resolve) {
            img.addEventListener('load', function () { resolve(true); }, { once: true });
            img.addEventListener('error', function () { resolve(false); }, { once: true });
        });
    }

    function cleanNodes(root) {
        // Snapshot the children first: we unwrap/remove as we walk, which mutates the live list.
        Array.prototype.slice.call(root.children).forEach(function (node) {
            const tag = node.tagName;
            if (PASTE_DROP.has(tag)) { node.remove(); return; }
            cleanNodes(node);                    // clean descendants before deciding this node's fate
            if (!PASTE_KEEP.has(tag)) { unwrap(node); return; }
            cleanAttrs(node);
            if (tag === 'SPAN' && node.attributes.length === 0) unwrap(node); // the caret-trap wrapper
        });
    }

    function unwrap(node) {
        const parent = node.parentNode;
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
    }

    function cleanAttrs(node) {
        const allowed = PASTE_ATTRS[node.tagName] || [];
        Array.prototype.slice.call(node.attributes).forEach(function (a) {
            const name = a.name.toLowerCase();
            if (name === 'style' || name === 'class') return; // filtered below, not dropped outright
            if (allowed.indexOf(name) < 0) node.removeAttribute(a.name);
        });
        cleanStyle(node);
        cleanClass(node);
    }

    function cleanStyle(node) {
        const style = node.getAttribute('style');
        if (style == null) return;
        const kept = [];
        style.split(';').forEach(function (decl) {
            const i = decl.indexOf(':');
            if (i < 0) return;
            const prop = decl.slice(0, i).trim().toLowerCase();
            const val = decl.slice(i + 1).trim();
            if (val && keepStyle(prop, val, node.tagName)) kept.push(prop + ': ' + val);
        });
        if (kept.length) node.setAttribute('style', kept.join('; '));
        else node.removeAttribute('style');
    }

    function cleanClass(node) {
        const cls = (node.getAttribute('class') || '').split(/\s+/).filter(function (c) {
            return PASTE_CLASSES.has(c);
        });
        if (cls.length) node.setAttribute('class', cls.join(' '));
        else node.removeAttribute('class');
    }

    // ── client-side media store ──
    function genId() {
        const rand = (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID().replace(/-/g, '')
            : Math.floor(Math.random() * 1e16).toString(16);
        return 'img-' + rand.slice(0, 8);
    }

    // Guess an image MIME from magic bytes so a blob: URL built from raw bytes renders in <img>.
    function sniffMime(b) {
        if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
        if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
        if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
        if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
                && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
        if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
        return 'application/octet-stream';
    }

    function putMedia(id, blob) {
        const prev = media.get(id);
        if (prev) URL.revokeObjectURL(prev.url);
        const url = URL.createObjectURL(blob);
        media.set(id, { blob: blob, url: url });
        return url;
    }

    // Store media supplied as raw bytes (from a decrypted/imported document).
    function putMediaBytes(id, bytes) {
        return putMedia(id, new Blob([bytes], { type: sniffMime(bytes) }));
    }

    function clearMedia() {
        media.forEach(function (e) { URL.revokeObjectURL(e.url); });
        media.clear();
    }

    // The media actually referenced by the given serialized HTML, as [{ id, blob }] for saving.
    function usedMedia(html) {
        const ids = new Set();
        (html.match(/media:\/\/[A-Za-z0-9_-]+/g) || []).forEach(function (m) {
            ids.add(m.slice('media://'.length));
        });
        const out = [];
        ids.forEach(function (id) {
            const e = media.get(id);
            if (e) out.push({ id: id, blob: e.blob });
        });
        return out;
    }

    function exec(cmd) {
        focusEditor();
        document.execCommand(cmd, false, null);
    }

    // ── clear formatting ──
    // Pasted text arrives carrying the look of wherever it came from — most visibly as a link
    // (blue + underlined) or as bold/coloured/monospaced runs. This strips the selection back to
    // plain paragraph text: removeFormat drops inline styling and the presentational tags around
    // it, unlink turns links into ordinary text, formatBlock flattens headings and quote/code
    // blocks. Lists, tables and images are structure rather than styling, so they stay.
    // Returns false when there is nothing selected to act on.
    const FORMAT_BLOCKS = 'h1,h2,h3,h4,h5,h6,blockquote,pre';

    function clearFormat() {
        focusEditor();
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
        document.execCommand('removeFormat', false, null);
        document.execCommand('unlink', false, null);
        if (sel.rangeCount) {
            const range = sel.getRangeAt(0); // live: it follows the edits below
            dropDeadSpans(range);
            // Only flatten blocks when the selection actually holds one: formatBlock on a list item
            // or a table cell rearranges things we would rather leave alone.
            if (touchesFormatBlock(range)) document.execCommand('formatBlock', false, '<p>');
        }
        fireInput();
        return true;
    }

    // removeFormat can leave a span behind whose style is nothing but `initial` values — invisible,
    // but it clutters the saved HTML and is exactly the kind of wrapper the caret gets stuck inside
    // (see the paste notes above). Drop the dead declarations, then unwrap what has nothing left.
    function dropDeadSpans(range) {
        Array.prototype.slice.call(el.querySelectorAll('span')).forEach(function (span) {
            if (!range.intersectsNode(span)) return;
            pruneInitialStyle(span);
            if (span.attributes.length === 0) unwrap(span);
        });
    }

    function pruneInitialStyle(node) {
        const style = node.getAttribute('style');
        if (style == null) return;
        const kept = style.split(';').filter(function (decl) {
            const i = decl.indexOf(':');
            return i > 0 && decl.slice(i + 1).trim().toLowerCase() !== 'initial';
        }).map(function (decl) { return decl.trim(); });
        if (kept.length) node.setAttribute('style', kept.join('; ') + ';');
        else node.removeAttribute('style');
    }

    function touchesFormatBlock(range) {
        const blocks = el.querySelectorAll(FORMAT_BLOCKS);
        for (let i = 0; i < blocks.length; i++) {
            if (range.intersectsNode(blocks[i])) return true;
        }
        return false;
    }

    // ── font size ──
    // execCommand('fontSize') only speaks the seven legacy <font size> buckets — far too coarse, and
    // it writes a deprecated tag. So the browser does the hard part (splitting the selection across
    // blocks, list items, table cells and existing spans) with the largest bucket as a marker, and we
    // swap every marker for a span carrying the real size in points — the unit Word shows.
    const SIZE_MARKER = '7';
    const ZWSP = String.fromCharCode(0x200B); // written as a code point: it is invisible in source

    function setFontSize(pt) {
        focusEditor();
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        if (sel.isCollapsed) {
            startSizeAtCaret(sel, pt);
        } else {
            document.execCommand('styleWithCSS', false, false); // we want <font>, not the browser's spans
            document.execCommand('fontSize', false, SIZE_MARKER);
            const spans = [];
            el.querySelectorAll('font[size="' + SIZE_MARKER + '"]').forEach(function (f) {
                const span = document.createElement('span');
                span.style.fontSize = pt + 'pt';
                while (f.firstChild) span.appendChild(f.firstChild);
                f.parentNode.replaceChild(span, f);
                dropInnerSizes(span);           // a nested size would out-specify the one just applied
                spans.push(span);
            });
            if (spans.length) reselect(sel, spans);
        }
        fireInput();
    }

    // Nothing selected: behave like Word and set the size for whatever gets typed next. There is no
    // API for a pending style we can express in points, so plant an empty span at the caret and put
    // the caret inside it. The zero-width space is what keeps the span alive until it holds real
    // text; serialize() strips it back out.
    function startSizeAtCaret(sel, pt) {
        const span = document.createElement('span');
        span.style.fontSize = pt + 'pt';
        span.appendChild(document.createTextNode(ZWSP));
        sel.getRangeAt(0).insertNode(span);
        const r = document.createRange();
        r.setStart(span.firstChild, 1);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
    }

    function dropInnerSizes(root) {
        root.querySelectorAll('[style*="font-size"]').forEach(function (n) {
            n.style.removeProperty('font-size');
            if (!n.getAttribute('style')) n.removeAttribute('style');
            if (n.tagName === 'SPAN' && n.attributes.length === 0) unwrap(n);
        });
        root.querySelectorAll('font[size]').forEach(function (f) { f.removeAttribute('size'); });
    }

    function reselect(sel, spans) {
        const r = document.createRange();
        r.setStartBefore(spans[0]);
        r.setEndAfter(spans[spans.length - 1]); // querySelectorAll returns document order
        sel.removeAllRanges();
        sel.addRange(r);
    }

    // The size in points that applies at the caret, for the toolbar to show. It reads the computed
    // style, so it reports what a heading or a pasted block inherits, not just explicit spans.
    // (CSS pixels are 1/96 in by definition, so px -> pt is exact and zoom-independent.)
    function fontSizeAt() {
        let n = el; // no caret in the document yet: report the editor's own base size
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0);
            let c = range.startContainer;
            // A range that starts *before* a node (what a just-applied size leaves behind) has the
            // parent as its container — the size lives on the child the offset points at.
            if (c.nodeType === 1) c = c.childNodes[range.startOffset] || c;
            if (c.nodeType === 3) c = c.parentNode;
            if (c && el.contains(c)) n = c;
        }
        const px = parseFloat(window.getComputedStyle(n).fontSize);
        if (!px) return null;
        return Math.round(px * 72 / 96 * 10) / 10;
    }

    // Undo the caret placeholders: the zero-width spaces, and any span left with nothing in it
    // (a size was picked and then the user typed somewhere else).
    function stripSizePlaceholders(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        const texts = [];
        while (walker.nextNode()) texts.push(walker.currentNode);
        texts.forEach(function (t) {
            if (t.nodeValue.indexOf(ZWSP) < 0) return;
            t.nodeValue = t.nodeValue.split(ZWSP).join('');
            if (!t.nodeValue) t.remove(); // so the span around it counts as empty below
        });
        root.querySelectorAll('span').forEach(function (s) { if (!s.firstChild) s.remove(); });
    }

    // ── caret position, kept in the saved file ──
    // One number: how far into the document the caret sits, counting the characters of text, one for
    // each <br>/<img>, and one for the start of each block (so the end of one paragraph and the start
    // of the next differ). The zero-width placeholders serialize() strips aren't counted, so the
    // number measured on the live editor still fits the DOM that loading the saved HTML rebuilds.
    const CARET_BLOCKS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'TABLE', 'TR', 'TD', 'TH',
        'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE']);

    function textLen(s) {
        return s.split(ZWSP).join('').length;
    }

    function caretWeight(n) {
        if (n.nodeType === 3) return textLen(n.nodeValue);
        if (n.tagName === 'BR' || n.tagName === 'IMG') return 1;
        return CARET_BLOCKS.has(n.tagName) ? 1 : 0;
    }

    function caretWalker() {
        return document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    }

    // Where the caret is (or was last, when a toolbar button holds focus), or null.
    function caretPosition() {
        const sel = window.getSelection();
        let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
        if (!range || !el.contains(range.startContainer)) range = lastRange;
        if (!range || !el.contains(range.startContainer)) return null;
        const c = range.startContainer;
        let stop = null, endOf = null, partial = 0;
        if (c.nodeType === 3) {
            stop = c;
            partial = textLen(c.nodeValue.slice(0, range.startOffset));
        } else if (c.childNodes[range.startOffset]) {
            stop = c.childNodes[range.startOffset];  // caret sits just before this node
        } else {
            endOf = c;                               // caret at the very end of this element
        }
        let pos = 0;
        const w = caretWalker();
        while (w.nextNode()) {
            const n = w.currentNode;
            if (n === stop) break;
            if (endOf && !endOf.contains(n)
                    && (endOf.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
            pos += caretWeight(n);
        }
        return pos + partial;
    }

    // Put the caret back at a position from caretPosition() and scroll it into view.
    function restoreCaret(pos) {
        if (typeof pos !== 'number' || pos < 0) return;
        const w = caretWalker();
        let acc = 0, r = null;
        while (w.nextNode()) {
            const n = w.currentNode;
            const wt = caretWeight(n);
            if (n.nodeType === 3 && pos <= acc + wt) {
                r = document.createRange();
                r.setStart(n, textOffset(n.nodeValue, pos - acc));
                break;
            }
            if (n.nodeType === 1 && wt && acc === pos) {
                r = document.createRange();
                r.setStartBefore(n);
                break;
            }
            acc += wt;
        }
        if (!r) return; // the document is shorter than the saved position: leave the caret alone
        r.collapse(true);
        el.focus({ preventScroll: true });
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        lastRange = r.cloneRange();
        let target = r.startContainer.nodeType === 3
            ? r.startContainer.parentNode
            : r.startContainer.childNodes[r.startOffset] || r.startContainer;
        if (target.nodeType !== 1 || target.tagName === 'BR') target = target.parentNode;
        target.scrollIntoView({ block: 'center' });
    }

    // String index of the k-th counted character (ZWSPs skipped).
    function textOffset(s, k) {
        let i = 0;
        for (; i < s.length && k > 0; i++) if (s.charAt(i) !== ZWSP) k--;
        return i;
    }

    function insertHtml(html) {
        focusEditor();
        document.execCommand('insertHTML', false, html);
    }

    function insertTable(rows, cols) {
        let html = '<table class="doc-table"><tbody>';
        for (let r = 0; r < rows; r++) {
            html += '<tr>';
            for (let c = 0; c < cols; c++) html += '<td><br></td>';
            html += '</tr>';
        }
        html += '</tbody></table><p><br></p>';
        insertHtml(html);
    }

    // A section divider is plain text — a centred paragraph holding one ornament character — so it
    // costs a few bytes in the .sdoc, survives copy/paste and prints as it looks. Built from
    // insertParagraph / insertText / justifyCenter rather than insertHTML: Chrome merges an inserted
    // <p> into the paragraph at the caret (as a <span>), and execCommand steps stay on the undo stack.
    // The divider gets a line of its own: after the text at the caret, or above it when the caret
    // stands at the start of a line; typing then carries on in the line below.
    function insertDivider(symbol) {
        focusEditor();
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const block = blockAt(sel.getRangeAt(0).startContainer);
        const hasText = !!block && block.textContent.replace(/​/g, '').trim() !== '';
        const atStart = hasText && caretAtBlockStart(block, sel.getRangeAt(0));
        if (hasText) document.execCommand('insertParagraph', false, null);
        // insertParagraph at the start of a line leaves an empty line above the caret: go up into it
        if (atStart) caretInto(blockAt(sel.getRangeAt(0).startContainer).previousElementSibling, false);
        document.execCommand('insertText', false, symbol);
        document.execCommand('justifyCenter', false, null);
        const divider = blockAt(sel.getRangeAt(0).startContainer);
        if (atStart && divider && divider.nextElementSibling) {
            caretInto(divider.nextElementSibling, true);
            return;
        }
        document.execCommand('insertParagraph', false, null);
        // The new line inherits the centring; clear it so the text below starts where it did before.
        const next = blockAt(sel.getRangeAt(0).startContainer);
        if (next && next !== divider) {
            next.style.textAlign = '';
            if (!next.getAttribute('style')) next.removeAttribute('style');
        }
    }

    // The editor's direct child holding node (paragraphs, headings, lists… sit right under #editor).
    function blockAt(node) {
        while (node && node.parentNode !== el) node = node.parentNode;
        return node && node.nodeType === 1 ? node : null;
    }

    function caretAtBlockStart(block, range) {
        const r = document.createRange();
        r.selectNodeContents(block);
        r.setEnd(range.startContainer, range.startOffset);
        return r.toString().replace(/​/g, '') === '';
    }

    function caretInto(node, atStart) {
        const r = document.createRange();
        r.selectNodeContents(node);
        r.collapse(atStart);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
    }

    // ── table editing (operates on the cell containing the caret) ──
    // A selection of cells often does not start inside one: a drag begun in the text above the
    // table, Ctrl+A, or whole cells selected (the range then starts at the <tr>). Fall back to the
    // first cell the selection touches — otherwise the table buttons, Fill among them, vanish just
    // when cells have been selected to act on.
    function currentCell() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return null;
        let n = sel.getRangeAt(0).startContainer;
        while (n && n !== el) {
            if (n.nodeType === 1 && (n.tagName === 'TD' || n.tagName === 'TH')) return n;
            n = n.parentNode;
        }
        return cellsTouchedBy(liveRanges())[0] || null;
    }

    function inTable() {
        return !!currentCell();
    }

    // ── cell fill ──
    // The cells a fill applies to: every cell the selection touches (a drag across cells, or the
    // per-cell ranges Firefox makes), else the one holding the caret. Falls back to the remembered
    // range, since the colour picker's inputs take focus away from the editor.
    function selectedCells() {
        const ranges = liveRanges();
        if (!ranges.length && lastRange && el.contains(lastRange.commonAncestorContainer)) ranges.push(lastRange);
        return cellsTouchedBy(ranges);
    }

    // The selection's ranges that lie in the editor.
    function liveRanges() {
        const sel = window.getSelection();
        const ranges = [];
        for (let i = 0; sel && i < sel.rangeCount; i++) {
            const r = sel.getRangeAt(i);
            if (el.contains(r.commonAncestorContainer)) ranges.push(r);
        }
        return ranges;
    }

    function cellsTouchedBy(ranges) {
        if (!ranges.length) return [];
        const cells = Array.prototype.filter.call(el.querySelectorAll('td,th'), function (c) {
            return ranges.some(function (r) { return r.intersectsNode(c); });
        });
        // A caret in a nested table also intersects the outer cell around it — keep the innermost.
        return cells.filter(function (c) {
            return !cells.some(function (o) { return o !== c && c.contains(o); });
        });
    }

    // color: any CSS colour, or null to remove the fill. Pasted Word tables may carry the legacy
    // bgcolor attribute or the background shorthand; both go so the new fill is the only one.
    function setCellColor(cells, color) {
        cells.forEach(function (c) {
            c.removeAttribute('bgcolor');
            c.style.removeProperty('background');
            if (color) c.style.backgroundColor = color;
            else c.style.removeProperty('background-color');
            if (!c.getAttribute('style')) c.removeAttribute('style');
        });
        if (cells.length) fireInput();
    }

    // The cell's own fill as computed "rgb(r, g, b)", or null when it has none.
    function cellColor(cell) {
        return cell && cell.style.backgroundColor ? window.getComputedStyle(cell).backgroundColor : null;
    }

    function cellColorAt() {
        return cellColor(currentCell());
    }

    function cellIndex(cell) {
        return Array.prototype.indexOf.call(cell.parentNode.children, cell);
    }

    function fireInput() {
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function addRow(below) {
        const cell = currentCell();
        if (!cell) return;
        const row = cell.parentNode;
        const cols = row.children.length;
        const nr = document.createElement('tr');
        for (let i = 0; i < cols; i++) {
            const td = document.createElement('td');
            td.innerHTML = '<br>';
            nr.appendChild(td);
        }
        row.parentNode.insertBefore(nr, below ? row.nextSibling : row);
        fireInput();
    }

    function addColumn(right) {
        const cell = currentCell();
        if (!cell) return;
        const idx = cellIndex(cell);
        const table = cell.closest('table');
        table.querySelectorAll('tr').forEach(function (tr) {
            const td = document.createElement('td');
            td.innerHTML = '<br>';
            const ref = tr.children[idx];
            tr.insertBefore(td, right ? (ref ? ref.nextSibling : null) : ref);
        });
        fireInput();
    }

    function deleteRow() {
        const cell = currentCell();
        if (!cell) return;
        const table = cell.closest('table');
        if (table.querySelectorAll('tr').length <= 1) table.remove();
        else cell.parentNode.remove();
        fireInput();
    }

    function deleteColumn() {
        const cell = currentCell();
        if (!cell) return;
        const idx = cellIndex(cell);
        const table = cell.closest('table');
        const rows = table.querySelectorAll('tr');
        if (rows[0].children.length <= 1) {
            table.remove();
        } else {
            rows.forEach(function (tr) { if (tr.children[idx]) tr.children[idx].remove(); });
        }
        fireInput();
    }

    function insertImageFile(file) {
        const id = genId();
        const url = putMedia(id, file); // the File is itself a Blob, with the right MIME for display
        // data-media-id is the stable reference; src is the local blob: URL for display.
        insertHtml('<img data-media-id="' + id + '" src="' + url + '" alt="">');
    }

    // Convert live media URLs -> stable media://id before saving; strip UI-only classes.
    // The copy lives in an inert document: an <img> owned by the page fetches its src even while
    // detached, so a plain cloneNode would request media://id on every call (and this runs on every
    // dirty check).
    const inertDoc = document.implementation.createHTMLDocument('');
    function serialize() {
        const clone = inertDoc.importNode(el, true);
        clone.querySelectorAll('img[data-media-id]').forEach(function (img) {
            img.setAttribute('src', 'media://' + img.getAttribute('data-media-id'));
        });
        clone.querySelectorAll('.img-selected').forEach(function (i) {
            i.classList.remove('img-selected');
        });
        stripSizePlaceholders(clone);
        return clone.innerHTML;
    }

    // Load stored HTML; rewrite media://id -> local blob: URL (media must already be in the store).
    // Everything is prepared in an inert DOMParser document and only then moved into the editor: set
    // on the live page, the browser would first request every media://id (ERR_UNKNOWN_URL_SCHEME
    // in the console) and the content would be live before sanitize() ran.
    function load(html) {
        const doc = new DOMParser().parseFromString(html && html.trim() ? html : '<p><br></p>', 'text/html');
        doc.body.querySelectorAll('img[data-media-id]').forEach(function (img) {
            const e = media.get(img.getAttribute('data-media-id'));
            // No bytes for this id: drop the dead media:// src, keep the id so a save still writes it.
            if (e) img.setAttribute('src', e.url);
            else img.removeAttribute('src');
        });
        sanitize(doc.body);
        el.replaceChildren.apply(el, Array.prototype.slice.call(doc.body.childNodes));
        deselectImg();
    }

    // Local single-user app, but stored HTML (or imported files later) is still untrusted enough
    // to strip active content on load.
    function sanitize(root) {
        root.querySelectorAll('script,style,link,iframe,object,embed').forEach(function (n) {
            n.remove();
        });
        root.querySelectorAll('*').forEach(function (n) {
            Array.prototype.slice.call(n.attributes).forEach(function (a) {
                if (/^on/i.test(a.name)) n.removeAttribute(a.name);
            });
        });
    }

    // ── image resize (drag a corner handle) ──
    function setupImageResize() {
        handle = document.createElement('div');
        handle.className = 'img-resize-handle';
        handle.style.display = 'none';
        document.body.appendChild(handle);

        el.addEventListener('click', function (e) {
            if (e.target.tagName === 'IMG') selectImg(e.target);
            else deselectImg();
        });

        const reposition = function () { positionHandle(); };
        el.parentElement.addEventListener('scroll', reposition, true);
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);

        handle.addEventListener('mousedown', function (e) {
            if (!selectedImg) return;
            e.preventDefault();
            resizing = true;
            startX = e.clientX;
            startW = selectedImg.getBoundingClientRect().width;
        });
        document.addEventListener('mousemove', function (e) {
            if (!resizing || !selectedImg) return;
            const w = Math.max(30, startW + (e.clientX - startX));
            selectedImg.style.width = Math.round(w) + 'px';
            selectedImg.style.height = 'auto';
            positionHandle();
        });
        document.addEventListener('mouseup', function () {
            if (resizing) {
                resizing = false;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    }

    function selectImg(img) {
        deselectImg();
        selectedImg = img;
        img.classList.add('img-selected');
        handle.style.display = 'block';
        positionHandle();
    }

    function deselectImg() {
        if (selectedImg) selectedImg.classList.remove('img-selected');
        selectedImg = null;
        if (handle) handle.style.display = 'none';
    }

    function positionHandle() {
        if (!selectedImg || handle.style.display === 'none') return;
        const r = selectedImg.getBoundingClientRect();
        handle.style.left = (window.scrollX + r.right - 7) + 'px';
        handle.style.top = (window.scrollY + r.bottom - 7) + 'px';
    }

    return {
        init: init,
        exec: exec,
        clearFormat: clearFormat,
        setFontSize: setFontSize,
        fontSizeAt: fontSizeAt,
        insertTable: insertTable,
        insertDivider: insertDivider,
        inTable: inTable,
        selectedCells: selectedCells,
        setCellColor: setCellColor,
        cellColor: cellColor,
        cellColorAt: cellColorAt,
        focus: focusEditor,
        addRow: addRow,
        addColumn: addColumn,
        deleteRow: deleteRow,
        deleteColumn: deleteColumn,
        insertImageFile: insertImageFile,
        putMediaBytes: putMediaBytes,
        clearMedia: clearMedia,
        usedMedia: usedMedia,
        serialize: serialize,
        caretPosition: caretPosition,
        restoreCaret: restoreCaret,
        load: load
    };
})();
