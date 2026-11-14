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
//   DocHtml.store(html)                editor HTML -> stored HTML (src -> media://id), idempotent
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
    function secureLink(link, raw) {
        const href = normalizeLinkUrl(raw == null ? link.getAttribute('href') : raw);
        if (!href) {
            return false;
        }
        link.setAttribute('href', href);
        link.setAttribute('title', href);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
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
        'font-family': function (v, tag, paste) { return !paste && FONT_FAMILY.test(v); },
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
            if (prop !== 'font-family') {
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
    function rebuild(html, opts) {
        const source = new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html');
        const out = document.implementation.createHTMLDocument('');
        const root = out.body;
        if (opts.mode === 'paste') {
            normalizePastedMath(source.body);
        }
        Array.prototype.slice.call(source.body.childNodes).forEach(function (child) {
            copyNode(child, root, out, opts);
        });
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
        const el = isMath ? out.createElementNS(MATHML_NS, tag) : out.createElement(tag);

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
            if (color && !paste && isColor(color)) {
                el.setAttribute('color', color);
            }
            const face = (node.getAttribute('face') || '').trim();
            if (face && !paste && FONT_FAMILY.test(face)) {
                el.setAttribute('face', face);
            }
            if (!paste) {
                copyInt(node, el, 'size', 1, 7); // a web page's <font size> is its look, not ours
            }
        } else if (isMath) {
            (MATH_ATTRS[tag] || []).forEach(function (name) {
                const value = node.getAttribute(name);
                if (value != null && MATH_VALUE.test(value)) {
                    el.setAttribute(name, value);
                }
            });
        }

        const style = safeStyle(node.getAttribute('style'), tag, paste);
        if (style) {
            el.setAttribute('style', style);
        }
        copyClasses(node, el, tag);
        if (tag === 'table') {
            // border-radius / --table-radius are not on the style list: they come from data-radius.
            setTableRadius(el, node.hasAttribute('data-radius') ? tableRadius(node) : legacyRadius(node));
        }

        children.forEach(function (c) { copyNode(c, el, out, opts); });

        // A bare span or font is only a wrapper — the kind the caret gets stuck inside.
        if ((tag === 'span' || tag === 'font') && el.attributes.length === 0) {
            while (el.firstChild) {
                parent.appendChild(el.firstChild);
            }
            return;
        }
        parent.appendChild(el);
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

    function load(html, mediaUrl) {
        const root = rebuild(html && String(html).trim() ? html : '<p><br></p>', { mode: 'load', mediaUrl: mediaUrl });
        if (!root.firstChild) {
            root.innerHTML = '<p><br></p>';
        }
        return root.innerHTML;
    }

    function store(html) {
        return rebuild(html, { mode: 'store' }).innerHTML;
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
