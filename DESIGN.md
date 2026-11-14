# Design: a rich-text editor with optional encryption

> Code name: **SecureDoc**. A static web page: HTML + CSS + JavaScript, with no server-side
> logic, no build step and no runtime. The user interface is in English.

---

## 1. Summary

Requirements: a single file with optional 12-word passphrase protection, privacy when protected,
DOCX import, documents of up to hundreds of pages.

**Architecture — everything in the browser.** The `index.html` page itself edits, encrypts,
decrypts and imports documents. Neither the passphrase, nor the text, nor imported files are sent
anywhere: the page makes no network requests at all.

```
┌─────────────────────────────── browser ─────────────────────────────────────┐
│  index.html                                                                 │
│  ├─ editor-core.js contenteditable editor (shared with webchat)             │
│  ├─ app.js      open / create / import / save / change protection           │
│  ├─ sdoc.js     .sdoc format: Argon2id + AES-256-GCM (WebCrypto)            │
│  ├─ zip.js      ZIP container on CompressionStream                          │
│  ├─ import.js   DOCX (own OOXML parsing)                                    │
│  └─ vendor/     hash-wasm (Argon2) — in the repo, not from a CDN            │
└──────────────┬───────────────────────────────────────────▲──────────────────┘
               │ <input type=file>                         │ showSaveFilePicker /
               ▼                                           │ download
        ┌──────────────┐                            ┌──────┴────────┐
        │ document.sdoc│ ←── protected or plain ──→ │ document.sdoc │
        └──────────────┘                            └───────────────┘
```

**How to run:** open **`index.html`** — `run.bat` on Windows does exactly that and nothing else.
There is no server in the project: the page is the application, and it runs from disk, including
the bundled font (§4a), which Chrome does load over `file://`
(`document.fonts.check('16px "Roboto Flex"')` is true there).

Open it in a blank tab (double-click, Ctrl+O, or drop it on the tab bar): dropped onto the app's
own start screen the file is swallowed, since that screen catches drops so the browser never
navigates away (§7).

The one thing a `file://` page costs is the Web Worker, which Chrome will not start from that
scheme: Argon2 then runs on the main thread, and a save holds the page for a second or two behind
a modal that says so (§6.3).

The same folder can be put on **any static HTTPS host** as it is; there the worker starts and
saving no longer blocks.

All paths in `index.html` are **relative** (`js/app.js`); otherwise nothing loads from disk.

---

## 2. Technology stack

| Layer | Choice | Why |
|------|-------|-------|
| Application | static HTML/CSS/JS, no frameworks, no build | nothing to install, nothing to compile |
| Document fonts | Roboto Flex and Roboto Serif, variable fonts in the repo (`css/fonts/`, SIL OFL 1.1) | consistent drawing and line breaking on every machine; Flex is the default and Serif is selectable (§4a) |
| Editor | `contenteditable` + `document.execCommand` | tables, images, alignment with no dependencies |
| KDF | `hash-wasm` 4.12.0 — Argon2id (WASM embedded in the JS file) | browsers have no Argon2; works from `file://` too |
| Encryption | WebCrypto AES-256-GCM | built into the browser, non-extractable keys |
| Container | own ZIP on `CompressionStream` / `DecompressionStream` (`zip.js`) | no dependencies |
| Mnemonic (12 words) | BIP-39 English wordlist (2048 words, `js/wordlist.js`) | strong entropy, a passphrase you can write down |
| DOCX import | own OOXML parsing (`import.js`: `zip.js` + `DOMParser`) | no dependencies, the file never leaves the page |

---

## 3. Project layout

```
index.html          — markup: open/create/import screen, editor, dialogs
icons/              — tab icon (16, 32 px) and apple-touch-icon (256 px), PNG
css/
├─ style.css
└─ fonts/
   ├─ RobotoFlex.ttf      — the default document font (§4a): variable, 1.77 MB
   ├─ OFL.txt             — the Roboto Flex licence
   ├─ RobotoSerif.ttf     — the selectable serif font (§4a): variable, 3.94 MB
   └─ RobotoSerif-OFL.txt — the Roboto Serif licence
js/
├─ wordlist.js      — BIP-39 English (2048 words)
├─ passphrase.js    — generating / normalising / validating the 12 words
├─ byte-utils.js    — ByteUtils.concat / toBase64, used by zip.js and sdoc.js (shared with webchat)
├─ zip.js           — ZIP: reading (via the central directory) and writing
├─ sdoc.js          — .sdoc format and encryption (Sdoc.encode / Sdoc.decode / Sdoc.prepare)
├─ kdf-worker.js    — Argon2id in a Web Worker, so the page doesn't freeze while a key is derived
├─ import.js        — DOCX → HTML + images (Importer.importFile)
├─ doc-html.js      — the document HTML contract: allow-list rebuild for load / paste / save (§6.6, §12)
├─ editor-core.js   — editor commands, image store, serialize / load (shared with webchat, §12)
├─ app.js           — workflows: open, create, import, save, PDF printing, passphrase change
└─ vendor/
   ├─ hash-wasm-argon2-4.12.0.umd.min.js
   └─ SHA256SUMS     — hashes of every file in vendor/
testdata/           — .sdoc samples for manual compatibility checks (§6.6)
tools/              — development helpers the app never loads (§13): the font tuner
run.bat             — launch: opens index.html in the default browser (§1)
scripts/sync-webchat.ps1 — copies / checks the files shared with webchat (§12)
README.md
```

---

## 4. Document model

A document is **HTML** (what the editor holds); images are kept separately.

- **Formatting** — `<b>`, `<i>`, `<u>`; font size — `<span style="font-size:…pt">`.
- **Alignment/indentation** — `text-align` and paragraph indents (`execCommand`).
- **Tables** — `<table class="doc-table">`; cell fill — `background-color`.
- **Images** — `<img data-media-id="img-…" src="media://img-…">`. Image bytes are **not** in
  the HTML: in the editor they live in an `id → Blob` store and are shown through `blob:` URLs;
  in the file they are separate `media/<id>` entries. Only images referenced by the text are saved.

Loading HTML into the editor (`Editor.load`) and the copy made for saving (`Editor.serialize`) are
built in an inert document (`DOMParser` / `createHTMLDocument`): otherwise the browser would
request `media://…`, and the content would reach the page before `script`/`on*` attributes were
stripped.

---

## 4a. The document's fonts

Documents use two bundled variable fonts: **Roboto Flex** is the default sans-serif face and
**Roboto Serif** is selectable for any text. Both travel with the project in `css/fonts/`:
`RobotoFlex.ttf` (1.77 MB) with `OFL.txt`, and `RobotoSerif.ttf` (3.94 MB) with
`RobotoSerif-OFL.txt`. Both are under the SIL Open Font License 1.1. Nothing is fetched at runtime:
the `@font-face` rules point at the project's own files, the `Content-Security-Policy` allows
`font-src 'self' file:`, and system fonts remain only as fallbacks.

Before this, the document used whatever sans the reader's machine had. The same `.sdoc` then broke
its lines differently on every system — and the font could not be asked for anything, since
Segoe UI has neither a condensed face nor variation axes.

Roboto Flex is a variable font, so one file covers every weight the editor asks for — the editor's
bold is `font-weight: 700`, which drives the `wght` axis — and its vertical axes are set to draw
the letters taller than the font's own default:

```css
font-variation-settings: "YTLC" 570, "YTAS" 854, "YTUC" 760, "YTFI" 788;
```

x-height 514 → 570, ascenders 750 → 854, capitals 712 → 760, figures 738 → 788; the widths, the
line pitch and the measure are untouched. These are the maxima of those axes — the font draws no
taller. The values were chosen in the font tuner (§13), which reads them from the font's own `fvar`
table.

Roboto Serif is variable too: one file covers its weights and widths. It does not have Flex's
private vertical axes, so serif runs use `font-size-adjust: 0.57` to match Flex's x-height and the
font's own `wdth` axis at 55 to keep a similarly compact texture. These settings use Serif's
designed outlines rather than geometrically stretching its strokes.

**Why not a transform.** `transform: scaleY()` would stretch any font, the system one included, and
it was tried first. It is a painting step, not a layout one, so it loses the moment the flow has to
be split: a multi-page PDF came out with the lines of every page break overlapping, because a
transformed block is painted in one piece and cannot be fragmented. Height that comes from the
font itself survives printing, and a nine-page export was checked for it.

**Fallback glyphs.** Roboto Flex does not contain the divider ornaments (⁂ ❖ ✦ ✧ ❦ ❧ ☙ ✤ ✥
❈ ❉ ✻) or the four diagonal arrows. Those characters therefore come from the reader's fallback
symbol font. A divider is the one part of a document that can still look different from machine to
machine.

---

## 5. File format (a single `.sdoc` file)

One file = a **ZIP container**, optionally encrypted as a whole inside an envelope.

Inside, before encryption:
```
manifest.json   — {"title","schemaVersion":1,"createdAt","modifiedAt","caret"?}
content.html    — the document's HTML (§4)                      (DEFLATE)
media/<id>      — images, once per id                            (STORED: already compressed)
```
`caret` is the caret position at the last save (optional).

Physical layout:
```
+----------------------------------------------------------------------------+
| "SDOC" (4 bytes) | format version = 1 (1 byte) | header length (int32 BE)   |
+----------------------------------------------------------------------------+
| header — JSON, NOT encrypted: protected KDF fields shown below, or          |
|   {"encryption":"none"}                                                   |
|   {"kdf":{"algo":"argon2id","salt":<b64>,"memoryKiB","iterations",          |
|           "parallelism"},"wrappedDek":<b64>}                                |
+----------------------------------------------------------------------------+
| body = protected: nonce(12) || AES-256-GCM(DEK, zip) || tag(16)             |
|      | unprotected: zip                                                     |
+----------------------------------------------------------------------------+
```
`wrappedDek` = nonce(12) ‖ AES-256-GCM(KEK, DEK) ‖ tag(16).

The header is in the clear on purpose. For a protected document it exposes the KDF parameters, but
**the document itself cannot be read without the passphrase**. Without a passphrase, the header
explicitly declares `encryption: "none"` and the ZIP body is stored directly. The JSON key order of
protected files is fixed, so any writer of this format produces the same header bytes.

---

## 6. Encryption and the 12-word passphrase

### 6.1 Optional passphrase = 12 words (BIP-39)
- 12 random words out of 2048 (2^11) = **132 bits of entropy** — strong, yet possible to write down.
- **Generation:** the **Generate** button (`crypto.getRandomValues`, no modulo bias: 2048 divides
  2^32) plus a warning to write the phrase down.
- **No phrase:** an empty field creates or imports an unprotected document.
- **Your own phrase:** when creating, importing and changing protection — exactly 12 words
  from the wordlist (the BIP-39 checksum is not checked: this is a passphrase, not a wallet seed).
  There is no such check when opening — older files may have been created with other phrases.
  A self-chosen phrase passes the check but has far less entropy than a generated one.
- The phrase is normalised: trimmed, lower-cased, single spaces; before the KDF — Unicode NFKD, UTF-8.

### 6.2 Envelope encryption
This flow applies only when a passphrase is present. Without one, the ZIP container is stored as the
body and the header is exactly `{"encryption":"none"}`.

```
DEK        = random 256 bits (crypto.getRandomValues)  // encrypts the body
KEK        = Argon2id(passphrase, salt, params)        // from the 12 words, 32 bytes
wrappedDEK = AES-256-GCM(KEK, DEK, AAD_KEK)            // in the header
body       = AES-256-GCM(DEK, zip, AAD_BODY)
AAD_KEK    = "SDOC-KEK|v1|<salt b64>|<memoryKiB>|<iterations>|<parallelism>"
AAD_BODY   = "SDOC-BODY|v1"
```
- **Opening:** passphrase → KEK → decrypt `wrappedDEK` → DEK → decrypt the body.
  - `wrappedDEK` fails to decrypt → "wrong passphrase" (or a tampered header — indistinguishable);
  - DEK recovered but the body fails to decrypt → "damaged file".
- The KDF parameters are bound to `wrappedDEK` through the AAD — changing the salt/parameters is
  detected. The body is bound only to the format version.
- **Argon2id** for new files: 64 MiB memory, 3 iterations, parallelism 1, 16-byte salt.
  The parameters are stored in the file, so they can be raised later without breaking compatibility.
- **The header is untrusted input:** before Argon2 runs, memory ≤ 256 MiB, iterations ≤ 16,
  parallelism ≤ 16, salt 8–64 bytes and header length ≤ 1 MB are checked.

### 6.3 Changing protection and saving
Every protected save seals the document afresh: **a new DEK, a new salt, new nonces**.
Argon2 runs in a Web Worker (`kdf-worker.js`); where a worker can't start (`index.html` opened
from disk in Chrome) it runs in the page and freezes it for a second or two. So that an ordinary Save
does not wait for Argon2, the KEK for the *next* save — with its own fresh salt — is derived in the
worker ahead of time after opening, creating or importing a document and after each save. It is held
as a non-extractable WebCrypto key, used by exactly one save and discarded on close. A passphrase
change starts derivation for the new phrase and immediately consumes that key in its required save.
Without a worker nothing is derived ahead; the save derives its key itself.

**While the work runs, a modal says so** (`#busy-dialog`): "Encrypting the document…", then
"Writing the file…" for a save, "Decrypting the document…" when a protected file is opened, and
"Importing the document…" for a DOCX. Each is closed in a `finally`, whichever way the operation
ends, and a save closes it again before the file picker so nothing of ours sits over it. Escape
does not dismiss it. It matters most exactly where there is no worker: a frozen main thread cannot
paint, so `showBusy()` waits two animation frames and a timeout — long enough for the browser to
put the dialog on screen — before the work starts. Without that the page would simply stop
answering for a second or two. On the start screen the modal joins the line under the passphrase
field, which also disables the buttons while a file is being read.

Changing protection verifies the current phrase (empty for an unprotected document), replaces it in
memory, then immediately performs a normal full save. Protected saves rotate the DEK. If preparation
or writing fails, the in-memory phrase is restored and the file keeps its current protection. There is
no separate "fast" mode that rewrites only
the header — it isn't needed while the whole document is in the browser's memory.

Old copies of the file still open with the old passphrase — that is true of any scheme.

### 6.4 Writing to disk
- Browsers with the File System Access API (`showSaveFilePicker`): the location is asked for once,
  after which Save overwrites the same file. The write goes to a temporary copy that replaces the
  file only on `close()`; after writing, the size on disk is verified.
- Other browsers: saving = downloading the `.sdoc`.
- Encryption or plain-container preparation runs **before** a file is chosen or written: a failure
  cannot leave an empty or truncated file.

### 6.5 What is encrypted
All content — text, formatting, tables, images and metadata (title, dates in `manifest.json`) — is
inside `body`. In protected files, only non-secret fields are in the clear: the signature and
version, the KDF parameters and salt, and `wrappedDEK` (the DEK itself is ciphertext there). The DEK
exists in plaintext only in memory while encryption/decryption is running. In unprotected files the
entire ZIP body is deliberately readable without a passphrase.

### 6.6 Hygiene and checks without automated tests
- JS strings are immutable, so the phrase cannot be wiped from memory; `Uint8Array`s are zeroed
  (passphrase bytes, KEK, DEK, the plaintext container), and WebCrypto keys are non-extractable.
- Third-party code that runs next to the passphrase is **vendored in the repo** (no CDN), versions
  are pinned and hashes are in `js/vendor/SHA256SUMS`. The files were taken from npm tarballs with
  their integrity verified:
  - hash-wasm 4.12.0 `dist/argon2.umd.min.js` (integrity `sha512-+/2B2rYLb48I/evdOIhP+K/DD2ca2fgBjp6O+GBEnCDk2e4rpeXIK8GvIyRPjTezgmWn9gmKwkQjjx6BtqDHVQ==`).

  Check: `cd js/vendor && sha256sum -c SHA256SUMS`.
- **Document content is untrusted** (a `.sdoc` may come from someone else). Opening, pasting and
  saving all go through `js/doc-html.js` (`DocHtml.load` / `paste` / `store`, shared with webchat,
  §12): the HTML is parsed in an inert `DOMParser` document and **rebuilt from an allow-list** —
  elements (text formatting, lists, tables, `img`, `a`, `hr`, MathML; `script`, `iframe`, `svg`,
  `form`, `meta`, `base`, `style`, media … are dropped with their contents, unknown tags are
  unwrapped), per-tag attributes (`a[href]` only http/https/mailto/tel; `img` only with an
  `img-…` media id and the blob: URL of its own media; `colspan`/`rowspan`, `data-radius`, MathML
  keywords), the classes `doc-table` and `doc-divider`, and inline style declarations whose
  property is on the list and whose value has the expected shape (alignment, weight, style,
  decoration, size, family, colours, line height, indent margins/padding, image width/height).
  Nothing with `url()`, `var()`, custom properties, backslash escapes or comments survives; `id`,
  `name`, `on*`, `position` and any other class are never copied, so a document can neither shadow
  the app's elements nor overlay its UI. Paste keeps less: no colours, fonts or margins from the
  source page, sizes only in pt, background only on table cells; a pasted image is kept only as
  bytes (clipboard bitmap, `data:` or a readable `blob:`), never as a link to a host. A
  `Content-Security-Policy` `<meta>` in `index.html` backs it up: only the app's own scripts, images
  only from itself, `blob:` and `data:`, `connect-src 'self' blob:`, no frames, forms or `<base>`.
  Opening a document therefore never tells anyone that it was opened.
- The wordlist `js/wordlist.js` is the official BIP-39 English list: 2048 words, SHA-256 of the list
  (words joined by LF, with a trailing LF) = `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`.
- **The font** (§4a) — open any document and check that the text is drawn in Roboto Flex, not the
  system sans: `document.fonts.check('16px "Roboto Flex"')` is true and
  `getComputedStyle($('editor')).fontVariationSettings` names the four axes.
- **Format compatibility** — by hand, via **Open**: the files in `testdata/` must open with the
  phrase `abandon ability able about above absent absorb abstract absurd abuse access accident`.
  - `java-v1.sdoc` — the oldest sample, written by a different implementation of this format than
    the one here (a title, text, emoji and a 48×24 image): checks that documents written
    elsewhere, and before today's code, still open;
  - `browser-v1.sdoc` — written by the browser (a title, text and a 48×24 image).
  - `weak-kdf-v1.sdoc` — same phrase, but Argon2id with 8 MiB, 1 pass and an 8-byte salt: it must
    open with the status "weak legacy encryption settings; save to upgrade them", and after a save
    the file's header must show today's profile (64 MiB, 3 passes, 16-byte salt).
  - `rich-v1.sdoc` — every format the editors write: a link, red Georgia text, an indent
    (`blockquote` with `margin-left: 40px`), a MathML fraction, 20 pt text, a table with a filled
    cell and `data-radius="10"`, a `doc-divider`, and an image resized to 40 px. It must open
    looking like that in both SecureDoc and webchat; webchat's `DocumentHtmlContractE2ETest` checks
    its side and saves the file back to `webchat/build/sdoc-roundtrip/`, and that file must open
    here with `Editor.serialize()` equal to the original content.

---

## 7. Editing features

| Requirement | Implementation |
|------------|-----------|
| Bold / italic / underline | `execCommand` + toolbar, Ctrl+B/I/U |
| Font size | a list of sizes in pt, Ctrl+] / Ctrl+[ |
| Clear formatting | T✕ button, Ctrl+Space |
| Indentation, alignment | `indent`/`outdent`, `justifyLeft/Center/Right` |
| Tables | insert with a size picker, ±row/column, cell fill (palette, recent, exact colour) |
| Images | insert from a file or the clipboard, resize by dragging a corner |
| Section dividers | ⁂▾ button with a drop-down: twelve ornaments (⁂ ❖ ✦ ✧ ❦ ❧ ☙ ✤ ✥ ❈ ❉ ✻), eight directional arrows (← ↑ → ↓ ↖ ↗ ↘ ↙), and four composed ones (❦ ❦ ❦ / ✦ ✦ ✦ / ⸙ — ⸙ / — ❖ —). The document font does not carry these glyphs (§4a), so they are drawn by the reader's own fallback font — on Windows that is Segoe UI Symbol; nothing is loaded from the network either way. Plain text — `<p class="doc-divider" style="text-align: center">` holding the chosen symbol (the shared contract; webchat's former `document-ornament` is converted on load) — on a line of its own; typing carries on in the line below |
| Export to PDF | page printing (`window.print`) |
| Background around the page | colour black / dark blue / dark grey / grey / sepia / white plus a faint pattern (none / dots / grid / lines / diagonal / waves / Penrose tiling — the aperiodic one drawn once onto a canvas / Octagons — regular octagons and squares / Voronoi — irregular polygons from fixed, periodically repeated seeds, in a seamless SVG tile / Truchet — square tiles of 2 × 2 cells, each half inked (top, right, bottom or left), joining into a labyrinth of both tones one cell wide, with squares nested in rings where four tiles face one corner. Taken from a sample image: every row of its tiles follows from the one above by the two diagonal neighbours alone, and linearly over two bits — so each tile carries two independent coins, one shared along its rising diagonal (upper right or lower left) and one along its falling diagonal (upper left or lower right), and inks the side both point to. Fixed-seed coins, diagonals counted modulo 48 tiles, so the 960 px SVG tile repeats seamlessly) and a group of optical illusions, each a seamless SVG tile: Cubes — a rhombille tiling in three tones (flat rhombi bare, the sides at 0.7 and 1.4 of the ink) that keeps turning over by itself, seen from above one moment and from below the next / Zöllner — exactly parallel diagonals that seem to lean towards and away from each other, crossed in turn by horizontal and vertical strokes; denser ink (×2.2) and a heavier stroke than the plain line patterns, since antialiasing smears a thin diagonal far more than the crisp crossings and without long lines there is no tilt to see / Café wall — rows of square tiles, every other row shifted by half a tile, whose straight mortar lines look like wedges. The illusion lives on the contrast of the tiles and on the mortar lying halfway between them, and a faint ink tints the tiles but kills the tilt, so this one pattern is drawn in opaque tones of its own: tiles 56 levels of 255 apart, one lighter and one darker than the background by the same step where there is room both ways (pushed off the end of the scale on white), and the mortar halfway — so on the mid colours it is the background itself, which keeps its brightness on average; the mortar is a tenth of the tile, as thicker mortar weakens the tilt / Kanizsa — squares nobody drew, between four discs with a quarter cut away. The square is only seen when the eye takes the four discs as one group: packed into an even lattice of notched discs they group as the eye likes and no square wins, so the squares stand far apart (128 px, over twice their side) in rows offset by half; the discs give away 0.625 of each edge (2 × radius / side) — more makes the contour stronger but closes the four into one ring-like glyph — in dense ink (×2.5), the contour living on their contrast; anchored at the centre, so the swatch shows a whole square; a view preference in `localStorage`, not in the file |
| Animated background | its own group in the picker, two entries. **Cubes**: the rhombille of the still Cubes cross-fading with a copy lit from the other side — the flat rhombi go from the lightest tone to the darkest while the sides shift down a step, and since the eye takes light as coming from above, a dark flat face is a bottom: the cubes turn inside out and back. The same two stacked layers and 16 s cycle as below. **Penrose**: the Penrose tiling with its two greys trading places — the light rhombi darken while the dark ones lighten. The same drawing as the static one, asked for twice with the tones of the two kinds of rhombus exchanged, cross-fading on two stacked layers behind the page (`.bg-anim`, `z-index: -1`, hence `isolation` on `<body>`; 16 s a cycle). Both mirrored `ease-in-out` curves sum to 1, so the weight of ink stays even through the swap. The fills are the deep tone at 81% of the ink and the pale one at 11%. The dividing lines are dark on every background: black, laid over the fills as a veil that takes 36 levels of 255 off the background's own brightness (all of it on black), drawn into a channel of their own (green; the fills keep red) and composited in the pixel pass. Every earlier way let them sink at some phase. In the background's own ink they are light on the dark colours, lighter than both fills, and next to the deep fill they all but vanished. A line that turns over with its fill (the inverse of the tone beneath it, stroked in white through `difference`: pale on the deep fill, deep on the pale one) has to pass through the fill's tone somewhere in the cross-fade and vanishes for that moment; pressing that inverse three quarters into the ink kept it clear of both fills, but only a quarter of the ink from the deep one — too faint beside it. Below the background, a line is darker than both fills on a dark colour, whose fills are lighter, and on a light one darker than the rhombus under it by a fixed share of it: 31–35 levels of 255 on the light colours, 35–68 on the dark ones, at every phase of the swap, the crossing included, where the fills meet in the middle and the tiling is carried by its lines alone. What the eye can actually follow set the numbers: the first attempt tinted one half of the rhombi at 30% of the ink and left the rest bare over a 20 s cycle — ~10 levels of 255 between the ends, about one level a second, indistinguishable from a still background. Giving both kinds a tone of their own measures ~24 levels of 255 between the ends on black and white, ~16 on the mid greys — some three levels a second over the 16 s cycle, which reads as movement where one level a second did not. `prefers-reduced-motion` holds both still and the picker says so (`.motion-note`), or a frozen animated background just looks broken |
| Paste and drop | HTML is cleaned (`DocHtml.paste`); something dragged in from outside the editor is treated exactly like a paste (a drag within the editor just moves text); images are taken into the store only when the clipboard carries their bytes (a bitmap, `data:`, a readable `blob:`) — links to images on a host are dropped; rendered KaTeX formulas are reduced from duplicated MathML + styled HTML to native MathML; a clipboard containing one complete `\\[...\\]`, `$$...$$`, or `\\(...\\)` formula becomes readable plain text with common operators, symbols, and numeric scripts converted to Unicode |

Continuous scrolling, no paged view.

### 7.1 How a toolbar button is wired

The recipe to follow when adding one:

- **Markup** — `index.html`, inside `.toolbar`, in its group between `<span class="sep">`s. A plain
  `execCommand` button needs only `data-cmd="…"`: the loop at the top of the toolbar section in
  `js/app.js` wires every `[data-cmd]` to `Editor.exec` + `markDirty()`. Anything else gets an `id`.
- **Never let the button take focus.** Every control that edits at the caret is wired on `mousedown` with
  `e.preventDefault()` (or has a `mousedown` handler doing just that, next to its `click`), so the
  caret and selection stay in the editor and the insert lands where the user was. `Editor` also
  keeps `lastRange` and `focusEditor()` restores it — needed for the `<select>` and the fill picker,
  whose inputs do take focus.
- **Drop-downs** (table size `#table-picker`, divider `#div-picker`, background `#bg-picker`, cell
  fill `#fill-picker`) are `<div hidden>` popovers at the end of `<body>`, not inside the toolbar:
  `position: fixed; z-index: 20`, white card with the shared border / radius / shadow in
  `css/style.css`. In `js/app.js` each lives in its own `(function setupXxx() { … })()` block: the
  button toggles `picker.hidden` and places the picker under itself from `getBoundingClientRect()`
  (clamped to the window); the picker itself also cancels `mousedown`; a `mousedown` outside picker
  and button closes it, and so does Escape. Every popover must also be listed in the `@media print`
  rule that hides the toolbar.
- **Editing work** belongs in `js/editor-core.js` (shared with webchat, §12), exported on the `Editor` object; `app.js` only calls
  it and then `markDirty()`. Prefer `execCommand` steps (`insertText`, `insertParagraph`,
  `justify*`) so the change stays undoable. `insertHTML` is fine for tables and images, but Chrome
  merges an inserted `<p>` into the paragraph at the caret (as a `<span>`) — that is why the
  dividers are built from `insertParagraph` + `insertText` + `justifyCenter`.
- **What ends up in the document** must be on the allow-lists of `js/doc-html.js` (`KEEP_TAGS`,
  the per-tag attributes in `copyNode`, `STYLE_RULES`; paste uses a narrower profile) — otherwise
  opening, saving or copying it within the app loses it, in webchat too. Classes other than
  `doc-table` and `doc-divider` are not kept. MathML has its own restricted tag and attribute
  allow-lists; source annotations and KaTeX's CSS-dependent duplicate are discarded. A change there
  is a change to the shared contract (§12).
- **Title** (tooltip) on every button, in English; icon-only buttons are `.icon-btn` with an inline
  SVG and an `aria-label`.

**Start screen** (the "1a — light, document-like" design handoff). One card with a tablist
(Open / Create / Import; arrow keys, Home / End) on the background chosen in the editor (colour and
pattern, the same `localStorage` preference). Every passphrase field counts its words live (`n/12` and
twelve bars, in the accent colour at exactly 12); the count is feedback only, the phrase is checked
when it is used. Open and Import act as soon as a file is chosen in the picker or dropped on the
file zone; a file dropped anywhere else on the screen is swallowed, so the browser never navigates
away to it. A file whose attempt failed stays held and named in the zone, so the quiet Open /
Import button retries it once the passphrase is fixed (with nothing held, that button opens the
picker). Progress and errors appear under the passphrase field. Only system fonts — a sans for the
UI, a monospace for the passphrase and technical labels — so the page loads nothing from the network.

The file pickers keep the real `<input type="file">` (visually hidden, still focusable) and draw the
file zone as its `<label>`: the native button's text follows the browser's language and cannot be
restyled.

---

## 8. DOCX import

The import runs in the browser (`js/import.js`); the file is not sent anywhere.
The HTML it produces was checked character for character on test DOCX files (formatting, a
hyperlink, an empty paragraph, images in text and in a cell, patterned shading, Cyrillic).

**DOCX:** paragraphs with alignment, bold/italic/underline, tables with cell fill (a `w:shd`
pattern is flattened to one colour; fill coming from table styles is ignored), embedded images →
`media://img-NNNN`. Content controls (`w:sdt`) and custom XML are unwrapped, accepted insertions
(`w:ins`) are kept, deleted text (`w:del`) is skipped, `w:br` → `<br>`, an image inserted twice is
stored once, and text in nested tables is not lost. Each ZIP entry is ≤ 1 GiB, and its size and
CRC-32 are verified while decompressing (zip-bomb protection).

PDF import is not supported.

---

## 9. Large documents

- Images are kept apart from the text (§4), so the HTML stays light.
- In the container the text is DEFLATE-compressed (several-fold); images are stored as they are.
- The whole document is in the page's memory; the peak while saving is roughly three times the
  document size (container, ciphertext, Blob). That is acceptable for documents with tens of MB of
  images; beyond that, a chunked format.
- Argon2 (64 MiB) takes ~0.3–2 s. It runs in the worker (§6.3), and the key for the next save is
  derived ahead of time, so an ordinary save does not wait for it; where no worker can start it
  runs on the main thread and the page freezes for that time. Either way the page gets to show
  "Encrypting…" / "Decrypting the document…" first.

---

## 10. Distribution

- The project folder (`index.html`, `css/` with its `fonts/`, `js/`, `icons/`) is the application.
  Run it with `run.bat`, from a static host with HTTPS, or by opening `index.html` from disk with
  the two things that costs (§1). A host needs only those four; `tools/`, `testdata/`, `scripts/`
  and the Markdown are not part of what is served.
- The two fonts make up most of the first download (about 5.7 MB together), where the app itself is
  some 300 KB. They are cached afterwards. Shrinking them means subsetting to the scripts actually
  used and converting to woff2, which needs tooling this project deliberately does not carry; the
  full files keep every axis available for later.
- When hosted, security depends on the host serving honest files: a tampered JS file could steal
  the phrase. A local copy is the most trustworthy option.

---

## 11. Decisions and risks

### Decisions
- **No server-side logic.** A remotely hosted server would see the passphrase and the text;
  everything moved into the browser. The project ships no server at all — not even a local one:
  `run.bat` only opens the page.
- **No Node and no build.** Third-party libraries are ready-made files in `js/vendor/`.
- **No test runner.** Nothing in the project compiles or executes tests; what has to hold is
  checked by hand against the samples in `testdata/` (§6.6).
- **Layout: continuous scrolling.**
- **12 words: generated or your own** (§6.1).
- **The document's fonts travel with the app** (§4a), rather than being whatever the reader has
  installed: they cost about 5.7 MB and give consistent drawing, line breaking and page counts —
  plus the variable axes used to tune each face.

### Risks
- **R1. No automated tests.** Format regressions are caught only by checking `testdata/` by hand.
- **R2. Tampered third-party code.** Libraries are in the repo, hashes are in `SHA256SUMS`; when
  upgrading, take the npm tarball, verify its integrity and update `SHA256SUMS`.
- **R3. Large documents in memory** (§9).
- **R4. Two editors drifting apart.** Kept in check by the shared files and their check (§12).

---

## 12. Code shared with webchat

The Documents section of webchat (`C:\work\webchat`, a Spring Boot app; its editor is
`src/main/resources/static/js/documents.js`) opens and writes the same `.sdoc` files. Everything
that decides what a document *is* lives here in `js/` and is copied to webchat **byte for byte**;
only the UI around it differs.

| File | What it is |
|---|---|
| `js/byte-utils.js` | `ByteUtils.concat` / `toBase64` (webchat's `keypair.js` uses them too) |
| `js/zip.js` | the ZIP container |
| `js/sdoc.js` | the `.sdoc` format and encryption, incl. the weak-KDF upgrade flag |
| `js/kdf-worker.js` | Argon2id in a worker |
| `js/doc-html.js` | the HTML contract: allow-list rebuild for load / paste / save, links, tables (`data-radius`), dividers (`doc-divider`), media ids, paste decisions, adopting pasted image bytes |
| `js/editor-core.js` | the editor itself (`Editor`): every editing command — bold/italic/alignment via `exec`, font size in pt, clear formatting, links, tables (insert, rows/columns, fill, rounded corners), dividers, images (insert, resize handle), Tab, leaving a quote, paste and drop — the media store, `load` / `serialize` and the caret position. `Editor.init(element, { acceptImage })`; every edit fires `input` |

Each app keeps only its UI around the core: toolbar markup and wiring, dialogs, saving and opening
(SecureDoc `app.js`; webchat `documents.js`, which also talks to its server). The rules for
`.doc-divider`, `table.doc-table[data-radius]`, `img.img-selected` and `.img-resize-handle` are the
same in `css/style.css` and webchat's `css/documents.css`.

**Procedure for a change to a shared file:**
1. Edit it **here** only (never the copy in webchat). The file must also suit webchat's rules:
   braces after every `if` in new code.
2. Check SecureDoc by hand (§6.6), including `testdata/rich-v1.sdoc`.
3. `powershell -File scripts\sync-webchat.ps1 -Copy` — copies the files into
   `webchat/src/main/resources/static/js/` (`-Webchat <path>` if it is not next to this folder).
4. In webchat bump the `?v=` of each changed file where it is loaded (`chat.js` loads
   `doc-html.js`, `editor-core.js` and then `documents.js`; `documents.js` loads
   `doc-html.js`/`sdoc.js`/`zip.js`/`byte-utils.js`; `chat.html` loads `chat.js`) and `VERSION`
   in `VersionController`.
5. In webchat run `gradle test --tests "com.example.webchat.e2e.Document*"` and
   `--tests "com.example.webchat.e2e.SdocCompatibilityUiTest"`; commit both repositories.

`scripts\sync-webchat.ps1` without `-Copy` only checks (exit 1 and the names of the files that
differ, line endings ignored); in webchat `gradle checkSecureDocCopies` does the same and runs before
every `gradle test`, so a copy edited there by mistake fails the build.

---

## 13. Development helpers (`tools/`)

Not part of the application: `index.html` never loads anything from here, and a host does not need
the folder. A helper is opened from disk like the app itself.

**`tools/font-tuner.html`** (with `font-tuner.css` and `font-tuner.js`) — a typography bench for
the document. The knobs are on the left, a sample document on the right that answers to them
through copies of the editor's own rules, and at the bottom the matching CSS for `css/style.css`:
by default only the values that differ from what the project carries, so the block can be pasted in
without dragging noise along.

It covers size, line height, tracking, word spacing, weight, paragraph gap, alignment, hyphenation,
colours, the heading scale, the page's width and padding, and the print size. For the shape of the
letters themselves it offers `font-stretch`, a geometric `scaleX` / `scaleY` (which works on any
font and is what the project decided against, §4a), and — the useful part — **one slider per
variation axis the loaded font actually declares**, built from its `fvar` table with that axis's
real range. Chrome exposes axes only for a font it loaded itself, never for an installed family, so
the page loads a font file: Roboto Flex from `tools/fonts/`, a copy git ignores (the one the app
ships is `css/fonts/RobotoFlex.ttf`), or any `.ttf`/`.otf` picked by hand. The axis values in §4a
were chosen here.
