'use strict';
// DOCX import, entirely in the browser (DESIGN.md §8): the file never leaves this page.
// Read straight from the OOXML (zip.js + DOMParser). Same mapping as the Java (Apache POI) importer
// it replaced: paragraphs with alignment, bold/italic/underline runs, tables with cell fill, and
// embedded images (as media://<id>).
window.Importer = (function () {
    // Transitional and Strict OOXML namespaces.
    const NS = {
        w: ['http://schemas.openxmlformats.org/wordprocessingml/2006/main',
            'http://purl.oclc.org/ooxml/wordprocessingml/main'],
        r: ['http://schemas.openxmlformats.org/officeDocument/2006/relationships',
            'http://purl.oclc.org/ooxml/officeDocument/relationships'],
        a: ['http://schemas.openxmlformats.org/drawingml/2006/main',
            'http://purl.oclc.org/ooxml/drawingml/main'],
        pic: ['http://schemas.openxmlformats.org/drawingml/2006/picture',
              'http://purl.oclc.org/ooxml/drawingml/picture'],
        mc: ['http://schemas.openxmlformats.org/markup-compatibility/2006'],
        pkg: ['http://schemas.openxmlformats.org/package/2006/relationships']
    };

    function esc(s) {
        return s.replace(/[&<>"]/g, function (c) {
            return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
        });
    }

    function importError(message) {
        const e = new Error(message);
        e.name = 'ImportError';
        return e;
    }

    /** blob + filename -> { content (HTML), title, media: { id: Uint8Array } }. */
    async function importFile(blob, filename) {
        const name = filename || '';
        const lower = name.toLowerCase();
        const dot = name.lastIndexOf('.');
        const title = !name.trim() ? 'Import' : dot > 0 ? name.slice(0, dot) : name;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!lower.endsWith('.docx')) {
            throw importError('unsupported format (expected .docx): ' + name);
        }
        const doc = await importDocx(bytes);
        return { content: doc.content, title: title, media: doc.media };
    }

    // ── XML helpers ──

    function is(node, ns, localName) {
        return node && node.nodeType === 1 && node.localName === localName && NS[ns].indexOf(node.namespaceURI) >= 0;
    }

    function child(el, ns, localName) {
        if (!el) return null;
        for (let n = el.firstElementChild; n; n = n.nextElementSibling) {
            if (is(n, ns, localName)) return n;
        }
        return null;
    }

    function attr(el, ns, localName) {
        if (!el) return null;
        for (const uri of NS[ns]) {
            if (el.hasAttributeNS(uri, localName)) return el.getAttributeNS(uri, localName);
        }
        return null;
    }

    function decodeXmlBytes(bytes) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
        if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
        return new TextDecoder('utf-8').decode(bytes); // strips a UTF-8 BOM
    }

    // ── DOCX: package ──

    /** OPC part names are case-insensitive; find a ZIP entry by part path. */
    function findEntry(zip, path) {
        if (zip.has(path)) return zip.get(path);
        const lower = path.toLowerCase();
        for (const [name, entry] of zip) {
            if (name.toLowerCase() === lower) return entry;
        }
        return null;
    }

    async function readXml(zip, path, required) {
        const entry = findEntry(zip, path);
        if (!entry) {
            if (required) throw importError('the file has no ' + path + ' — not a Word document (.docx)');
            return null;
        }
        const xml = new DOMParser().parseFromString(decodeXmlBytes(await entry.read()), 'application/xml');
        if (xml.getElementsByTagName('parsererror').length) throw importError('damaged XML in ' + path);
        return xml;
    }

    /** Resolves a relationship target against the directory of the part that owns it. */
    function resolvePart(baseDir, target) {
        let t = target;
        try { t = decodeURIComponent(target); } catch (_) { /* keep as is */ }
        const segments = t.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
        t.split('/').forEach(function (s) {
            if (s === '..') segments.pop();
            else if (s && s !== '.') segments.push(s);
        });
        return segments.join('/');
    }

    function dirOf(path) {
        const i = path.lastIndexOf('/');
        return i < 0 ? '' : path.slice(0, i);
    }

    /** Relationships of a part: Map(id -> { type, path, external }). */
    async function readRels(zip, partPath) {
        const dir = dirOf(partPath);
        const file = partPath.slice(dir.length).replace(/^\//, '');
        const xml = await readXml(zip, (dir ? dir + '/' : '') + '_rels/' + file + '.rels', false);
        const rels = new Map();
        if (!xml) return rels;
        for (const el of xml.getElementsByTagNameNS(NS.pkg[0], 'Relationship')) {
            const target = el.getAttribute('Target') || '';
            const external = el.getAttribute('TargetMode') === 'External';
            rels.set(el.getAttribute('Id'), {
                type: el.getAttribute('Type') || '',
                path: external ? null : resolvePart(dir, target),
                external: external
            });
        }
        return rels;
    }

    async function importDocx(bytes) {
        let zip;
        try {
            zip = Zip.read(bytes);
        } catch (e) {
            throw importError('not a Word document (.docx): ' + e.message);
        }
        let mainPath = 'word/document.xml';
        for (const rel of (await readRels(zip, '')).values()) {
            if (rel.path && /\/officeDocument$/.test(rel.type)) { mainPath = rel.path; break; }
        }
        const xml = await readXml(zip, mainPath, true);
        const ctx = { zip: zip, rels: await readRels(zip, mainPath), media: {}, mediaByPath: new Map(), counter: 0 };

        const html = [];
        const body = child(xml.documentElement, 'w', 'body');
        for (const el of blockElements(body)) {
            html.push(is(el, 'w', 'p') ? await paragraphHtml(el, ctx) : await tableHtml(el, ctx));
        }
        return { content: html.length ? html.join('') : '<p><br></p>', media: ctx.media };
    }

    // ── DOCX: structure ──
    // Content controls (w:sdt) and custom XML wrap ordinary paragraphs, rows, cells and runs; their
    // content is unwrapped. Tracked deletions (w:del, w:moveFrom) are skipped, insertions kept.

    /** Paragraphs and tables directly in a body-like container, in order. */
    function blockElements(container) {
        const out = [];
        if (!container) return out;
        for (let n = container.firstElementChild; n; n = n.nextElementSibling) {
            if (is(n, 'w', 'p') || is(n, 'w', 'tbl')) out.push(n);
            else if (is(n, 'w', 'sdt')) out.push.apply(out, blockElements(child(n, 'w', 'sdtContent')));
            else if (is(n, 'w', 'customXml')) out.push.apply(out, blockElements(n));
        }
        return out;
    }

    const RUN_CONTAINERS = ['hyperlink', 'smartTag', 'customXml', 'fldSimple', 'ins', 'moveTo'];

    function runsOf(container) {
        const out = [];
        for (let n = container.firstElementChild; n; n = n.nextElementSibling) {
            if (is(n, 'w', 'r')) out.push(n);
            else if (is(n, 'w', 'sdt')) {
                const content = child(n, 'w', 'sdtContent');
                if (content) out.push.apply(out, runsOf(content));
            } else if (n.nodeType === 1 && NS.w.indexOf(n.namespaceURI) >= 0
                && RUN_CONTAINERS.indexOf(n.localName) >= 0) {
                out.push.apply(out, runsOf(n));
            }
        }
        return out;
    }

    async function paragraphHtml(p, ctx) {
        let inner = await runsHtml(runsOf(p), ctx);
        if (!inner.trim()) inner = '<br>';
        const jc = attr(child(child(p, 'w', 'pPr'), 'w', 'jc'), 'w', 'val');
        const align = jc === 'center' ? 'center'
            : jc === 'right' || jc === 'end' ? 'right'
            : jc === 'both' || jc === 'distribute' ? 'justify' : null;
        return '<p' + (align ? ' style="text-align:' + align + '"' : '') + '>' + inner + '</p>';
    }

    async function runsHtml(runs, ctx) {
        let html = '';
        for (const r of runs) html += await runHtml(r, ctx);
        return html;
    }

    /** w:b / w:i: present without a value, or with a true-ish one. */
    function onOff(el) {
        if (!el) return false;
        const v = attr(el, 'w', 'val');
        return !(v === 'false' || v === '0' || v === 'off');
    }

    async function runHtml(r, ctx) {
        let html = '';
        for (const pic of pictures(r)) {
            const id = await mediaId(pic, ctx);
            if (id) html += '<img data-media-id="' + id + '" src="media://' + id + '" alt="">';
        }

        let text = '';
        for (let n = r.firstElementChild; n; n = n.nextElementSibling) {
            if (NS.w.indexOf(n.namespaceURI) < 0) continue;
            switch (n.localName) {
                case 't': text += n.textContent; break;
                case 'tab': case 'ptab': text += '\t'; break;
                case 'br': case 'cr': text += '\n'; break;
                case 'noBreakHyphen': text += '‑'; break;
                case 'footnoteReference': case 'endnoteReference': text += '[' + (attr(n, 'w', 'id') || '') + ']'; break;
            }
        }
        if (!text) return html;

        const rPr = child(r, 'w', 'rPr');
        let piece = esc(text).replace(/\n/g, '<br>');
        const u = attr(child(rPr, 'w', 'u'), 'w', 'val');
        if (u && u !== 'none') piece = '<u>' + piece + '</u>';
        if (onOff(child(rPr, 'w', 'i'))) piece = '<i>' + piece + '</i>';
        if (onOff(child(rPr, 'w', 'b'))) piece = '<b>' + piece + '</b>';
        return html + piece;
    }

    /** pic:pic elements in a run, skipping mc:Fallback copies of the same drawing. */
    function pictures(r) {
        const out = [];
        for (const uri of NS.pic) {
            for (const pic of r.getElementsByTagNameNS(uri, 'pic')) {
                let fallback = false;
                for (let a = pic.parentNode; a && a !== r; a = a.parentNode) {
                    if (is(a, 'mc', 'Fallback')) { fallback = true; break; }
                }
                if (!fallback) out.push(pic);
            }
        }
        return out;
    }

    /** Copies the picture's image into the media store (once per image part); null if unavailable. */
    async function mediaId(pic, ctx) {
        let blip = null;
        for (const uri of NS.a) blip = blip || pic.getElementsByTagNameNS(uri, 'blip')[0];
        const rel = ctx.rels.get(attr(blip, 'r', 'embed'));
        if (!rel || rel.external) return null; // a linked (not embedded) image has no bytes to copy
        if (ctx.mediaByPath.has(rel.path)) return ctx.mediaByPath.get(rel.path);
        const entry = findEntry(ctx.zip, rel.path);
        if (!entry) return null;
        const id = 'img-' + String(++ctx.counter).padStart(4, '0');
        ctx.media[id] = await entry.read();
        ctx.mediaByPath.set(rel.path, id);
        return id;
    }

    async function tableHtml(tbl, ctx) {
        let html = '<table class="doc-table"><tbody>';
        for (const tr of unwrap(tbl, 'tr')) {
            html += '<tr>';
            for (const tc of unwrap(tr, 'tc')) {
                const parts = [];
                for (const p of cellParagraphs(tc)) {
                    const inner = await runsHtml(runsOf(p), ctx);
                    if (inner.trim()) parts.push(inner);
                }
                const content = parts.join(' ').trim();
                const fill = cellFill(tc, tbl);
                html += (fill ? '<td style="background-color:' + fill + '">' : '<td>')
                    + (content || '<br>') + '</td>';
            }
            html += '</tr>';
        }
        return html + '</tbody></table>';
    }

    /** Children with this w: name, looking through content controls / custom XML wrappers. */
    function unwrap(el, localName) {
        const out = [];
        for (let n = el.firstElementChild; n; n = n.nextElementSibling) {
            if (is(n, 'w', localName)) out.push(n);
            else if (is(n, 'w', 'sdt')) {
                const content = child(n, 'w', 'sdtContent');
                if (content) out.push.apply(out, unwrap(content, localName));
            } else if (is(n, 'w', 'customXml')) out.push.apply(out, unwrap(n, localName));
        }
        return out;
    }

    /** A cell's paragraphs; a nested table contributes its cells' text inline. */
    function cellParagraphs(tc) {
        const out = [];
        for (const el of blockElements(tc)) {
            if (is(el, 'w', 'p')) out.push(el);
            else unwrap(el, 'tr').forEach(function (tr) {
                unwrap(tr, 'tc').forEach(function (inner) { out.push.apply(out, cellParagraphs(inner)); });
            });
        }
        return out;
    }

    // ── DOCX: cell shading ──
    // Word keeps a cell's fill in <w:tcPr><w:shd w:val=… w:fill=… w:color=…/>: `fill` is the background,
    // `color` the pattern drawn over it, `val` how much of the pattern covers it. Theme fills are also
    // written out resolved into `fill`. Shading from table styles (styles.xml) is not resolved.

    /** CSS colour for the cell's fill, or null. A cell without its own shading takes the table's. */
    function cellFill(tc, tbl) {
        const own = shading(child(tc, 'w', 'tcPr'));
        const fill = own !== null ? own : shading(child(tbl, 'w', 'tblPr'));
        return fill || null;
    }

    /** null = no w:shd here (inherit); '' = shading present but no colour ("nil", auto). */
    function shading(props) {
        const shd = child(props, 'w', 'shd');
        if (!shd) return null;
        return shdColor(attr(shd, 'w', 'val'), attr(shd, 'w', 'fill'), attr(shd, 'w', 'color')) || '';
    }

    /**
     * The flat colour a shading renders as: the pattern colour blended over the fill by the share of
     * the cell the pattern covers. "auto" is white for the fill and black for the pattern, as in Word.
     */
    function shdColor(val, fill, color) {
        if (val === 'nil') return null;
        const bg = rgb(fill);
        const p = coverage(val);
        if (p <= 0) return bg ? hex(bg) : null;
        const base = bg || [255, 255, 255];
        const pattern = rgb(color) || [0, 0, 0];
        return hex([0, 1, 2].map(function (i) { return Math.round(base[i] * (1 - p) + pattern[i] * p); }));
    }

    function coverage(val) {
        if (!val || val === 'clear') return 0;
        if (val === 'solid') return 1;
        if (val.startsWith('pct')) {
            const n = /^\d+$/.test(val.slice(3)) ? parseInt(val.slice(3), 10) : NaN;
            return isNaN(n) ? 0 : n / 100;
        }
        // Stripe / cross hatching can't be drawn as a flat fill; approximate by how much ink it has.
        return val.startsWith('thin') ? 0.25 : 0.5;
    }

    function rgb(h) {
        if (!h || !/^[0-9A-Fa-f]{6}$/.test(h)) return null; // "auto", missing, or malformed
        const v = parseInt(h, 16);
        return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }

    function hex(c) {
        return '#' + c.map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
    }

    return { importFile: importFile, shdColor: shdColor };
})();
