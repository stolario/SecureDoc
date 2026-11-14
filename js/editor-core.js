'use strict';
// The contenteditable rich-text editor core (DESIGN.md §7, §12), shared verbatim by SecureDoc (js/)
// and the Documents section of webchat (static/js/). Edit it in SecureDoc only, then copy it with
// scripts/sync-webchat.ps1 -Copy. It holds every editing command and the media store, and nothing
// of either app's UI: toolbars, dialogs and saving call it. Formatting uses document.execCommand;
// what may end up in the document is decided by DocHtml (doc-html.js). Images live in a client-side
// media store (id -> Blob) and are shown via blob: URLs; the saved HTML references them by a stable
// media://<id>. The bytes exist only in this page until a save encrypts them into the .sdoc.
//
//   Editor.init(element, { acceptImage(file) -> boolean })   once, before anything else
// Every edit dispatches an `input` event on the element, so the app's dirty tracking sees it.
window.Editor = (function () {
    let el = null;
    // The app's veto on an image about to be inserted (a size limit, say): false keeps it out.
    let acceptImage = function () { return true; };

    // media id -> { blob, url }. The blob is the raw image; url is an object URL for display.
    const media = new Map();

    // ── image resize state ──
    let selectedImg = null;
    let handle = null;
    let resizing = false;
    let startX = 0;
    let startW = 0;

    function init(editorEl, options) {
        if (el) {
            throw new Error('Editor.init: already initialised');
        }
        el = editorEl;
        if (options && typeof options.acceptImage === 'function') {
            acceptImage = options.acceptImage;
        }
        setupImageResize();
        setupTabKey();
        setupQuoteExit();
        setupPaste();
        setupMathHistory();
        setupDividerEditing();
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
            if (!selectionOwned()) { return; }
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) { return; }
            const r = sel.getRangeAt(0);
            if (el.contains(r.commonAncestorContainer)) { lastRange = r.cloneRange(); }
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
        if (!sel) { return; }
        if (sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer)) { return; }
        if (lastRange && el.contains(lastRange.commonAncestorContainer)) {
            sel.removeAllRanges();
            sel.addRange(lastRange);
        }
    }

    // Tab inserts a tab character (instead of moving focus out of the editor); Shift+Tab removes a
    // preceding tab. The editor CSS uses white-space: pre-wrap + tab-size so the tab renders.
    function setupTabKey() {
        el.addEventListener('keydown', function (e) {
            if (e.key !== 'Tab') { return; }
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
        if (!sel || !sel.rangeCount) { return; }
        const range = sel.getRangeAt(0);
        if (!range.collapsed) { return; }
        const node = range.startContainer;
        if (node.nodeType === 3 && range.startOffset > 0
                && node.nodeValue.charAt(range.startOffset - 1) === '\t') {
            document.execCommand('delete');
        }
    }

    // Chrome continues an empty blockquote as another blockquote, so a document can end up with no
    // keyboard route back to ordinary body text. Keep the familiar two-Enter behaviour: the first
    // Enter creates an empty quote line; Enter on that empty line replaces it with a plain paragraph.
    function setupQuoteExit() {
        el.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) { return; }
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || !sel.isCollapsed) { return; }
            const range = sel.getRangeAt(0);
            const quote = closestElement(range.startContainer, 'BLOCKQUOTE');
            if (!quote || !el.contains(quote)) { return; }

            // A quote loaded from HTML commonly contains several <p>/<div> children. In that shape
            // the empty line is only one child; testing quote.textContent sees the earlier paragraphs
            // and makes the caret impossible to escape. Find the direct child holding the caret and
            // test/remove that line alone.
            let line = range.startContainer;
            while (line && line !== quote && line.parentNode !== quote) { line = line.parentNode; }
            if (!line || line === quote) { line = quote; }
            const text = line.textContent.replace(/\u200b/g, '').trim();
            if (text || (line.querySelector && line.querySelector('img,table,hr,math'))) { return; }

            e.preventDefault();
            const paragraph = document.createElement('p');
            paragraph.appendChild(document.createElement('br'));
            quote.parentNode.insertBefore(paragraph, quote.nextSibling);
            if (line !== quote) { line.remove(); }
            const quoteText = quote.textContent.replace(/\u200b/g, '').trim();
            if (line === quote || (!quoteText && !quote.querySelector('img,table,hr,math'))) { quote.remove(); }
            caretInto(paragraph, true);
            fireInput();
        });
    }

    function closestElement(node, tagName) {
        if (node && node.nodeType !== 1) { node = node.parentElement; }
        while (node && node !== el) {
            if (node.tagName === tagName) { return node; }
            node = node.parentElement;
        }
        return null;
    }

    // ── paste and drop ──
    // Pasting from a web page (or Word) dumps the source HTML with all its inline styling. The worst
    // offender is background-color: it paints a box behind the pasted text AND leaves a styled <span>
    // that the caret gets stuck inside. DocHtml.paste (js/doc-html.js, shared with webchat) keeps only
    // what the editor itself can express; DocHtml.pasteAction decides between formula text, an
    // image's bytes, HTML and plain text. Dropping something dragged in from outside the editor (a
    // file, a selection from another page) goes the same way; a drag within the editor just moves
    // text that is already clean, so the browser keeps doing it.
    let draggingInside = false;

    function setupPaste() {
        el.addEventListener('paste', function (e) {
            const action = DocHtml.pasteAction(e.clipboardData || window.clipboardData);
            if (!action) { return; } // no clipboard access — let the browser do its default thing
            e.preventDefault();
            insertTransfer(action);
        });
        el.addEventListener('dragstart', function () { draggingInside = true; });
        document.addEventListener('dragend', function () { draggingInside = false; });
        el.addEventListener('drop', function (e) {
            if (draggingInside) {
                draggingInside = false;
                return;
            }
            const action = DocHtml.pasteAction(e.dataTransfer);
            e.preventDefault(); // never let the browser insert foreign markup or open a dropped file
            if (!action) {
                return;
            }
            const at = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
            if (at && el.contains(at.startContainer)) {
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(at);
            } else {
                focusEditor();
            }
            insertTransfer(action);
        });
        // Backstop for markup that reaches the editor some other way (spellcheck replacement, an
        // extension, a browser quirk): a link that is not on the allow-list never stays live.
        el.addEventListener('input', function () {
            el.querySelectorAll('a').forEach(function (link) {
                if (!secureLink(link)) {
                    unwrap(link);
                }
            });
        });
    }

    function insertTransfer(action) {
        if (action.kind === 'text') {
            document.execCommand('insertText', false, action.text);
        } else if (action.kind === 'image') {
            try {
                if (!insertImageFile(action.file)) {
                    return;
                }
            } catch (err) {
                return;
            }
        } else {
            insertHtml(DocHtml.paste(action.html, mediaUrl));
            DocHtml.adoptPastedImages(el, function (blob) {
                const id = genId();
                return { id: id, url: putMedia(id, blob) };
            }, fireInput);
        }
        fireInput();
    }

    function unwrap(node) {
        const parent = node.parentNode;
        while (node.firstChild) { parent.insertBefore(node.firstChild, node); }
        parent.removeChild(node);
    }

    // ── client-side media store ──
    const genId = DocHtml.newMediaId;
    const sniffMime = DocHtml.imageMime;

    // The display URL of a stored image, for DocHtml.load / DocHtml.paste.
    function mediaUrl(id) {
        const e = media.get(id);
        return e ? e.url : null;
    }

    function putMedia(id, blob) {
        const prev = media.get(id);
        if (prev) { URL.revokeObjectURL(prev.url); }
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
            if (e) { out.push({ id: id, blob: e.blob }); }
        });
        return out;
    }

    function exec(cmd) {
        focusEditor();
        document.execCommand(cmd, false, null);
    }

    // ── hyperlinks ──
    // Newly entered links and untrusted saved/pasted HTML use the same allow-list, so a document
    // cannot smuggle an active javascript: URL into the editor.
    const normalizeLinkUrl = DocHtml.normalizeLinkUrl;
    const secureLink = DocHtml.secureLink;

    function linkAncestor(node) {
        if (!node) { return null; }
        if (node.nodeType === 3) { node = node.parentNode; }
        const link = node && node.closest ? node.closest('a') : null;
        return link && el.contains(link) ? link : null;
    }

    // A selection can become a new link; a collapsed caret is useful only when it already sits in
    // a link that can be edited.
    function linkInfo() {
        focusEditor();
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) { return null; }
        const range = sel.getRangeAt(0);
        if (!el.contains(range.commonAncestorContainer)) { return null; }
        const link = linkAncestor(range.startContainer);
        if (range.collapsed && !link) { return null; }
        return {
            href: link ? (link.getAttribute('href') || '') : range.toString().trim(),
            existing: !!link
        };
    }


    function setLink(raw) {
        const href = normalizeLinkUrl(raw);
        if (!href) { return false; }
        focusEditor();
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) { return false; }
        const range = sel.getRangeAt(0);
        if (!el.contains(range.commonAncestorContainer)) { return false; }
        const existing = linkAncestor(range.startContainer);
        if (range.collapsed) {
            if (!existing) { return false; }
            secureLink(existing, href);
        } else {
            document.execCommand('createLink', false, href);
            // A selection crossing blocks can produce several anchors. Apply the safe navigation
            // attributes to every fragment touched by the live selection.
            const current = sel.rangeCount ? sel.getRangeAt(0) : range;
            el.querySelectorAll('a').forEach(function (link) {
                if (current.intersectsNode(link)) { secureLink(link, href); }
            });
        }
        fireInput();
        return true;
    }

    function removeLink() {
        focusEditor();
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) { return false; }
        const range = sel.getRangeAt(0);
        if (!el.contains(range.commonAncestorContainer)) { return false; }
        const existing = linkAncestor(range.startContainer);
        if (range.collapsed && existing) {
            const all = document.createRange();
            all.selectNodeContents(existing);
            sel.removeAllRanges();
            sel.addRange(all);
        }
        document.execCommand('unlink', false, null);
        if (sel.rangeCount) { sel.collapseToEnd(); }
        fireInput();
        return true;
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
        if (!sel || !sel.rangeCount || sel.isCollapsed) { return false; }
        document.execCommand('removeFormat', false, null);
        document.execCommand('unlink', false, null);
        if (sel.rangeCount) {
            const range = sel.getRangeAt(0); // live: it follows the edits below
            dropDeadSpans(range);
            // Only flatten blocks when the selection actually holds one: formatBlock on a list item
            // or a table cell rearranges things we would rather leave alone.
            if (touchesFormatBlock(range)) { document.execCommand('formatBlock', false, '<p>'); }
        }
        fireInput();
        return true;
    }

    // removeFormat can leave a span behind whose style is nothing but `initial` values — invisible,
    // but it clutters the saved HTML and is exactly the kind of wrapper the caret gets stuck inside
    // (see the paste notes above). Drop the dead declarations, then unwrap what has nothing left.
    function dropDeadSpans(range) {
        Array.prototype.slice.call(el.querySelectorAll('span')).forEach(function (span) {
            if (!range.intersectsNode(span)) { return; }
            pruneInitialStyle(span);
            if (span.attributes.length === 0) { unwrap(span); }
        });
    }

    function pruneInitialStyle(node) {
        const style = node.getAttribute('style');
        if (style == null) { return; }
        const kept = style.split(';').filter(function (decl) {
            const i = decl.indexOf(':');
            return i > 0 && decl.slice(i + 1).trim().toLowerCase() !== 'initial';
        }).map(function (decl) { return decl.trim(); });
        if (kept.length) { node.setAttribute('style', kept.join('; ') + ';'); }
        else { node.removeAttribute('style'); }
    }

    function touchesFormatBlock(range) {
        const blocks = el.querySelectorAll(FORMAT_BLOCKS);
        for (let i = 0; i < blocks.length; i++) {
            if (range.intersectsNode(blocks[i])) { return true; }
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
        if (!sel || !sel.rangeCount) { return; }
        if (sel.isCollapsed) {
            startSizeAtCaret(sel, pt);
        } else {
            document.execCommand('styleWithCSS', false, false); // we want <font>, not the browser's spans
            document.execCommand('fontSize', false, SIZE_MARKER);
            const spans = [];
            el.querySelectorAll('font[size="' + SIZE_MARKER + '"]').forEach(function (f) {
                const span = document.createElement('span');
                span.style.fontSize = pt + 'pt';
                while (f.firstChild) { span.appendChild(f.firstChild); }
                f.parentNode.replaceChild(span, f);
                dropInnerSizes(span);           // a nested size would out-specify the one just applied
                spans.push(span);
            });
            if (spans.length) { reselect(sel, spans); }
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
            if (!n.getAttribute('style')) { n.removeAttribute('style'); }
            if (n.tagName === 'SPAN' && n.attributes.length === 0) { unwrap(n); }
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
            if (c.nodeType === 1) { c = c.childNodes[range.startOffset] || c; }
            if (c.nodeType === 3) { c = c.parentNode; }
            if (c && el.contains(c)) { n = c; }
        }
        const px = parseFloat(window.getComputedStyle(n).fontSize);
        if (!px) { return null; }
        return Math.round(px * 72 / 96 * 10) / 10;
    }

    // Undo the caret placeholders: the zero-width spaces, and any span left with nothing in it
    // (a size was picked and then the user typed somewhere else).
    function stripSizePlaceholders(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        const texts = [];
        while (walker.nextNode()) { texts.push(walker.currentNode); }
        texts.forEach(function (t) {
            if (t.nodeValue.indexOf(ZWSP) < 0) { return; }
            t.nodeValue = t.nodeValue.split(ZWSP).join('');
            if (!t.nodeValue) { t.remove(); } // so the span around it counts as empty below
        });
        root.querySelectorAll('span').forEach(function (s) {
            if (!s.firstChild) { s.remove(); }
        });
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
        if (n.nodeType === 3) { return textLen(n.nodeValue); }
        if (n.tagName === 'BR' || n.tagName === 'IMG') { return 1; }
        return CARET_BLOCKS.has(n.tagName) ? 1 : 0;
    }

    function caretWalker() {
        return document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    }

    // Where the caret is (or was last, when a toolbar button holds focus), or null.
    function caretPosition() {
        const sel = window.getSelection();
        let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
        if (!range || !el.contains(range.startContainer)) { range = lastRange; }
        if (!range || !el.contains(range.startContainer)) { return null; }
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
            if (n === stop) { break; }
            if (endOf && !endOf.contains(n)
                    && (endOf.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
            pos += caretWeight(n);
        }
        return pos + partial;
    }

    // Put the caret back at a position from caretPosition() and scroll it into view.
    function restoreCaret(pos) {
        if (typeof pos !== 'number' || pos < 0) { return; }
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
        if (!r) { return; } // the document is shorter than the saved position: leave the caret alone
        r.collapse(true);
        el.focus({ preventScroll: true });
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        lastRange = r.cloneRange();
        let target = r.startContainer.nodeType === 3
            ? r.startContainer.parentNode
            : r.startContainer.childNodes[r.startOffset] || r.startContainer;
        if (target.nodeType !== 1 || target.tagName === 'BR') { target = target.parentNode; }
        target.scrollIntoView({ block: 'center' });
    }

    // String index of the k-th counted character (ZWSPs skipped).
    function textOffset(s, k) {
        let i = 0;
        for (; i < s.length && k > 0; i++) {
            if (s.charAt(i) !== ZWSP) { k--; }
        }
        return i;
    }

    // insertHTML keeps the undo stack, but Chrome "preserves the look" of what it inserts: it lays the
    // fragment out once inside the editor's root, and wherever that differs from the insertion point
    // (a paragraph with its own colour or font) it wraps the new text in <span style="color: …;
    // font-family: …"> and writes the same into the inserted elements' own style. Those spans trap
    // the caret and would be saved. Changing the DOM afterwards would fall outside the undo stack, so
    // instead, just for the insert, the root takes on the computed style at the insertion point:
    // nothing differs, nothing is added, and pasted text takes on the look of where it lands.
    const LOOK = ['color', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant',
        'letter-spacing', 'word-spacing', 'text-transform', 'line-height', 'white-space', 'text-indent'];

    // insertHTML also tears MathML apart: Chrome re-lays each piece of a <math> out as styled text, so
    // a pasted fraction a/b came out as "a" in a <span> on this line and the rest at the end of the
    // document or split across paragraphs. So every <math> goes in as an empty placeholder <img> —
    // which the command leaves alone — and is put back in its place right after. The command still
    // inserts the surrounding paragraphs, so the paste stays one step on the undo stack.
    // The browser's history, though, remembers the placeholders, not the formulas: undoing an inline
    // paste would remove a placeholder no longer there and leave the formula behind. So each pasted
    // formula is kept with its placeholder (mathSlots), and around every undo/redo the formulas step
    // aside for the very placeholders the history knows, then come back once the browser is done.
    const MATH_SLOT = 'data-math-slot';
    const mathSlots = new Map(); // placeholder <img> -> its <math>

    function mathsToSlots() {
        mathSlots.forEach(function (math, slot) {
            if (el.contains(math)) {
                math.replaceWith(slot);
            }
        });
    }

    function slotsToMaths() {
        mathSlots.forEach(function (math, slot) {
            if (el.contains(slot)) {
                slot.replaceWith(math);
            }
        });
    }

    function setupMathHistory() {
        const history = function (e) {
            return e.inputType === 'historyUndo' || e.inputType === 'historyRedo';
        };
        el.addEventListener('beforeinput', function (e) {
            if (history(e)) {
                mathsToSlots();
            }
        });
        el.addEventListener('input', function (e) {
            if (history(e)) {
                slotsToMaths();
            }
            lockDividers(); // after any edit, undo/redo included
            caretOutOfDivider();
            setTimeout(caretOutOfDivider, 0); // undo/redo place the caret only after this event
        });
    }

    function withMathSlots(html, maths) {
        if (!/<math[\s>]/i.test(html)) {
            return html;
        }
        const tpl = document.createElement('template'); // inert: nothing in it loads or runs
        tpl.innerHTML = html;
        tpl.content.querySelectorAll('math').forEach(function (math) {
            const slot = document.createElement('img');
            slot.setAttribute(MATH_SLOT, String(maths.length));
            slot.setAttribute('alt', '');
            maths.push(math);
            math.replaceWith(slot);
        });
        return tpl.innerHTML;
    }

    function fillMathSlots(maths) {
        el.querySelectorAll('img[' + MATH_SLOT + ']').forEach(function (slot) {
            if (mathSlots.has(slot)) {
                return; // an earlier paste's placeholder, put back by undo/redo: slotsToMaths' job
            }
            const math = maths[Number(slot.getAttribute(MATH_SLOT))];
            if (math) {
                const live = document.importNode(math, true);
                mathSlots.set(slot, live);
                slot.replaceWith(live);
            } else {
                slot.remove();
            }
        });
    }

    function insertHtml(html) {
        const maths = [];
        html = withMathSlots(html, maths);
        focusEditor();
        const sel = window.getSelection();
        let at = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : el;
        if (at.nodeType !== 1) {
            at = at.parentNode;
        }
        const own = el.getAttribute('style');
        if (at && el.contains(at) && at !== el) {
            const look = window.getComputedStyle(at);
            LOOK.forEach(function (prop) { el.style.setProperty(prop, look.getPropertyValue(prop)); });
        }
        try {
            document.execCommand('insertHTML', false, html);
        } finally {
            if (own == null) {
                el.removeAttribute('style');
            } else {
                el.setAttribute('style', own);
            }
            if (maths.length) {
                fillMathSlots(maths);
            }
            lockDividers(); // a pasted divider (copied within the app) is one too
        }
    }

    function insertTable(rows, cols) {
        let html = '<table class="doc-table"><tbody>';
        for (let r = 0; r < rows; r++) {
            html += '<tr>';
            for (let c = 0; c < cols; c++) { html += '<td><br></td>'; }
            html += '</tr>';
        }
        html += '</tbody></table><p><br></p>';
        insertHtml(html);
    }

    // A section divider is plain text — <p class="doc-divider" style="text-align: center">, the
    // shared contract (doc-html.js) — so it costs a few bytes in the .sdoc, survives copy/paste,
    // reads as a centred line even without the app's CSS and prints as it looks. Built from
    // insertParagraph / insertText / justifyCenter rather than insertHTML: Chrome merges an inserted
    // <p> into the paragraph at the caret (as a <span>), and execCommand steps stay on the undo stack.
    // The divider gets a line of its own: after the text at the caret, or above it when the caret
    // stands at the start of a line; typing then carries on in the line below.
    function insertDivider(symbol) {
        focusEditor();
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) { return; }
        const block = blockAt(sel.getRangeAt(0).startContainer);
        const hasText = !!block && block.textContent.replace(/​/g, '').trim() !== '';
        const atStart = hasText && caretAtBlockStart(block, sel.getRangeAt(0));
        if (hasText) { document.execCommand('insertParagraph', false, null); }
        // insertParagraph at the start of a line leaves an empty line above the caret: go up into it
        if (atStart) { caretInto(blockAt(sel.getRangeAt(0).startContainer).previousElementSibling, false); }
        document.execCommand('insertText', false, symbol);
        if (!blockAt(sel.getRangeAt(0).startContainer)) { // Firefox types into a bare editor without a paragraph
            document.execCommand('formatBlock', false, '<p>');
        }
        // Centred directly, not with justifyCenter: Firefox writes that as align="center", which every
        // new line then inherits — all text after a divider came out centred there.
        const markDivider = function (p) {
            if (!p) { return; }
            p.classList.add('doc-divider');
            p.removeAttribute('align');
            p.style.textAlign = 'center';
        };
        if (atStart) {
            const above = blockAt(sel.getRangeAt(0).startContainer);
            markDivider(above);
            if (above && above.nextElementSibling) { caretInto(above.nextElementSibling, true); }
            lockDividers();
            return;
        }
        // Split the line before marking the divider, never after: with the caret in the middle of a
        // line the text that follows it still sits on the divider's line, and marking first left that
        // text centred (and locked) as part of the ornament.
        document.execCommand('insertParagraph', false, null);
        let next = blockAt(sel.getRangeAt(0).startContainer);
        let divider = next ? next.previousElementSibling : null;
        const isSymbol = function (p) {
            return !!p && p.textContent.replace(/​/g, '').trim() === symbol;
        };
        if (!isSymbol(divider) && isSymbol(next)) { // a browser that leaves the caret in the first half
            divider = next;
            next = divider.nextElementSibling;
            if (next) { caretInto(next, true); }
        }
        markDivider(divider);
        // The new line can inherit the centring; clear it so the text below starts where it did before.
        if (next && next !== divider) {
            next.removeAttribute('align');
            next.style.textAlign = '';
            if (!next.getAttribute('style')) { next.removeAttribute('style'); }
            next.classList.remove('doc-divider'); // insertParagraph copies the class as well
            if (!next.getAttribute('class')) { next.removeAttribute('class'); }
        }
        lockDividers();
    }

    // In the editor a divider is one indivisible ornament, not a line of text. It carries its own
    // class (large Georgia, centred), and as an ordinary paragraph that class leaked into the text:
    // Enter inside it split class and centring onto the new line, and Backspace on the line below
    // glued that line's text into it. contenteditable="false" keeps the caret out, so Backspace now
    // removes the divider whole (undo brings it back). Editor-only state: DocHtml.store rebuilds from
    // its allow-list, which has no contenteditable. A divider left empty (undoing its insert, say)
    // turns back into a plain empty line, so nothing remains that can't be typed into.
    function lockDividers() {
        el.querySelectorAll('p.doc-divider').forEach(function (p) {
            if (p.textContent.replace(/​/g, '').trim() === '') {
                p.classList.remove('doc-divider');
                if (!p.getAttribute('class')) { p.removeAttribute('class'); }
                p.style.textAlign = '';
                if (!p.getAttribute('style')) { p.removeAttribute('style'); }
                p.removeAttribute('contenteditable');
                if (!p.firstChild) { p.appendChild(document.createElement('br')); }
            } else if (p.getAttribute('contenteditable') !== 'false') {
                p.setAttribute('contenteditable', 'false');
            }
        });
    }

    // Around a locked divider the browser's own editing goes wrong: Backspace on the line below took
    // that line along with the divider (and what was typed next landed outside any paragraph), and a
    // click on it left a selection that keystrokes cannot reach. So Backspace at the start of the line
    // below (Delete at the end of the line above) turns just the divider into an empty line — the next
    // Backspace removes that line as usual — and the caret stays put; a click on a divider puts the
    // caret at the start of the line below. Chrome's own delete of the selected divider would merge
    // the lines on either side into one; replacing it with an empty paragraph keeps them apart and is
    // one undoable step. Where the divider is the first line, Chrome refuses any command on it, so it
    // is replaced directly (that one step is then not on the undo stack).
    function setupDividerEditing() {
        el.addEventListener('keydown', function (e) {
            // A key that types, with the caret still inside a divider: type on the line below.
            if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key.length === 1 || e.key === 'Enter')) {
                caretOutOfDivider();
            }
            if ((e.key !== 'Backspace' && e.key !== 'Delete') || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) {
                return;
            }
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || !sel.isCollapsed) { return; }
            const range = sel.getRangeAt(0);
            const block = blockAt(range.startContainer);
            if (!block) { return; }
            const back = e.key === 'Backspace';
            const divider = back ? block.previousElementSibling : block.nextElementSibling;
            if (!divider || !divider.classList.contains('doc-divider')) { return; }
            if (back ? !caretAtBlockStart(block, range) : !caretAtBlockEnd(block, range)) { return; }
            e.preventDefault();
            if (divider.previousElementSibling) {
                const r = document.createRange();
                r.selectNode(divider);
                sel.removeAllRanges();
                sel.addRange(r);
                document.execCommand('insertHTML', false, '<p><br></p>');
            }
            if (el.contains(divider)) { // first line, or the command did nothing
                const line = document.createElement('p');
                line.appendChild(document.createElement('br'));
                divider.replaceWith(line);
                fireInput();
            }
            if (el.contains(block)) { caretInto(block, back); }
        });
        el.addEventListener('mousedown', function (e) {
            const divider = e.target && e.target.closest ? e.target.closest('p.doc-divider') : null;
            if (!divider || !el.contains(divider)) { return; }
            e.preventDefault();
            el.focus();
            let next = divider.nextElementSibling;
            if (!next) {
                next = document.createElement('p');
                next.appendChild(document.createElement('br'));
                divider.after(next);
            }
            caretInto(next, true);
        });
    }

    // Undo can leave the caret inside a locked divider, where keystrokes go nowhere: put it at the
    // start of the line below instead (a new empty line if the divider is the last one).
    // The same when it sits in the editor root right beside a divider (where undo leaves it too): Chrome
    // then types nothing and WebKit types outside any paragraph.
    function caretOutOfDivider() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) { return; }
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        const isDivider = function (n) {
            return !!n && n.nodeType === 1 && n.classList.contains('doc-divider');
        };
        let divider = null;
        if (node === el) {
            const before = el.childNodes[range.startOffset - 1];
            const after = el.childNodes[range.startOffset];
            if (!isDivider(before) && !isDivider(after)) { return; }
            if (after && after.nodeType === 1 && !isDivider(after)) {
                caretInto(after, true);
                return;
            }
            divider = isDivider(before) ? before : after;
        } else {
            const start = node.nodeType === 1 ? node : node.parentNode;
            divider = start && start.closest ? start.closest('p.doc-divider') : null;
        }
        if (!divider || !el.contains(divider)) { return; }
        let next = divider.nextElementSibling;
        if (!next) {
            next = document.createElement('p');
            next.appendChild(document.createElement('br'));
            divider.after(next);
        }
        caretInto(next, true);
    }

    function caretAtBlockEnd(block, range) {
        const r = document.createRange();
        r.selectNodeContents(block);
        r.setStart(range.endContainer, range.endOffset);
        return r.toString().replace(/​/g, '') === '';
    }

    // The editor's direct child holding node (paragraphs, headings, lists… sit right under #editor).
    function blockAt(node) {
        while (node && node.parentNode !== el) { node = node.parentNode; }
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
        if (!sel || !sel.rangeCount) { return null; }
        let n = sel.getRangeAt(0).startContainer;
        while (n && n !== el) {
            if (n.nodeType === 1 && (n.tagName === 'TD' || n.tagName === 'TH')) { return n; }
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
        if (!ranges.length && lastRange && el.contains(lastRange.commonAncestorContainer)) { ranges.push(lastRange); }
        return cellsTouchedBy(ranges);
    }

    // The selection's ranges that lie in the editor.
    function liveRanges() {
        const sel = window.getSelection();
        const ranges = [];
        for (let i = 0; sel && i < sel.rangeCount; i++) {
            const r = sel.getRangeAt(i);
            if (el.contains(r.commonAncestorContainer)) { ranges.push(r); }
        }
        return ranges;
    }

    function cellsTouchedBy(ranges) {
        if (!ranges.length) { return []; }
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
            if (color) { c.style.backgroundColor = color; }
            else { c.style.removeProperty('background-color'); }
            if (!c.getAttribute('style')) { c.removeAttribute('style'); }
        });
        if (cells.length) { fireInput(); }
    }

    // The cell's own fill as computed "rgb(r, g, b)", or null when it has none.
    function cellColor(cell) {
        return cell && cell.style.backgroundColor ? window.getComputedStyle(cell).backgroundColor : null;
    }

    function cellColorAt() {
        return cellColor(currentCell());
    }

    function tableRadiusAt() {
        const cell = currentCell() || (lastRange && el.contains(lastRange.commonAncestorContainer)
            ? (lastRange.startContainer.nodeType === 1 ? lastRange.startContainer : lastRange.startContainer.parentElement).closest('td,th')
            : null);
        const table = cell && cell.closest('table');
        return table ? DocHtml.tableRadius(table) : 0;
    }

    function setTableRadius(radius) {
        const cell = currentCell() || (lastRange && el.contains(lastRange.commonAncestorContainer)
            ? (lastRange.startContainer.nodeType === 1 ? lastRange.startContainer : lastRange.startContainer.parentElement).closest('td,th')
            : null);
        const table = cell && cell.closest('table');
        if (!table) { return false; }
        DocHtml.setTableRadius(table, radius);
        fireInput();
        return true;
    }

    function cellIndex(cell) {
        return Array.prototype.indexOf.call(cell.parentNode.children, cell);
    }

    function fireInput() {
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function addRow(below) {
        const cell = currentCell();
        if (!cell) { return; }
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
        if (!cell) { return; }
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
        if (!cell) { return; }
        const table = cell.closest('table');
        if (table.querySelectorAll('tr').length <= 1) { table.remove(); }
        else { cell.parentNode.remove(); }
        fireInput();
    }

    function deleteColumn() {
        const cell = currentCell();
        if (!cell) { return; }
        const idx = cellIndex(cell);
        const table = cell.closest('table');
        const rows = table.querySelectorAll('tr');
        if (rows[0].children.length <= 1) {
            table.remove();
        } else {
            rows.forEach(function (tr) {
                if (tr.children[idx]) { tr.children[idx].remove(); }
            });
        }
        fireInput();
    }

    // -> false when the app's acceptImage refused the file (it says why itself).
    function insertImageFile(file) {
        if (!acceptImage(file)) {
            return false;
        }
        const id = genId();
        const url = putMedia(id, file); // the File is itself a Blob, with the right MIME for display
        // data-media-id is the stable reference; src is the local blob: URL for display.
        insertHtml('<img data-media-id="' + id + '" src="' + url + '" alt="">');
        return true;
    }

    // Editor DOM -> stored HTML (DocHtml.store: allow-list, media://id, table radius). UI-only state
    // (the selected image's class, the font-size caret placeholders) goes first. The copy lives in an
    // inert document: an <img> owned by the page fetches its src even while detached.
    const inertDoc = document.implementation.createHTMLDocument('');
    function serialize() {
        const clone = inertDoc.importNode(el, true);
        clone.querySelectorAll('.img-selected').forEach(function (i) {
            i.classList.remove('img-selected');
            if (!i.getAttribute('class')) { i.removeAttribute('class'); }
        });
        stripSizePlaceholders(clone);
        return DocHtml.store(clone.innerHTML);
    }

    // Stored HTML -> editor. A .sdoc may come from someone else: DocHtml.load rebuilds it from the
    // allow-list (nothing may run code, reach the network or restyle the page; the CSP in index.html
    // backs this up) and points media://id at the local blob: URL (media must already be stored).
    // The result is parsed inertly and only then moved into the editor.
    function load(html) {
        const doc = new DOMParser().parseFromString(DocHtml.load(html, mediaUrl), 'text/html');
        el.replaceChildren.apply(el, Array.prototype.slice.call(doc.body.childNodes));
        lockDividers();
        mathSlots.clear();
        deselectImg();
    }

    // ── image resize (drag a corner handle) ──
    function setupImageResize() {
        handle = document.createElement('div');
        handle.className = 'img-resize-handle';
        handle.style.display = 'none';
        document.body.appendChild(handle);

        el.addEventListener('click', function (e) {
            if (e.target.tagName === 'IMG') { selectImg(e.target); }
            else { deselectImg(); }
        });

        const reposition = function () { positionHandle(); };
        el.parentElement.addEventListener('scroll', reposition, true);
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);

        handle.addEventListener('mousedown', function (e) {
            if (!selectedImg) { return; }
            e.preventDefault();
            resizing = true;
            startX = e.clientX;
            startW = selectedImg.getBoundingClientRect().width;
        });
        document.addEventListener('mousemove', function (e) {
            if (!resizing || !selectedImg) { return; }
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
        if (selectedImg) { selectedImg.classList.remove('img-selected'); }
        selectedImg = null;
        if (handle) { handle.style.display = 'none'; }
    }

    function positionHandle() {
        if (!selectedImg || handle.style.display === 'none') { return; }
        const r = selectedImg.getBoundingClientRect();
        handle.style.left = (window.scrollX + r.right - 7) + 'px';
        handle.style.top = (window.scrollY + r.bottom - 7) + 'px';
    }

    return {
        init: init,
        exec: exec,
        linkInfo: linkInfo,
        normalizeLinkUrl: normalizeLinkUrl,
        setLink: setLink,
        removeLink: removeLink,
        clearFormat: clearFormat,
        setFontSize: setFontSize,
        fontSizeAt: fontSizeAt,
        insertTable: insertTable,
        insertDivider: insertDivider,
        inTable: inTable,
        selectedCells: selectedCells,
        setCellColor: setCellColor,
        tableRadiusAt: tableRadiusAt,
        setTableRadius: setTableRadius,
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
