'use strict';
// The HTML contract of a .sdoc document (content.html), shared verbatim by SecureDoc (js/) and the
// Documents section of webchat (static/js/). Edit it in SecureDoc only, then copy it with
// scripts/sync-webchat.ps1 -Copy (DESIGN.md §12); without -Copy the script, and webchat's Gradle check, fail while the copies
// differ. Nothing here touches either app's UI; the editors only decide when to call it.
//
// A .sdoc may come from someone else, so its HTML is untrusted. Every path into the editor — opening
// a file, pasting, saving — rebuilds the markup from an allow-list in an inert document: elements,
// attributes, classes and inline style declarations are copied only when they are on the list and
// their value has the expected shape. The formatting both editors and the DOCX import write survives;
// anything that could run code, load a URL, submit a form or restyle the page around the editor
// does not. Opening a document must never tell anyone that it was opened (each app's CSP backs this).
//
//   DocHtml.load(html, mediaUrl)       stored HTML -> editor HTML (media://id -> mediaUrl(id))
//   DocHtml.loadBody(html, mediaUrl)   the same, as an element of an inert document (no re-parse)
//   DocHtml.store(html|element, font)  editor HTML -> stored HTML (src -> media://id), idempotent
//   DocHtml.paste(html, mediaUrl)      clipboard HTML -> HTML to insert (narrower formatting)
//   DocHtml.pasteAction(clipboard)     what a paste should do: formula text, an image, HTML or text
//   DocHtml.adoptPastedImages(root, put, changed)   pasted data:/blob: images -> own media
//   DocHtml.mediaIds(html)             ids referenced by stored HTML
//   DocHtml.normalizeLinkUrl / secureLink / setTableRadius / tableRadius / newMediaId / imageMime
window.DocHtml = (function () {
    const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

    // ── elements ──

    const MATH_TAGS = new Set(['math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'ms', 'mspace',
        'mstyle', 'merror', 'mphantom', 'mpadded', 'mfrac', 'msqrt', 'mroot', 'msub', 'msup', 'msubsup',
        'munder', 'mover', 'munderover', 'mmultiscripts', 'mprescripts', 'none', 'mtable', 'mtr', 'mtd',
        'menclose']);

    // Copied (with their allowed attributes). Anything neither kept nor dropped is unwrapped: the tag
    // goes, its children stay, so the text and the formatting inside it survive.
    const KEEP_TAGS = new Set(['p', 'div', 'br', 'hr', 'span', 'font', 'b', 'strong', 'i', 'em', 'u', 's',
        'strike', 'del', 'ins', 'sub', 'sup', 'small', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3',
        'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr',
        'td', 'th', 'caption', 'colgroup', 'col', 'img', 'a', 'figure', 'figcaption'].concat(Array.from(MATH_TAGS)));

    // Dropped with their whole subtree: active, interactive, embedding or page-level elements, and the
    // source annotations of formulas (KaTeX/MathJax keep the TeX there; the browser lays out MathML).
    const DROP_TAGS = new Set(['script', 'style', 'link', 'meta', 'base', 'title', 'head', 'iframe',
        'object', 'embed', 'applet', 'frame', 'frameset', 'noframes', 'noembed', 'noscript', 'template',
        'slot', 'portal', 'fencedframe', 'form', 'input', 'button', 'select', 'option', 'optgroup',
        'textarea', 'datalist', 'output', 'progress', 'meter', 'dialog', 'details', 'summary', 'video', 'audio', 'source', 'track', 'picture', 'canvas', 'svg',
        'image', 'map', 'area', 'param', 'bgsound', 'marquee', 'xmp', 'plaintext', 'listing',
        'annotation', 'annotation-xml']);

    // Dropped when the rebuild leaves them with no children at all: an empty one of these takes no
    // space and carries nothing, so it is residue of editing. Deliberately empty structure is not
    // here: <br>, <hr>, <img>, a table's cells and rows, an <li>'s bullet and <pre>'s whitespace all
    // show up in the document even with nothing in them, and an empty <span> may be a caret
    // placeholder. One of these is kept too where it is the caret's only footing (holdsTheCaret).
    const EMPTY_DROP_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'blockquote', 'ul', 'ol']);

    // A newline next to one of these is source formatting of the clipboard HTML, not content.
    const BLOCK_TAGS = new Set(['p', 'hr', 'div', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
        'colgroup', 'col', 'figure', 'figcaption']);

    const MATH_ATTRS = {
        math: ['display', 'dir'],
        mi: ['mathvariant', 'mathsize', 'dir'], mn: ['mathvariant', 'mathsize', 'dir'],
        mo: ['mathvariant', 'mathsize', 'dir', 'form', 'fence', 'separator', 'stretchy', 'symmetric',
            'lspace', 'rspace', 'maxsize', 'minsize', 'movablelimits', 'accent'],
        mtext: ['mathvariant', 'mathsize', 'dir'], ms: ['mathvariant', 'mathsize', 'dir'],
        mspace: ['width', 'height', 'depth', 'linebreak'],
        mstyle: ['displaystyle', 'scriptlevel', 'mathvariant', 'mathsize', 'dir'],
        mpadded: ['width', 'height', 'depth', 'lspace', 'voffset'],
        mfrac: ['linethickness', 'bevelled'],
        munder: ['accentunder'], mover: ['accent'], munderover: ['accent', 'accentunder'],
        mtable: ['align', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'columnlines',
            'rowlines', 'frame', 'framespacing', 'equalrows', 'equalcolumns', 'displaystyle'],
        mtr: ['rowalign', 'columnalign'],
        mtd: ['rowspan', 'columnspan', 'rowalign', 'columnalign'],
        menclose: ['notation']
    };
    // MathML attribute values are keywords, numbers and lengths; nothing in them is a URL or a call.
    const MATH_VALUE = /^[A-Za-z0-9 .%+#-]{0,64}$/;

    // ── media ──

    const MEDIA_ID = /^img-[A-Za-z0-9_-]{1,64}$/;
    const MAX_RADIUS = 24;

    // Marks a pasted <img> whose bytes the editor does not own yet (see adoptPastedImages).
    const PASTE_ADOPT = 'data-paste-adopt';

    function newMediaId() {
        const random = window.crypto && crypto.randomUUID
            ? crypto.randomUUID().replace(/-/g, '')
            : Math.floor(Math.random() * 1e16).toString(16) + Math.floor(Math.random() * 1e16).toString(16);
        return 'img-' + random.slice(0, 12);
    }

    // An image MIME from magic bytes, so a blob: URL built from raw bytes renders in <img>.
    function imageMime(b) {
        if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
            return 'image/png';
        }
        if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
            return 'image/jpeg';
        }
        if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
            return 'image/gif';
        }
        if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
                && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
            return 'image/webp';
        }
        if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) {
            return 'image/bmp';
        }
        return 'application/octet-stream';
    }

    function mediaIds(html) {
        const ids = [];
        (String(html || '').match(/media:\/\/img-[A-Za-z0-9_-]{1,64}/g) || []).forEach(function (m) {
            const id = m.slice('media://'.length);
            if (ids.indexOf(id) < 0) {
                ids.push(id);
            }
        });
        return ids;
    }

    // ── links ──
    // Links typed into the link dialog and links in untrusted HTML pass the same allow-list, so a
    // document cannot smuggle an active javascript: URL into the editor.
    const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

    function normalizeLinkUrl(raw) {
        let value = String(raw == null ? '' : raw).trim();
        if (!value) {
            return null;
        }
        if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
            value = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? 'mailto:' + value : 'https://' + value;
        }
        try {
            const url = new URL(value);
            return SAFE_LINK_SCHEMES.has(url.protocol.toLowerCase()) ? url.href : null;
        } catch (e) {
            return null;
        }
    }

    // Puts the safe navigation attributes on a live or rebuilt <a>; false when the href is not allowed.
    // Writes only what is not already there: on a live link every write is a DOM mutation, and the
    // editors call this over the links of a whole document to check them.
    function secureLink(link, raw) {
        const href = normalizeLinkUrl(raw == null ? link.getAttribute('href') : raw);
        if (!href) {
            return false;
        }
        const set = function (name, value) {
            if (link.getAttribute(name) !== value) { link.setAttribute(name, value); }
        };
        set('href', href);
        set('title', href);
        set('target', '_blank');
        set('rel', 'noopener noreferrer');
        return true;
    }

    // ── tables ──
    // `doc-table` is on every table. Rounded corners are data-radius="N" (1–24, px); the inline
    // border-radius and --table-radius are derived from it, and each app's CSS rounds the corner cells.

    function tableRadius(table) {
        const radius = Math.round(Number(table.getAttribute('data-radius')) || 0);
        return Math.min(MAX_RADIUS, Math.max(0, radius));
    }

    function setTableRadius(table, radius) {
        radius = Math.min(MAX_RADIUS, Math.max(0, Math.round(Number(radius) || 0)));
        table.classList.add('doc-table');
        if (radius) {
            table.setAttribute('data-radius', String(radius));
            table.style.borderRadius = radius + 'px';
            table.style.setProperty('--table-radius', radius + 'px');
        } else {
            table.removeAttribute('data-radius');
            table.style.removeProperty('border-radius');
            table.style.removeProperty('--table-radius');
            if (!table.getAttribute('style')) {
                table.removeAttribute('style');
            }
        }
    }

    // ── inline styles ──

    const SAFE_COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|(?:rgba?|hsla?)\(\s*[0-9.,%\s/+-]+\))$/i;
    const FONT_FAMILY = /^[A-Za-z0-9 ,'"_-]{1,200}$/;
    const LENGTH = /^(\d+(?:\.\d+)?)(px|pt|em|rem|%)?$/;

    function lengthWithin(value, maxPx) {
        const m = LENGTH.exec(value);
        if (!m) {
            return false;
        }
        const n = parseFloat(m[1]);
        const unit = m[2] || 'px';
        if (!m[2] && n !== 0) {
            return false; // a bare number is only a length when it is 0
        }
        const px = unit === 'pt' ? n * 4 / 3 : unit === 'em' || unit === 'rem' ? n * 16 : unit === '%' ? 0 : n;
        return unit === '%' ? n <= 100 : px <= maxPx;
    }

    function lengths(value, maxPx) {
        const parts = value.split(/\s+/);
        return parts.length <= 4 && parts.every(function (p) {
            return p === 'auto' || lengthWithin(p, maxPx);
        });
    }

    function fontSize(value, paste) {
        const m = /^(\d+(?:\.\d+)?)(pt|px|em|rem|%)$/.exec(value);
        if (!m) {
            return !paste && /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$/.test(value);
        }
        const n = parseFloat(m[1]);
        if (paste) {
            // Web pages size text in px/em; only the editor's own points (and Word's) carry over.
            return m[2] === 'pt' && n >= 6 && n <= 96;
        }
        const pt = m[2] === 'pt' ? n : m[2] === 'px' ? n * 0.75 : m[2] === '%' ? n * 0.12 : n * 12;
        return pt >= 4 && pt <= 144;
    }

    function isColor(value) {
        return SAFE_COLOR.test(value) && (!window.CSS || !CSS.supports || CSS.supports('color', value));
    }

    // Browsers alternate between quoted and unquoted names for the same font family. Normalize every
    // item in a fallback list, not a hard-coded set of editor fonts, so e.g. "Open Sans", Arial and
    // Open Sans, Arial compare equal and adjacent runs can be joined during store().
    function canonicalFontFamily(value) {
        const families = [];
        let part = '', quote = '';
        for (let i = 0; i < value.length; i++) {
            const ch = value.charAt(i);
            if (quote) {
                part += ch;
                if (ch === quote) { quote = ''; }
            } else if (ch === '"' || ch === "'") {
                quote = ch;
                part += ch;
            } else if (ch === ',') {
                families.push(part);
                part = '';
            } else {
                part += ch;
            }
        }
        families.push(part);
        return families.map(function (family) {
            family = family.trim();
            const match = /^(?:"([^"]+)"|'([^']+)')$/.exec(family);
            // A comma is legal inside a quoted family name; keep those quotes because removing them
            // would turn one family into two. Ordinary one- or multi-word names need no quotes.
            const unquoted = match && (match[1] || match[2]);
            return unquoted && unquoted.indexOf(',') === -1 ? unquoted : family;
        }).join(', ');
    }

    // property -> (value, tag, paste) -> boolean. Values arrive trimmed and lower-cased (except
    // font-family, kept as written).
    const STYLE_RULES = {
        'text-align': function (v) { return /^(?:left|right|center|justify|start|end)$/.test(v); },
        'font-weight': function (v) { return /^(?:normal|bold|bolder|lighter|[1-9]00)$/.test(v); },
        'font-style': function (v) { return /^(?:normal|italic|oblique)$/.test(v); },
        'text-decoration': decoration,
        'text-decoration-line': decoration,
        'vertical-align': function (v) {
            return /^(?:baseline|sub|super|top|middle|bottom|text-top|text-bottom)$/.test(v);
        },
        'list-style-type': function (v) { return /^[a-z-]{1,30}$/.test(v); },
        'font-size': function (v, tag, paste) { return fontSize(v, paste); },
        // Kept on paste as well as on open and save. A font is something the document itself can
        // hold — set from the picker, or carried in from a .docx or a file written elsewhere — so
        // dropping it on paste changed the look of text copied from one place in the document to
        // another. The value is still shape-checked (no url(), var(), escapes), which is what
        // makes it safe; that a web page's font now travels with its text is a look, not a risk,
        // and Ctrl+Space strips the formatting of a selection.
        'font-family': function (v) { return FONT_FAMILY.test(v); },
        'color': function (v, tag, paste) { return !paste && isColor(v); },
        // Cell fill is part of the document; elsewhere a pasted background is the source page's
        // look and leaves a styled span the caret gets stuck in, so paste keeps it on cells only.
        'background-color': function (v, tag, paste) {
            return (!paste || tag === 'td' || tag === 'th') && isColor(v);
        },
        'line-height': function (v, tag, paste) {
            return !paste && (v === 'normal' || /^\d+(?:\.\d+)?$/.test(v) && parseFloat(v) <= 5
                || lengthWithin(v, 200));
        },
        'text-indent': function (v, tag, paste) { return !paste && lengthWithin(v, 1000); },
        // Chrome's indent writes <blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;">.
        'margin': spacing, 'margin-left': spacing, 'margin-right': spacing,
        'margin-top': spacing, 'margin-bottom': spacing,
        'padding': spacing, 'padding-left': spacing, 'padding-right': spacing,
        'padding-top': spacing, 'padding-bottom': spacing,
        'border': function (v, tag, paste) { return !paste && /^(?:none|0|0px)$/.test(v); },
        'width': size, 'height': size,
        'white-space': function (v, tag, paste) { return !paste && /^(?:normal|pre|pre-wrap|pre-line|nowrap)$/.test(v); }
    };

    function decoration(v) {
        return /^(?:none|(?:underline|overline|line-through)(?:\s+(?:underline|overline|line-through))*)$/.test(v);
    }

    function spacing(v, tag, paste) {
        return !paste && lengths(v, 2000);
    }

    // An image's size (the resize handle writes width + height:auto); table geometry from Word.
    function size(v, tag) {
        return (tag === 'img' || tag === 'table' || tag === 'td' || tag === 'th' || tag === 'col')
            && (v === 'auto' || lengthWithin(v, 10000));
    }

    // Declarations are read as written, not through CSSOM: a shorthand holding var() reads back as
    // empty longhands there and would slip through. Anything that fetches, escapes (u\72l( is url(
    // to the CSS parser), calls var() or sets a custom property is refused outright.
    const CSS_DANGER = /url\s*\(|image-set\s*\(|image\s*\(|element\s*\(|cross-fade\s*\(|src\s*\(|var\s*\(|env\s*\(|attr\s*\(|expression\s*\(|@import|\\|\/\*|[<>{}]/i;

    function safeStyle(styleText, tag, paste) {
        const kept = [];
        const seen = new Set();
        String(styleText || '').split(';').forEach(function (decl) {
            const i = decl.indexOf(':');
            if (i < 0 || CSS_DANGER.test(decl)) {
                return;
            }
            const prop = decl.slice(0, i).trim().toLowerCase();
            let value = decl.slice(i + 1).trim().replace(/\s*!important$/i, '').replace(/\s+/g, ' ');
            if (prop === 'font-family') {
                value = canonicalFontFamily(value);
            } else {
                value = value.toLowerCase();
            }
            const rule = Object.prototype.hasOwnProperty.call(STYLE_RULES, prop) ? STYLE_RULES[prop] : null;
            if (!value || !rule || !rule(value, tag, paste)) {
                return;
            }
            if (seen.has(prop)) {
                // a later declaration of the same property wins, as in CSS
                for (let k = 0; k < kept.length; k++) {
                    if (kept[k].prop === prop) {
                        kept.splice(k, 1);
                        break;
                    }
                }
            }
            seen.add(prop);
            kept.push({ prop: prop, value: value });
        });
        return kept.map(function (d) { return d.prop + ': ' + d.value; }).join('; ');
    }

    // ── rebuilding ──

    // opts: { mode: 'load' | 'store' | 'paste', mediaUrl: id -> url | null }
    // `html` is markup, or an element whose children are rebuilt as they stand. 'store' and 'load'
    // only read the source, so passing an element saves a serialization and a parse of the whole
    // document — which store() is given on every save and every dirty check (see Editor.serialize).
    // ('paste' normalizes its source in place, so it is only ever handed clipboard markup.)
    function rebuild(html, opts) {
        const from = html && html.nodeType === 1
            ? html
            : new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html').body;
        const out = document.implementation.createHTMLDocument('');
        const root = out.body;
        if (opts.mode === 'paste') {
            normalizePastedMath(from);
        }
        Array.prototype.slice.call(from.childNodes).forEach(function (child) {
            copyNode(child, root, out, opts);
        });
        if (opts.mode === 'store' || opts.mode === 'load') {
            blocksInCells(root, out);
        }
        if (opts.mode === 'store') {
            newlinesToBreaks(root, out);
            // Contenteditable may leave inline runs directly at the editor root, without a <p>.
            mergeAdjacentEquivalentSpans(root);
        }
        if (opts.mode === 'paste') {
            removePasteFormattingWhitespace(root);
        }
        return root;
    }

    function copyNode(node, parent, out, opts) {
        if (node.nodeType === 3) {
            parent.appendChild(out.createTextNode(node.nodeValue));
            return;
        }
        if (node.nodeType !== 1) {
            return; // comments (the clipboard's StartFragment markers), processing instructions
        }
        const tag = node.localName.toLowerCase();
        if (DROP_TAGS.has(tag)) {
            return;
        }
        const children = Array.prototype.slice.call(node.childNodes);
        if (!KEEP_TAGS.has(tag)) {
            children.forEach(function (c) { copyNode(c, parent, out, opts); });
            return;
        }
        const paste = opts.mode === 'paste';
        const isMath = MATH_TAGS.has(tag);
        // Chromium's fontName command still writes the deprecated <font> element. Accept it when
        // opening old documents, but never put it into a newly stored document: a styled span is
        // the modern equivalent and makes exported HTML considerably easier to inspect and reuse.
        const storedTag = tag === 'font' && opts.mode === 'store' ? 'span' : tag;
        const el = isMath ? out.createElementNS(MATHML_NS, tag) : out.createElement(storedTag);
        let legacyFontStyle = '';

        if (tag === 'a') {
            if (!secureLink(el, node.getAttribute('href'))) {
                children.forEach(function (c) { copyNode(c, parent, out, opts); });
                return;
            }
        } else if (tag === 'img') {
            if (!copyImage(node, el, opts)) {
                return;
            }
        } else if (tag === 'td' || tag === 'th') {
            copyInt(node, el, 'colspan', 1, 100);
            copyInt(node, el, 'rowspan', 1, 100);
        } else if (tag === 'col' || tag === 'colgroup') {
            copyInt(node, el, 'span', 1, 100);
        } else if (tag === 'ol') {
            copyInt(node, el, 'start', 0, 100000);
            const type = node.getAttribute('type');
            if (type && /^[1aAiI]$/.test(type)) {
                el.setAttribute('type', type);
            }
        } else if (tag === 'font') {
            const color = (node.getAttribute('color') || '').trim();
            const face = (node.getAttribute('face') || '').trim();
            if (opts.mode === 'store') {
                if (face && FONT_FAMILY.test(face)) { legacyFontStyle += 'font-family: ' + face + ';'; }
                if (color && isColor(color)) { legacyFontStyle += 'color: ' + color + ';'; }
                const size = parseInt(node.getAttribute('size'), 10);
                const legacyPoints = [0, 7.5, 10, 12, 13.5, 18, 24, 36];
                if (size >= 1 && size <= 7) { legacyFontStyle += 'font-size: ' + legacyPoints[size] + 'pt;'; }
            } else {
                if (color && !paste && isColor(color)) { el.setAttribute('color', color); }
                // Old documents and pasted fragments remain readable; store() performs the
                // one-way normalization after the content is in the editor.
                if (face && FONT_FAMILY.test(face)) { el.setAttribute('face', face); }
                if (!paste) { copyInt(node, el, 'size', 1, 7); }
            }
        } else if (isMath) {
            (MATH_ATTRS[tag] || []).forEach(function (name) {
                const value = node.getAttribute(name);
                if (value != null && MATH_VALUE.test(value)) {
                    el.setAttribute(name, value);
                }
            });
        }

        // Put the legacy declarations first: an explicit style on the original element wins, just
        // as it did over face/color/size in the browser.
        const style = safeStyle(legacyFontStyle + (node.getAttribute('style') || ''), storedTag, paste);
        if (style) {
            el.setAttribute('style', style);
        }
        copyClasses(node, el, tag);
        if (tag === 'table') {
            // border-radius / --table-radius are not on the style list: they come from data-radius.
            setTableRadius(el, node.hasAttribute('data-radius') ? tableRadius(node) : legacyRadius(node));
        }

        children.forEach(function (c) { copyNode(c, el, out, opts); });

        if (opts.mode === 'store') { mergeAdjacentEquivalentSpans(el); }

        // A font applied to an entire paragraph does not need an inline wrapper. Put that inherited
        // declaration on the block itself, leaving ordinary paragraphs as a single <p> whenever
        // possible. Mixed-font paragraphs still keep spans around only the runs that differ.
        if (opts.mode === 'store') { hoistWholeBlockFont(el); }

        // A font-family the element already inherits says nothing: editing leaves such declarations
        // behind on nested blocks and on spans, and they make the markup hard to read for nothing.
        if (opts.mode === 'store') { dropInheritedFont(el, parent, opts); }

        // Chromium sometimes wraps a single typed space in <span style="white-space: pre"> even
        // though the document itself is already pre-wrap. Keep the space, discard that redundant
        // wrapper. If an ancestor explicitly switches whitespace back to normal, the span matters.
        if (opts.mode === 'store' && tag === 'span' && redundantPreSpace(node, el)) {
            while (el.firstChild) { parent.appendChild(el.firstChild); }
            return;
        }

        // A bare span or font is only a wrapper — the kind the caret gets stuck inside.
        if ((tag === 'span' || tag === 'font') && el.attributes.length === 0) {
            while (el.firstChild) {
                parent.appendChild(el.firstChild);
            }
            return;
        }

        // Nothing came out of it: the element has no text, no <br>, no image — it renders as no
        // line at all. Editing (and other apps' HTML) leaves such shells behind, and since the
        // children were rebuilt first, a wrapper left holding only shells is dropped with them.
        // A deliberately blank line is <p><br></p> and keeps its <br>, so it stays.
        if (EMPTY_DROP_TAGS.has(storedTag) && !el.firstChild && !holdsTheCaret(node, parent)) {
            return;
        }
        parent.appendChild(el);
    }

    // A table cell holds paragraphs, like the document around it. Left to itself a cell holds bare
    // text, and then its lines are not blocks: Enter inside it writes a newline instead of starting
    // a paragraph, and everything that belongs to a block — alignment, indent, a heading, a font of
    // its own — reaches the whole cell or nothing. So the cell's inline content is put into <p>s,
    // one per line (a <br> or a newline ends a line), on open and on save alike. A cell that
    // already holds blocks is somebody's structure and is left alone; an empty one gets the single
    // paragraph the caret needs.
    const CELL_BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
        'ul', 'ol', 'dl', 'pre', 'table', 'figure']);

    function blocksInCells(root, out) {
        Array.prototype.forEach.call(root.querySelectorAll('td,th'), function (cell) {
            const blocky = Array.prototype.some.call(cell.children, function (child) {
                return CELL_BLOCKS.has(child.localName);
            });
            if (blocky) { return; }
            const lines = [];
            let line = out.createElement('p');
            const endLine = function () {
                if (!line.firstChild) { line.appendChild(out.createElement('br')); }
                lines.push(line);
                line = out.createElement('p');
            };
            Array.prototype.slice.call(cell.childNodes).forEach(function (node) {
                if (node.nodeType === 1 && node.localName === 'br') {
                    // The <br> that closes the content is the filler that keeps an empty line
                    // visible, not a separator: it ends no line of its own.
                    if (node.nextSibling) { endLine(); }
                } else if (node.nodeType === 3 && /[\r\n]/.test(node.nodeValue)) {
                    node.nodeValue.replace(/\r\n?/g, '\n').split('\n').forEach(function (text, i) {
                        if (i) { endLine(); }
                        if (text) { line.appendChild(out.createTextNode(text)); }
                    });
                } else {
                    line.appendChild(node);
                }
            });
            endLine();
            while (cell.firstChild) { cell.removeChild(cell.firstChild); }
            lines.forEach(function (p) { cell.appendChild(p); });
        });
    }

    // A soft line break reaches the editor as a newline character: both editors lay the document
    // out with white-space: pre-wrap, so Shift+Enter writes one, and so does Enter inside a table
    // cell, where Chrome makes no new block. Stored like that, the lines of a paragraph or a cell
    // exist only as long as something applies pre-wrap — paste such a cell into another app and
    // they run together — and the browser's own commands cannot see them at all (see alignment in
    // editor-core.js). A save writes <br> instead, which says the same thing anywhere. Whitespace
    // is content in <pre> and <code>, and MathML has no <br>, so their text is left as written.
    function newlinesToBreaks(root, out) {
        const tag = root.localName;
        if (tag === 'pre' || tag === 'code' || MATH_TAGS.has(tag)) {
            return;
        }
        Array.prototype.slice.call(root.childNodes).forEach(function (node) {
            if (node.nodeType === 1) {
                newlinesToBreaks(node, out);
                return;
            }
            if (node.nodeType !== 3 || !/[\r\n]/.test(node.nodeValue)) {
                return;
            }
            const lines = node.nodeValue.replace(/\r\n?/g, '\n').split('\n');
            const parts = out.createDocumentFragment();
            lines.forEach(function (line, i) {
                if (i) { parts.appendChild(out.createElement('br')); }
                if (line) { parts.appendChild(out.createTextNode(line)); }
            });
            node.parentNode.replaceChild(parts, node);
        });
    }

    function mergeAdjacentEquivalentSpans(parent) {
        let node = parent.firstChild;
        while (node) {
            const next = node.nextSibling;
            if (node.localName === 'span' && next && next.localName === 'span'
                    && sameAttributes(node, next)) {
                while (next.firstChild) { node.appendChild(next.firstChild); }
                next.remove();
                continue; // the enlarged span may also match the following sibling
            }
            node = next;
        }
        parent.normalize();
    }

    function sameAttributes(a, b) {
        if (a.attributes.length !== b.attributes.length) { return false; }
        return Array.prototype.every.call(a.attributes, function (attr) {
            return b.getAttribute(attr.name) === attr.value;
        });
    }

    function hoistWholeBlockFont(block) {
        if (!/^(?:p|div|h[1-6]|li|blockquote)$/.test(block.localName)) {
            return;
        }
        block.normalize(); // the removed whitespace wrapper may have left adjacent text nodes
        if (block.childNodes.length !== 1 || block.firstChild.localName !== 'span') { return; }
        const span = block.firstChild;
        const family = span.style.fontFamily;
        if (!family) { return; }
        block.style.fontFamily = family;
        span.style.removeProperty('font-family');
        if (!span.getAttribute('style')) { span.removeAttribute('style'); }
        if (span.attributes.length === 0) {
            while (span.firstChild) { block.insertBefore(span.firstChild, span); }
            span.remove();
        }
    }

    // Elements the caret cannot be put inside or next to: a table and an <hr> take the whole line,
    // and a divider is locked (contenteditable="false", so Backspace cannot glue a line into it).
    // The empty block beside one of those is the only place the caret can stand there, so it is
    // structure — without it there is no way to type between two tables, or after a closing one,
    // and the text goes into a cell instead.
    function caretIsStuckBeside(el) {
        if (!el || el.nodeType !== 1) { return false; }
        const tag = el.localName;
        return tag === 'table' || tag === 'hr'
            || (el.classList && (el.classList.contains('doc-divider')
                || el.classList.contains('document-ornament')));
    }

    // Whether an empty block is structure after all. `node` is the source element; `parent` holds
    // what has been rebuilt before it.
    function holdsTheCaret(node, parent) {
        // The one line of a table cell or a list item: dropping it leaves nothing to type into.
        const inside = parent.localName;
        if ((inside === 'td' || inside === 'th' || inside === 'li') && !parent.firstChild
                && !node.nextElementSibling) {
            return true;
        }
        return caretIsStuckBeside(parent.lastElementChild) || caretIsStuckBeside(node.nextElementSibling);
    }

    // Families as CSSOM writes them differ by quoting ('"Roboto Serif"' vs Roboto Serif), so compare
    // them unquoted and case-insensitively.
    function sameFamily(a, b) {
        const plain = function (v) {
            return String(v || '').replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        };
        return plain(a) === plain(b);
    }

    // The family the element would read in anyway: the nearest ancestor of the rebuilt tree that
    // sets one, or — at the top level — the font of the document the content is being stored for
    // (SecureDoc keeps it on the editor and saves it as a wrapper around this HTML; see store).
    function inheritedFamily(parent, opts) {
        for (let p = parent; p && p.localName !== 'body'; p = p.parentElement) {
            if (p.style && p.style.fontFamily) { return p.style.fontFamily; }
        }
        return opts.font || '';
    }

    function dropInheritedFont(el, parent, opts) {
        const family = el.style && el.style.fontFamily;
        if (!family || !sameFamily(family, inheritedFamily(parent, opts))) { return; }
        el.style.removeProperty('font-family');
        if (!el.getAttribute('style')) { el.removeAttribute('style'); }
    }

    function redundantPreSpace(source, rebuilt) {
        if (rebuilt.getAttribute('style') !== 'white-space: pre' || !/^\s+$/.test(rebuilt.textContent)
                || Array.prototype.some.call(rebuilt.childNodes, function (n) { return n.nodeType !== 3; })) {
            return false;
        }
        for (let p = source.parentElement; p && p.localName !== 'body'; p = p.parentElement) {
            const ws = p.style && p.style.whiteSpace;
            if (ws) { return ws !== 'normal' && ws !== 'nowrap'; }
            if (p.localName === 'pre') { return true; }
        }
        return true; // the editor and exported document both use pre-wrap at their root
    }

    // webchat used to round a table with an inline border-radius and no data-radius.
    function legacyRadius(table) {
        const m = /(?:^|;)\s*border-radius\s*:\s*(\d+)(?:px)?\s*(?:;|$)/i.exec(table.getAttribute('style') || '');
        return m ? Number(m[1]) : 0;
    }

    function copyInt(from, to, name, min, max) {
        const raw = from.getAttribute(name);
        if (raw == null || !/^\s*\d+\s*$/.test(raw)) {
            return;
        }
        const value = parseInt(raw, 10);
        if (value >= min && value <= max) {
            to.setAttribute(name, String(value));
        }
    }

    // Classes that belong to the contract: doc-table (tables) and doc-divider (section dividers).
    // webchat's former `document-ornament` divider becomes a doc-divider.
    function copyClasses(from, to, tag) {
        const classes = (from.getAttribute('class') || '').split(/\s+/);
        if (tag === 'p' && (classes.indexOf('doc-divider') >= 0 || classes.indexOf('document-ornament') >= 0)) {
            to.classList.add('doc-divider');
            to.style.textAlign = 'center';
        }
        if (tag === 'table') {
            to.classList.add('doc-table');
        }
    }

    // The only image sources a document may hold: its own media (media://id stored, the app's blob:
    // URL in the editor). Paste may also bring an image's bytes inline (data:) or as a blob: URL;
    // those are marked for adoption. Anything that would be fetched from a host is dropped.
    function copyImage(node, el, opts) {
        const id = node.getAttribute('data-media-id') || '';
        const src = node.getAttribute('src') || '';
        const validId = MEDIA_ID.test(id);
        const known = validId && opts.mediaUrl ? opts.mediaUrl(id) : null;
        if (opts.mode === 'store') {
            if (!validId) {
                return false;
            }
            el.setAttribute('data-media-id', id);
            el.setAttribute('src', 'media://' + id);
        } else if (opts.mode === 'load') {
            if (!validId) {
                return false;
            }
            el.setAttribute('data-media-id', id);
            // No bytes for this id: no src at all (a media:// src would be requested by the page).
            if (known) {
                el.setAttribute('src', known);
            }
        } else if (known && (src === known || src === 'media://' + id)) {
            el.setAttribute('data-media-id', id); // copied within the app
            el.setAttribute('src', known);
        } else if (/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$/i.test(src)
                || /^blob:/i.test(src)) {
            el.setAttribute('src', src);
            el.setAttribute(PASTE_ADOPT, '1');
        } else {
            return false;
        }
        const alt = node.getAttribute('alt');
        el.setAttribute('alt', alt ? alt.slice(0, 500) : '');
        copyInt(node, el, 'width', 1, 10000);
        copyInt(node, el, 'height', 1, 10000);
        return true;
    }

    // KaTeX puts two copies of a formula on the clipboard: semantic MathML and a forest of spans that
    // only works with KaTeX's stylesheet. Keep the MathML (its annotation is dropped by DROP_TAGS).
    function normalizePastedMath(root) {
        Array.prototype.slice.call(root.querySelectorAll('.katex')).forEach(function (katex) {
            const math = katex.querySelector('math');
            if (!math || !katex.parentNode) {
                return;
            }
            const display = katex.closest('.katex-display');
            if (display) {
                math.setAttribute('display', 'block');
            }
            // .katex-display wraps exactly one .katex; replacing the wrapper drops its spacing spans too
            (display && display.querySelectorAll('.katex').length === 1 ? display : katex).replaceWith(math);
        });
    }

    // Whitespace in pre/code is content. Elsewhere a whitespace-only text node with a line break is
    // the clipboard's pretty-printing: one space between inline nodes, nothing beside a block.
    // (Both editors use white-space: pre-wrap, so such a node would otherwise render a blank line.)
    function removePasteFormattingWhitespace(root) {
        const tag = root.localName ? root.localName.toLowerCase() : '';
        if (tag === 'pre' || tag === 'code') {
            return;
        }
        Array.prototype.slice.call(root.children).forEach(removePasteFormattingWhitespace);
        Array.prototype.slice.call(root.childNodes).forEach(function (node) {
            if (node.nodeType !== 3 || !/[\r\n]/.test(node.nodeValue) || node.nodeValue.trim()) {
                return;
            }
            const prevBlock = node.previousSibling && node.previousSibling.nodeType === 1
                && BLOCK_TAGS.has(node.previousSibling.localName);
            const nextBlock = node.nextSibling && node.nextSibling.nodeType === 1
                && BLOCK_TAGS.has(node.nextSibling.localName);
            if (!node.previousSibling || !node.nextSibling || prevBlock || nextBlock) {
                node.remove();
            } else {
                node.nodeValue = ' ';
            }
        });
    }

    // ── public: the three directions ──

    // The rebuilt content as an element of an inert document: its children can be moved straight into
    // an editor, with no serialization and re-parse in between (the nodes are adopted on insert).
    function loadBody(html, mediaUrl) {
        const root = rebuild(html && String(html).trim() ? html : '<p><br></p>', { mode: 'load', mediaUrl: mediaUrl });
        if (!root.firstChild) {
            root.innerHTML = '<p><br></p>';
        }
        return root;
    }

    function load(html, mediaUrl) {
        return loadBody(html, mediaUrl).innerHTML;
    }

    /**
     * `html`: editor markup, or the editor element (a copy of it) itself.
     * `font`: the font-family the whole document is in, when the editor keeps one outside this
     * markup (SecureDoc saves it as a wrapper around the result) — blocks that only repeat it are
     * left clean. Optional: without it, a top-level block keeps the family it states.
     */
    function store(html, font) {
        return rebuild(html, { mode: 'store', font: font }).innerHTML;
    }

    function paste(html, mediaUrl) {
        return rebuild(html, { mode: 'paste', mediaUrl: mediaUrl }).innerHTML;
    }

    // ── paste decisions ──

    // ChatGPT's copy can put the Markdown/LaTeX source on the clipboard instead of rendered KaTeX.
    // A clipboard that is one complete formula becomes readable text; this is not a TeX parser.
    function plainTextFromPastedLatex(text) {
        if (!text) {
            return null;
        }
        const value = text.trim();
        const forms = [/^\\\[([\s\S]*)\\\]$/, /^\$\$([\s\S]*)\$\$$/, /^\\\(([\s\S]*)\\\)$/];
        let source = null;
        for (let i = 0; i < forms.length; i++) {
            const match = forms[i].exec(value);
            if (match) {
                source = match[1].trim();
                break;
            }
        }
        if (!source) {
            return null;
        }
        const commands = {
            log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan',
            min: 'min', max: 'max', lim: 'lim', mid: ' | ', vert: ' | ',
            cdot: ' · ', times: ' × ', pm: ' ± ', mp: ' ∓ ', div: ' ÷ ',
            le: ' ≤ ', leq: ' ≤ ', ge: ' ≥ ', geq: ' ≥ ', ne: ' ≠ ', neq: ' ≠ ',
            approx: ' ≈ ', equiv: ' ≡ ', to: ' → ', rightarrow: ' → ', leftarrow: ' ← ',
            infty: '∞', sum: 'Σ', prod: 'Π', int: '∫', partial: '∂', nabla: '∇',
            alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ',
            lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', phi: 'φ', omega: 'ω',
            Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ',
            Phi: 'Φ', Omega: 'Ω'
        };
        const sub = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅',
            '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '(': '₍', ')': '₎' };
        const sup = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵',
            '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '(': '⁽', ')': '⁾' };
        function scriptChars(chars, table) {
            return chars.split('').map(function (c) { return table[c]; }).join('');
        }
        source = source.replace(/\\(?:left|right)\b/g, '');
        source = source.replace(/\\(?:text|mathrm|mathbf|mathit)\{([^{}]*)\}/g, '$1');
        source = source.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
        source = source.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
        source = source.replace(/_\{([0-9+\-()]+)\}|_([0-9])/g, function (_, many, one) {
            return scriptChars(many || one, sub);
        });
        source = source.replace(/\^\{([0-9+\-()]+)\}|\^([0-9])/g, function (_, many, one) {
            return scriptChars(many || one, sup);
        });
        source = source.replace(/\\(?:quad|qquad)\b/g, ' ');
        source = source.replace(/\\[,;:!]/g, ' ');
        source = source.replace(/\\([A-Za-z]+)\b/g, function (whole, name) {
            return Object.prototype.hasOwnProperty.call(commands, name) ? commands[name] : whole;
        });
        source = source.replace(/-/g, '−').replace(/\s+/g, ' ').trim();
        return source.replace(/\s*=\s*/g, ' = ').replace(/\s*\|\s*/g, ' | ');
    }

    function imageFileFrom(clipboard) {
        const items = clipboard.items;
        if (!items) {
            return null;
        }
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
                return items[i].getAsFile();
            }
        }
        return null;
    }

    function htmlHasText(html) {
        if (!html) {
            return false;
        }
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return (doc.body.textContent || '').trim().length > 0;
    }

    // -> { kind: 'text', text } | { kind: 'image', file } | { kind: 'html', html } | null (let the
    // browser handle it). `html` is the raw clipboard HTML; pass it through paste() before inserting.
    // "Copy image" puts the bitmap AND a scrap of <img src="https://…"> on the clipboard: when there
    // are real image bytes and no text worth keeping, the bytes win.
    function pasteAction(clipboard) {
        if (!clipboard) {
            return null;
        }
        const html = clipboard.getData('text/html');
        const text = clipboard.getData('text/plain');
        const formula = plainTextFromPastedLatex(text);
        if (formula != null) {
            return { kind: 'text', text: formula };
        }
        const file = imageFileFrom(clipboard);
        if (file && !htmlHasText(html)) {
            return { kind: 'image', file: file };
        }
        if (html) {
            return { kind: 'html', html: html };
        }
        if (text) {
            return { kind: 'text', text: text };
        }
        return null;
    }

    // Takes the bytes of just-pasted data:/blob: images into the editor's media store.
    // put(blob) -> { id, url } stores it; changed() reports the edit. Images that cannot be read
    // are removed — nothing is ever fetched from a host. data: is decoded here, without fetch, so it
    // works under a CSP whose connect-src excludes data:.
    function adoptPastedImages(root, put, changed) {
        root.querySelectorAll('img[' + PASTE_ADOPT + ']').forEach(function (img) {
            img.removeAttribute(PASTE_ADOPT);
            img.removeAttribute('data-media-id');
            blobFromSrc(img.getAttribute('src')).then(function (blob) {
                if (!img.isConnected) {
                    return;
                }
                const stored = put(blob);
                img.setAttribute('data-media-id', stored.id);
                img.setAttribute('src', stored.url);
                changed();
            }).catch(function () {
                if (img.isConnected) {
                    img.remove();
                    changed();
                }
            });
        });
    }

    function blobFromSrc(src) {
        const data = /^data:(image\/(?:png|jpeg|gif|webp|bmp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(src || '');
        if (data) {
            return Promise.resolve().then(function () {
                const bin = atob(data[2].replace(/\s+/g, ''));
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) {
                    bytes[i] = bin.charCodeAt(i);
                }
                return new Blob([bytes], { type: imageMime(bytes) });
            });
        }
        if (!/^blob:/i.test(src || '')) {
            return Promise.reject(new Error('not a local image'));
        }
        return fetch(src).then(function (res) {
            if (!res.ok) {
                throw new Error('HTTP ' + res.status);
            }
            return res.arrayBuffer();
        }).then(function (buffer) {
            const bytes = new Uint8Array(buffer);
            const type = imageMime(bytes);
            if (!/^image\//.test(type)) {
                throw new Error('not an image');
            }
            return new Blob([bytes], { type: type });
        });
    }

    return Object.freeze({
        load: load,
        loadBody: loadBody,
        store: store,
        paste: paste,
        pasteAction: pasteAction,
        adoptPastedImages: adoptPastedImages,
        plainTextFromPastedLatex: plainTextFromPastedLatex,
        mediaIds: mediaIds,
        newMediaId: newMediaId,
        imageMime: imageMime,
        normalizeLinkUrl: normalizeLinkUrl,
        secureLink: secureLink,
        tableRadius: tableRadius,
        setTableRadius: setTableRadius
    });
})();
