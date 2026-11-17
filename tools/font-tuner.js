/* Font tuner — a development helper, never loaded by the app.
 *
 * One state object holds every knob. Each knob writes a CSS custom property on :root, which the
 * preview's rules (font-tuner.css, copies of the .editor rules) read, so the document on the right
 * is the real thing rather than a mock-up. The same state is printed as CSS for css/style.css:
 * by default only the values that differ from the project's current ones, so the snippet can be
 * pasted in without carrying noise with it.
 *
 * The choices survive a reload in localStorage under 'sd-font-tuner'.
 */
(function () {
    'use strict';

    const $ = function (id) { return document.getElementById(id); };
    const STORE = 'sd-font-tuner';

    /* The project's current values — the reset target, and the baseline the printed CSS is
     * diffed against. Keep in step with css/style.css. */
    const PROJECT = {
        family: '-apple-system, "Segoe UI", Roboto, Arial, sans-serif',
        familyCustom: '',
        size: 16,
        line: 1.6,
        letter: 0,
        word: 0,
        weight: 400,
        para: 12,
        align: 'left',
        hyphens: 'manual',
        ink: '#1f2328',
        page: '#ffffff',
        link: '#2459c4',
        smooth: false,

        stretch: 100,
        axes: {},            /* tag -> value, for whatever axes the loaded font declares */
        axesOn: false,
        scaleX: 1,
        scaleY: 1.14,        /* the project stretches the document's glyphs 14% taller */
        keepPitch: true,
        xheight: 0,

        h1: 2,
        h2: 1.5,
        h3: 1.17,
        hweight: 700,
        hline: 1.2,
        htrack: 0,
        hstretch: 100,
        hfamily: '',

        width: 820,
        padv: 64,
        padh: 72,
        print: 12
    };

    /* Stacks offered in both family pickers. Nothing is downloaded: these are the faces that
     * Windows, macOS and Linux ship, so a reader sees what is tuned here. */
    const FAMILIES = [
        ['-apple-system, "Segoe UI", Roboto, Arial, sans-serif', 'System sans (the project default)'],
        ['"Segoe UI Variable Text", "Segoe UI", sans-serif', 'Segoe UI Variable Text'],
        ['"Segoe UI Semilight", "Segoe UI", sans-serif', 'Segoe UI Semilight'],
        ['Bahnschrift, "DIN Next", sans-serif', 'Bahnschrift — font-stretch really squeezes it'],
        ['Arial, Helvetica, sans-serif', 'Arial — font-stretch picks Arial Narrow'],
        ['"Arial Narrow", Arial, sans-serif', 'Arial Narrow — a true condensed face'],
        ['Verdana, Geneva, sans-serif', 'Verdana — wide, large x-height'],
        ['Tahoma, Geneva, sans-serif', 'Tahoma — narrower Verdana'],
        ['Calibri, Candara, sans-serif', 'Calibri'],
        ['"Trebuchet MS", sans-serif', 'Trebuchet MS'],
        ['Georgia, "Times New Roman", serif', 'Georgia — serif, sturdy on screen'],
        ['"Times New Roman", Times, serif', 'Times New Roman'],
        ['Cambria, Georgia, serif', 'Cambria'],
        ['Constantia, Georgia, serif', 'Constantia'],
        ['Garamond, "EB Garamond", Georgia, serif', 'Garamond'],
        ['Palatino, "Palatino Linotype", "Book Antiqua", serif', 'Palatino'],
        ['"Bookman Old Style", Georgia, serif', 'Bookman Old Style'],
        ['ui-monospace, Consolas, "Cascadia Mono", monospace', 'Monospace']
    ];

    /* Starting points worth a look; each one is a patch over PROJECT. */
    const PRESETS = {
        'Project default': {},
        'Roomy sans': { size: 17, line: 1.75, letter: 0.005, para: 16, width: 780 },
        'Compact sans': { size: 15, line: 1.45, letter: 0, para: 9, width: 860 },
        'Narrow and tall': { stretch: 88, scaleX: 0.94, scaleY: 1.04, line: 1.65, letter: 0.004 },
        'Wide and short': { stretch: 112, scaleX: 1.06, scaleY: 0.97, line: 1.5, letter: -0.004 },
        'Georgia book': {
            family: 'Georgia, "Times New Roman", serif', size: 17.5, line: 1.7,
            letter: 0, para: 14, width: 740, align: 'justify', hyphens: 'auto',
            hfamily: 'Georgia, "Times New Roman", serif', h1: 2.1, hweight: 600
        },
        'Typewriter': {
            family: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
            size: 15, line: 1.7, para: 14, width: 760, hweight: 700
        }
    };

    /* How each knob reaches the page: the custom property it feeds and the unit it carries. */
    const VARS = {
        family: ['--t-family', raw],
        size: ['--t-size', px],
        line: ['--t-line', num],
        letter: ['--t-letter', em],
        word: ['--t-word', em],
        weight: ['--t-weight', num],
        para: ['--t-para', px],
        align: ['--t-align', raw],
        hyphens: ['--t-hyphens', raw],
        ink: ['--t-ink', raw],
        page: ['--t-page', raw],
        link: ['--t-link', raw],
        stretch: ['--t-stretch', pct],
        scaleX: ['--t-scale-x', num],
        scaleY: ['--t-scale-y', num],
        h1: ['--t-h1', em],
        h2: ['--t-h2', em],
        h3: ['--t-h3', em],
        hweight: ['--t-hweight', num],
        hline: ['--t-hline', num],
        htrack: ['--t-htrack', em],
        hstretch: ['--t-hstretch', pct],
        width: ['--t-width', px],
        padv: ['--t-padv', px],
        padh: ['--t-padh', px]
    };

    function raw(v) { return String(v); }
    function num(v) { return String(v); }
    function px(v) { return v + 'px'; }
    function em(v) { return v + 'em'; }
    function pct(v) { return v + '%'; }

    const state = Object.assign({}, PROJECT);
    const root = document.documentElement;

    /* ── wiring ── */

    function fillFamilies() {
        const body = $('f-family');
        const head = $('f-hfamily');
        head.appendChild(new Option('same as body', ''));
        FAMILIES.forEach(function (f) {
            body.appendChild(new Option(f[1], f[0]));
            head.appendChild(new Option(f[1], f[0]));
        });
        const pick = $('preset-pick');
        Object.keys(PRESETS).forEach(function (name) { pick.appendChild(new Option(name, name)); });
    }

    const controls = [];

    function collectControls() {
        const nodes = document.querySelectorAll('[data-var]');
        Array.prototype.forEach.call(nodes, function (el) {
            const key = el.getAttribute('data-var');
            controls.push({ el: el, key: key });
            const event = (el.type === 'range' || el.type === 'color' || el.type === 'text')
                ? 'input' : 'change';
            el.addEventListener(event, function () {
                state[key] = read(el);
                apply();
                save();
            });
        });
    }

    function read(el) {
        if (el.type === 'checkbox') { return el.checked; }
        if (el.type === 'range') { return parseFloat(el.value); }
        return el.value;
    }

    function writeControls() {
        controls.forEach(function (c) {
            const v = state[c.key];
            if (c.el.type === 'checkbox') { c.el.checked = !!v; } else { c.el.value = v; }
        });
        /* A custom stack that is not one of the offered options leaves the select showing the
         * last match; the custom field is what counts, so say so in the select. */
        if (!$('f-family').value) { $('f-family').value = PROJECT.family; }
    }

    /* ── the live preview ── */

    function effectiveFamily() {
        const custom = String(state.familyCustom || '').trim();
        return custom || state.family;
    }

    /* Only the axes moved away from the font's own default are named: an axis left where the font
     * put it changes nothing, and writing it out only makes the CSS harder to read. */
    function axesValue() {
        if (!state.axesOn) { return 'normal'; }
        const parts = [];
        (loadedAxes() || []).forEach(function (a) {
            const v = state.axes[a.tag];
            if (v !== undefined && v !== a.def) { parts.push('"' + a.tag + '" ' + v); }
        });
        return parts.length ? parts.join(', ') : 'normal';
    }

    function loadedAxes() {
        return dropped && dropped.axes && dropped.axes.length ? dropped.axes : null;
    }

    function apply() {
        Object.keys(VARS).forEach(function (key) {
            root.style.setProperty(VARS[key][0], VARS[key][1](state[key]));
        });
        root.style.setProperty('--t-family', effectiveFamily());
        root.style.setProperty('--t-hfamily', state.hfamily || 'inherit');
        root.style.setProperty('--t-axes', axesValue());
        root.style.setProperty('--t-xheight', state.xheight > 0 ? String(state.xheight) : 'none');
        root.style.setProperty('--t-pitch-fix', state.keepPitch ? String(state.scaleY) : '1');
        root.style.setProperty('--t-smoothing', state.smooth ? 'antialiased' : 'auto');
        root.style.setProperty('--t-rendering', state.smooth ? 'optimizeLegibility' : 'auto');
        showNumbers();
        probeAxes();
        $('out').textContent = buildCss();
    }

    const FMT = {
        size: function (v) { return v + 'px'; },
        line: function (v) { return v.toFixed(2); },
        letter: function (v) { return v.toFixed(3) + 'em'; },
        word: function (v) { return v.toFixed(2) + 'em'; },
        weight: String,
        para: function (v) { return v + 'px'; },
        stretch: function (v) { return v + '%'; },
        scaleX: function (v) { return v.toFixed(2) + '×'; },
        scaleY: function (v) { return v.toFixed(2) + '×'; },
        xheight: function (v) { return v > 0 ? v.toFixed(2) : 'off'; },
        h1: function (v) { return v.toFixed(2) + 'em'; },
        h2: function (v) { return v.toFixed(2) + 'em'; },
        h3: function (v) { return v.toFixed(2) + 'em'; },
        hweight: String,
        hline: function (v) { return v.toFixed(2); },
        htrack: function (v) { return v.toFixed(3) + 'em'; },
        hstretch: function (v) { return v + '%'; },
        width: function (v) { return v + 'px'; },
        padv: function (v) { return v + 'px'; },
        padh: function (v) { return v + 'px'; },
        print: function (v) { return v + 'pt'; }
    };

    const OUTPUTS = {
        size: 'o-size', line: 'o-line', letter: 'o-letter', word: 'o-word', weight: 'o-weight',
        para: 'o-para', stretch: 'o-stretch',
        scaleX: 'o-scalex', scaleY: 'o-scaley', xheight: 'o-xheight',
        h1: 'o-h1', h2: 'o-h2', h3: 'o-h3', hweight: 'o-hweight', hline: 'o-hline',
        htrack: 'o-htrack', hstretch: 'o-hstretch', width: 'o-width', padv: 'o-padv',
        padh: 'o-padh', print: 'o-print'
    };

    function showNumbers() {
        Object.keys(OUTPUTS).forEach(function (key) {
            const el = $(OUTPUTS[key]);
            if (el) { el.textContent = FMT[key](state[key]); }
        });
    }

    /* ── does this family actually answer to the width knobs? ──
     * A font with no condensed face and no wdth axis silently ignores font-stretch, and the knob
     * then looks broken. So measure a sample string at both ends of each axis: if the width moves,
     * the family answers. Slant is measured too — it shifts the advance a little when it works. */
    let lastProbe = '';

    function measure(styles) {
        const span = document.createElement('span');
        span.textContent = 'Handgloves 0123456789 adhesion';
        span.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:pre;font-size:40px;';
        span.style.fontFamily = effectiveFamily();
        Object.keys(styles).forEach(function (k) { span.style.setProperty(k, styles[k]); });
        document.body.appendChild(span);
        const w = span.getBoundingClientRect().width;
        span.remove();
        return w;
    }

    function answers(lo, hi) {
        return Math.abs(measure(lo) - measure(hi)) > 0.75;
    }

    function probeAxes() {
        const fam = effectiveFamily();
        if (fam === lastProbe) { return; }
        lastProbe = fam;

        const got = [];
        const missing = [];

        /* The font's own fvar table beats the measurement: an axis can reshape a glyph without
         * moving the advance width (weight often does exactly that in a DIN-like face), and the
         * probe would then call a working axis dead. */
        if (dropped && dropped.axes && effectiveFamily().indexOf(DROP_FAMILY) !== -1) {
            const have = dropped.axes.map(function (a) { return a.tag; });
            const note = $('axis-report');
            note.textContent = have.length
                ? ('This font carries: ' + have.join(', ')
                    + '. font-stretch drives wdth, font-weight drives wght. '
                    + 'scaleX / scaleY work on top of them.')
                : 'This font has no variation axes — only scaleX / scaleY can reshape it.';
            note.className = have.length ? 'hint good' : 'hint warn';
            return;
        }

        (answers({ 'font-stretch': '60%' }, { 'font-stretch': '160%' }) ? got : missing)
            .push('font-stretch');
        (answers({ 'font-variation-settings': '"wdth" 60' }, { 'font-variation-settings': '"wdth" 160' })
            ? got : missing).push('wdth');
        (answers({ 'font-variation-settings': '"wght" 200' }, { 'font-variation-settings': '"wght" 800' })
            ? got : missing).push('wght');
        (answers({ 'font-variation-settings': '"opsz" 8' }, { 'font-variation-settings': '"opsz" 72' })
            ? got : missing).push('opsz');
        (answers({ 'font-variation-settings': '"slnt" 0' }, { 'font-variation-settings': '"slnt" -15' })
            ? got : missing).push('slnt');

        const note = $('axis-report');
        const parts = [];
        if (got.length) { parts.push('This family answers to: ' + got.join(', ') + '.'); }
        if (missing.length) { parts.push('Ignored here: ' + missing.join(', ') + '.'); }
        if (!got.length) {
            parts.push('An installed family hands Chrome no axes — load a font file below to get them.');
        }
        parts.push('scaleX / scaleY always work — they scale the drawn glyphs.');
        note.textContent = parts.join(' ');
        note.className = got.length ? 'hint good' : 'hint warn';
    }

    /* ── a font file, so the axes have something to move ──
     * Chrome exposes variation axes only for a font it loaded itself; a family picked up from the
     * system is a flat face as far as font-variation-settings is concerned. So the file is handed
     * to FontFace under a name of our own, and its fvar table is read for the axes it really has
     * and the range each one allows — the sliders are then clamped to those ranges instead of to
     * the guesses in the HTML. A .woff2 is compressed, so there is nothing to read in it here:
     * it still renders, and the probe above reports what moved. */
    const DROP_FAMILY = 'SD Tuner Font';
    let dropped = null;            // { file, axes } while a font is loaded in this tab

    const AXIS_SLIDER = { wdth: 'f-wdth', wght: 'f-wght', opsz: 'f-opsz', slnt: 'f-slnt' };

    function readAxes(buffer) {
        const view = new DataView(buffer);
        const tag = view.getUint32(0);
        /* 0x00010000 TrueType outlines, 'OTTO' CFF, 'ttcf' a collection, 'wOF2' compressed. */
        if (tag !== 0x00010000 && tag !== 0x4f54544f) { return null; }
        const count = view.getUint16(4);
        let fvar = 0;
        for (let i = 0; i < count; i++) {
            const rec = 12 + i * 16;
            if (view.getUint32(rec) === 0x66766172) { fvar = view.getUint32(rec + 8); break; } // 'fvar'
        }
        if (!fvar) { return []; }
        const axesAt = fvar + view.getUint16(fvar + 4);
        const axisCount = view.getUint16(fvar + 8);
        const axisSize = view.getUint16(fvar + 10);
        const axes = [];
        for (let i = 0; i < axisCount; i++) {
            const at = axesAt + i * axisSize;
            const name = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1),
                view.getUint8(at + 2), view.getUint8(at + 3));
            axes.push({
                tag: name,
                min: view.getInt32(at + 4) / 65536,
                def: view.getInt32(at + 8) / 65536,
                max: view.getInt32(at + 12) / 65536
            });
        }
        return axes;
    }

    /* What the four-letter tags mean. The first five are registered; the rest are Roboto Flex's
       own, and they are the interesting ones here — a font that draws its letters taller is
       exactly what a transform cannot give. */
    const AXIS_NAME = {
        wght: 'weight', wdth: 'width', opsz: 'optical size', slnt: 'slant', ital: 'italic',
        GRAD: 'grade — weight without changing the width',
        XOPQ: 'thickness of the upright strokes',
        YOPQ: 'thickness of the horizontal strokes',
        XTRA: 'width of the counters (the space inside a letter)',
        YTAS: 'height of the ascenders (b, d, k)',
        YTDE: 'depth of the descenders (p, y)',
        YTLC: 'height of the lower case — the x-height',
        YTUC: 'height of the capitals',
        YTFI: 'height of the figures'
    };

    /* One slider per axis the font declares, built from its fvar table rather than guessed. */
    function renderAxes(axes) {
        const host = $('axis-list');
        host.textContent = '';
        if (!axes || !axes.length) {
            const p = document.createElement('p');
            p.className = 'hint warn';
            p.textContent = 'No axes to show: this font has none, or it is compressed and could '
                + 'not be read. Load a .ttf or .otf of a variable font.';
            host.appendChild(p);
            return;
        }
        axes.forEach(function (a) {
            if (state.axes[a.tag] === undefined) { state.axes[a.tag] = a.def; }
            state.axes[a.tag] = Math.min(Math.max(state.axes[a.tag], a.min), a.max);

            const ctl = document.createElement('div');
            ctl.className = 'ctl';
            ctl.setAttribute('data-range', '');

            const label = document.createElement('label');
            label.htmlFor = 'axis-' + a.tag;
            const name = document.createElement('span');
            name.innerHTML = '<code>' + a.tag + '</code> '
                + (AXIS_NAME[a.tag] || 'an axis of this font’s own');
            const out = document.createElement('output');
            label.appendChild(name);
            label.appendChild(out);

            const input = document.createElement('input');
            input.type = 'range';
            input.id = 'axis-' + a.tag;
            input.min = a.min;
            input.max = a.max;
            input.step = (a.max - a.min) > 20 ? 1 : 0.5;
            input.value = state.axes[a.tag];

            const show = function () {
                const v = state.axes[a.tag];
                out.textContent = v + (v === a.def ? ' (default)' : '');
            };
            input.addEventListener('input', function () {
                state.axes[a.tag] = parseFloat(input.value);
                show();
                apply();
                save();
            });
            show();

            ctl.appendChild(label);
            ctl.appendChild(input);
            host.appendChild(ctl);
        });
    }

    /* Roboto Flex lives in tools/fonts/ (git ignores it — 1.7 MB is not the app's business yet).
     * Loading it as the page opens is the whole point of this section: it is the only font here
     * whose axes actually move, and the only way to see letters drawn taller rather than
     * stretched. If it is missing, the page says so and still works with anything picked by hand. */
    function loadBundledFont() {
        fetch('fonts/RobotoFlex.ttf').then(function (r) {
            if (!r.ok) { throw new Error('HTTP ' + r.status); }
            return r.blob();
        }).then(function (blob) {
            loadFontFile(new File([blob], 'RobotoFlex.ttf', { type: 'font/ttf' }));
        }).catch(function (err) {
            const note = $('font-file-note');
            note.textContent = 'Roboto Flex was not loaded from tools/fonts/RobotoFlex.ttf ('
                + err.message + '). Pick a font file by hand, or serve the page over the local '
                + 'server rather than opening it from disk.';
            note.className = 'hint warn';
            renderAxes(null);
        });
    }

    /* Once a font is loaded it joins both family pickers, so the stack can be switched away from
     * it and back without loading it again. */
    function offerLoadedFamily(label) {
        const value = '"' + DROP_FAMILY + '", sans-serif';
        [$('f-family'), $('f-hfamily')].forEach(function (sel) {
            let opt = sel.querySelector('option[data-loaded]');
            if (!opt) {
                opt = new Option('', value);
                opt.setAttribute('data-loaded', '');
                sel.insertBefore(opt, sel.firstChild);
            }
            opt.value = value;
            opt.textContent = label + ' — loaded here, axes work';
        });
    }

    function loadFontFile(file) {
        const note = $('font-file-note');
        note.textContent = 'reading ' + file.name + '…';
        note.className = 'hint';
        file.arrayBuffer().then(function (buffer) {
            const face = new FontFace(DROP_FAMILY, buffer);
            return face.load().then(function (loaded) {
                document.fonts.add(loaded);
                let axes = null;
                try { axes = readAxes(buffer); } catch (e) { axes = null; }
                dropped = { file: file, axes: axes };
                renderAxes(axes);
                offerLoadedFamily(file.name.replace(/\.[^.]+$/, ''));
                state.family = '"' + DROP_FAMILY + '", sans-serif';
                state.familyCustom = '';
                state.axesOn = true;
                writeControls();
                lastProbe = '';
                apply();
                save();
                if (axes && axes.length) {
                    note.textContent = file.name + ' — axes: ' + axes.map(function (a) {
                        return a.tag + ' ' + a.min + '…' + a.max + ' (default ' + a.def + ')';
                    }).join(', ') + '.';
                    note.className = 'hint good';
                } else if (axes) {
                    note.textContent = file.name + ' loaded, but it has no fvar table — '
                        + 'it is a static font, so only scaleX / scaleY can reshape it.';
                    note.className = 'hint warn';
                } else {
                    note.textContent = file.name + ' loaded. Compressed or packed, so its axes '
                        + 'could not be read here — the sliders keep their default ranges and the '
                        + 'report above says what actually moved.';
                    note.className = 'hint';
                }
            });
        }).catch(function (err) {
            note.textContent = 'Could not load ' + file.name + ': ' + err.message;
            note.className = 'hint warn';
        });
    }

    /* ── the CSS to paste into css/style.css ── */

    function changed(key) { return state[key] !== PROJECT[key]; }

    function buildCss() {
        const all = $('opt-all').checked;
        const lines = [];
        const editor = [];
        const keep = function (key, text) { if (all || changed(key)) { editor.push('    ' + text); } };

        /* A font loaded from a file lives in this tab only; for the app it has to sit in the
         * project next to the stylesheet, so the snippet starts with the @font-face that gets it
         * there — with the weight and width ranges the fvar table reported, which is what lets
         * font-weight and font-stretch drive the axes once it is a real web font. */
        let fam = effectiveFamily();
        if (dropped && fam.indexOf(DROP_FAMILY) !== -1) {
            const name = dropped.file.name;
            const ext = name.toLowerCase().split('.').pop();
            const fmt = { woff2: 'woff2', woff: 'woff', otf: 'opentype', ttf: 'truetype' }[ext] || 'truetype';
            const axis = function (tag) {
                return (dropped.axes || []).filter(function (a) { return a.tag === tag; })[0];
            };
            const face = ['@font-face {', '    font-family: "Tuned";',
                '    src: url("fonts/' + name + '") format("' + fmt + '");'];
            const wght = axis('wght');
            const wdth = axis('wdth');
            if (wght) { face.push('    font-weight: ' + wght.min + ' ' + wght.max + ';'); }
            if (wdth) { face.push('    font-stretch: ' + wdth.min + '% ' + wdth.max + '%;'); }
            face.push('    font-display: swap;', '}');
            lines.push('/* Copy ' + name + ' into css/fonts/ first — the app ships no fonts today,',
                '   and the page must keep working offline, so nothing may be fetched. */',
                face.join('\n'), '');
            fam = '"Tuned", ' + (fam.split(',').slice(1).join(',').trim() || 'sans-serif');
        }
        if (all || fam !== PROJECT.family) { editor.push('    font-family: ' + fam + ';'); }
        keep('size', 'font-size: ' + state.size + 'px;');
        keep('line', 'line-height: ' + state.line + ';');
        keep('weight', 'font-weight: ' + state.weight + ';');
        keep('letter', 'letter-spacing: ' + state.letter + 'em;');
        keep('word', 'word-spacing: ' + state.word + 'em;');
        keep('align', 'text-align: ' + state.align + ';');
        keep('hyphens', 'hyphens: ' + state.hyphens + ';');
        keep('ink', 'color: ' + state.ink + ';');
        keep('stretch', 'font-stretch: ' + state.stretch + '%;');
        if (state.axesOn) { editor.push('    font-variation-settings: ' + axesValue() + ';'); }
        if (all || state.xheight > 0) {
            editor.push('    font-size-adjust: ' + (state.xheight > 0 ? state.xheight : 'none') + ';');
        }
        if (all || state.smooth) {
            editor.push('    -webkit-font-smoothing: ' + (state.smooth ? 'antialiased' : 'auto') + ';');
            editor.push('    text-rendering: ' + (state.smooth ? 'optimizeLegibility' : 'auto') + ';');
        }
        keep('width', 'max-width: ' + state.width + 'px;');
        if (all || changed('padv') || changed('padh')) {
            editor.push('    padding: ' + state.padv + 'px ' + state.padh + 'px;');
        }

        if (editor.length) { lines.push('.editor {', editor.join('\n'), '}'); }

        if (all || changed('page')) {
            lines.push('', '/* the page colour lives on a variable shared with the editor\'s own rules */',
                ':root { --page: ' + state.page + '; }');
        }
        if (all || changed('para')) {
            lines.push('', '.editor p { margin: 0 0 ' + state.para + 'px; }');
        }
        if (all || changed('link')) {
            lines.push('', '.editor a { color: ' + state.link + '; }');
        }

        const head = [];
        if (all || state.hfamily) { head.push('    font-family: ' + (state.hfamily || 'inherit') + ';'); }
        if (all || changed('hweight')) { head.push('    font-weight: ' + state.hweight + ';'); }
        if (all || changed('hline')) { head.push('    line-height: ' + state.hline + ';'); }
        if (all || changed('htrack')) { head.push('    letter-spacing: ' + state.htrack + 'em;'); }
        if (all || changed('hstretch')) { head.push('    font-stretch: ' + state.hstretch + '%;'); }
        if (head.length) {
            lines.push('', '.editor h1, .editor h2, .editor h3 {', head.join('\n'), '}');
        }
        if (all || changed('h1')) { lines.push('', '.editor h1 { font-size: ' + state.h1 + 'em; }'); }
        if (all || changed('h2')) { lines.push('.editor h2 { font-size: ' + state.h2 + 'em; }'); }
        if (all || changed('h3')) { lines.push('.editor h3 { font-size: ' + state.h3 + 'em; }'); }

        if (all || changed('scaleX') || changed('scaleY')) {
            lines.push('',
                '/* Squeezing the glyphs themselves. The scale belongs on a wrapper INSIDE the',
                '   editor, not on .editor — a transform on the padded page would scale its border',
                '   and shadow too, and a transform on a contenteditable can nudge the caret.',
                '   The width is divided back out so the measure stays where it was. */',
                '.editor > .doc-scale {',
                '    transform: scale(' + state.scaleX + ', ' + state.scaleY + ');',
                '    transform-origin: top left;',
                '    width: calc(100% / ' + state.scaleX + ');',
                '}');
            if (state.keepPitch && state.scaleY !== 1) {
                lines.push('',
                    '/* The taller glyphs would drag the line spacing along with them; dividing the',
                    '   stretch back out of the line height keeps the lines where they were. */',
                    '.editor { line-height: ' + (state.line / state.scaleY).toFixed(4) + '; }');
            }
        }

        if (all || changed('print')) {
            lines.push('', '@media print {', '    .editor { font-size: ' + state.print + 'pt; }', '}');
        }

        if (!lines.length) {
            return '/* Nothing changed yet — the knobs are still on the project\'s own values. */';
        }
        return lines.join('\n');
    }

    /* ── persistence, presets, buttons ── */

    function save() {
        try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* private mode */ }
    }

    function load() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { saved = null; }
        if (saved) {
            Object.keys(PROJECT).forEach(function (k) {
                if (saved[k] !== undefined && saved[k] !== null) { state[k] = saved[k]; }
            });
        }
        /* A font loaded from a file cannot survive the reload — the file is not ours to re-open —
         * so a stack still naming it would silently fall back to sans-serif. */
        if (String(state.familyCustom).indexOf(DROP_FAMILY) !== -1) {
            state.familyCustom = PROJECT.familyCustom;
            state.axesOn = PROJECT.axesOn;
        }
    }

    function usePreset(name) {
        const patch = PRESETS[name];
        if (!patch) { return; }
        Object.assign(state, PROJECT, patch);
        writeControls();
        apply();
        save();
    }

    function bindButtons() {
        $('btn-reset').addEventListener('click', function () {
            Object.assign(state, PROJECT);
            $('preset-pick').value = '';
            writeControls();
            apply();
            save();
        });

        $('preset-pick').addEventListener('change', function () { usePreset(this.value); });

        $('f-font-file').addEventListener('change', function () {
            if (this.files && this.files[0]) { loadFontFile(this.files[0]); }
        });

        $('opt-all').addEventListener('change', function () { $('out').textContent = buildCss(); });

        $('btn-copy').addEventListener('click', function () {
            const text = buildCss();
            const done = function (ok) {
                $('out-note').textContent = ok
                    ? 'Copied — paste it into css/style.css.'
                    : 'Could not reach the clipboard; select the block above and copy it by hand.';
                $('out-note').className = ok ? 'hint good' : 'hint warn';
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () { done(true); },
                    function () { done(false); });
            } else {
                done(false);
            }
        });
    }

    /* ── go ── */
    fillFamilies();
    load();
    collectControls();
    /* Picking a family from the list means that family, so a stack typed earlier steps aside. */
    $('f-family').addEventListener('change', function () {
        state.familyCustom = '';
        $('f-family-custom').value = '';
        apply();
        save();
    });
    writeControls();
    bindButtons();
    renderAxes(loadedAxes());
    apply();
    loadBundledFont();
})();
