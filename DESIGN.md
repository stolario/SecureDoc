# Design: an encrypted rich-text editor

> Code name: **SecureDoc**. A static web page: HTML + CSS + JavaScript, with no server-side
> logic, no build step and no runtime. The user interface is in English.

---

## 1. Summary

Requirements: a single encrypted file, opened only with a 12-word passphrase, privacy,
DOCX import, documents of up to hundreds of pages.

**Architecture — everything in the browser.** The `index.html` page itself edits, encrypts,
decrypts and imports documents. Neither the passphrase, nor the text, nor imported files are sent
anywhere: the page makes no network requests at all.

```
┌─────────────────────────────── browser ────────────────────────────────┐
│  index.html                                                             │
│  ├─ editor.js   contenteditable editor (text, tables, images)           │
│  ├─ app.js      open / create / import / save / change passphrase       │
│  ├─ sdoc.js     .sdoc format: Argon2id + AES-256-GCM (WebCrypto)         │
│  ├─ zip.js      ZIP container on CompressionStream                      │
│  ├─ import.js   DOCX (own OOXML parsing)                                │
│  └─ vendor/     hash-wasm (Argon2) — in the repo, not from a CDN        │
└──────────────┬──────────────────────────────────────▲──────────────────┘
               │ <input type=file>                     │ showSaveFilePicker /
               ▼                                       │ download
        ┌──────────────┐                        ┌──────┴───────┐
        │ document.sdoc │ ←── one encrypted file ──→ │ document.sdoc │
        └──────────────┘                        └──────────────┘
```

**How to run:**
- **`run.bat`** (double-click) — the local static server `scripts/serve.ps1` on
  `http://localhost:8637`, and opens the browser.
  Needs only the PowerShell built into Windows; Ctrl+C or closing the window stops it.
- **`index.html` from disk** — everything works too.
- **Any static host** (HTTPS) — same as `run.bat`.

`serve.ps1` does no processing — it only serves the app's files: `index.html`, `css/`, `js/`
(not `.git`, `.claude`, `testdata/`, `scripts/`), GET/HEAD only, only requests from this computer
(`Host: localhost` + `IsLocal`), and escaping the folder (`..`) is blocked. The file is saved as UTF-8 with a BOM (without it Windows PowerShell 5.1 reads its
non-ASCII characters as ANSI).

All paths in `index.html` are **relative** (`js/app.js`); otherwise nothing loads from disk.

### History
The project started as a Spring Boot server on 127.0.0.1 with encryption and import in Java
(Bouncy Castle, Apache POI, PDFBox). That was abandoned because, if hosted remotely, the server
would receive the passphrase and the plaintext. Encryption and then import were moved into the
browser (the file format and the import HTML match the Java output byte for byte), after which
Java and Gradle were removed. The UI was later translated from Russian to English.

---

## 2. Technology stack

| Layer | Choice | Why |
|------|-------|-------|
| Application | static HTML/CSS/JS, no frameworks, no build | opens from disk, nothing to install |
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
css/style.css
js/
├─ wordlist.js      — BIP-39 English (2048 words)
├─ passphrase.js    — generating / normalising / validating the 12 words
├─ zip.js           — ZIP: reading (via the central directory) and writing
├─ sdoc.js          — .sdoc format and encryption (Sdoc.encode / Sdoc.decode / Sdoc.prepare)
├─ kdf-worker.js    — Argon2id in a Web Worker, so the page doesn't freeze while a key is derived
├─ import.js        — DOCX → HTML + images (Importer.importFile)
├─ editor.js        — editor, image store, serialize / load
├─ app.js           — workflows: open, create, import, save, PDF printing, passphrase change
└─ vendor/
   ├─ hash-wasm-argon2-4.12.0.umd.min.js
   └─ SHA256SUMS     — hashes of every file in vendor/
testdata/           — .sdoc samples for manual compatibility checks (§6.6)
run.bat             — launch: local server + browser (§1)
scripts/serve.ps1   — the local static server itself (PowerShell, nothing to install)
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

## 5. File format (a single `.sdoc` file)

One file = a **ZIP container**, encrypted as a whole inside an envelope.

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
| header — JSON, NOT encrypted:                                               |
|   {"kdf":{"algo":"argon2id","salt":<b64>,"memoryKiB","iterations",          |
|           "parallelism"},"wrappedDek":<b64>}                                |
+----------------------------------------------------------------------------+
| body = nonce(12) || AES-256-GCM(DEK, zip) || tag(16)                        |
+----------------------------------------------------------------------------+
```
`wrappedDek` = nonce(12) ‖ AES-256-GCM(KEK, DEK) ‖ tag(16).

The header is in the clear on purpose: it exposes the KDF parameters — but **the document itself
cannot be read without the passphrase**. The JSON key order is fixed (it matches the former Java
writer).

---

## 6. Encryption and the 12-word passphrase

### 6.1 Passphrase = 12 words (BIP-39)
- 12 random words out of 2048 (2^11) = **132 bits of entropy** — strong, yet possible to write down.
- **Generation:** the **Generate** button (`crypto.getRandomValues`, no modulo bias: 2048 divides
  2^32) plus a warning to write the phrase down.
- **Your own phrase:** when creating, importing and changing the passphrase — exactly 12 words
  from the wordlist (the BIP-39 checksum is not checked: this is a passphrase, not a wallet seed).
  There is no such check when opening — older files may have been created with other phrases.
  A self-chosen phrase passes the check but has far less entropy than a generated one.
- The phrase is normalised: trimmed, lower-cased, single spaces; before the KDF — Unicode NFKD, UTF-8.

### 6.2 Envelope encryption
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

### 6.3 Changing the passphrase and saving
Every save seals the document afresh: **a new DEK, a new salt, new nonces**.
Argon2 runs in a Web Worker (`kdf-worker.js`); where a worker can't start (`index.html` opened
from disk in Chrome) it runs in the page and freezes it for a second or two. So that Save does not
wait for Argon2, the KEK for the *next* save — with its own fresh salt — is derived in the worker
ahead of time: after opening, creating or importing a document, after each save and after a
passphrase change. It is held as a non-extractable WebCrypto key, used by exactly one save and
discarded on close. Without a worker nothing is derived ahead; the save derives its key itself.
Changing the passphrase replaces the phrase held in the page's memory (after checking the current
one) and marks the document unsaved; it reaches the file on the next save, together with the DEK
rotation. There is no separate "fast" mode that rewrites only the header — it isn't needed while
the whole document is in the browser's memory.

Old copies of the file still open with the old passphrase — that is true of any scheme.

### 6.4 Writing to disk
- Browsers with the File System Access API (`showSaveFilePicker`): the location is asked for once,
  after which Save overwrites the same file. The write goes to a temporary copy that replaces the
  file only on `close()`; after writing, the size on disk is verified.
- Other browsers: saving = downloading the `.sdoc`.
- Encryption runs **before** a file is chosen or written: an encryption failure cannot leave an
  empty or truncated file.

### 6.5 What is encrypted
All content — text, formatting, tables, images and metadata (title, dates in `manifest.json`) — is
inside `body`. Only non-secret fields are in the clear: the signature and version, the KDF
parameters and salt, and `wrappedDEK` (the DEK itself is ciphertext there). The DEK exists in
plaintext only in memory while encryption/decryption is running.

### 6.6 Hygiene and checks without automated tests
- JS strings are immutable, so the phrase cannot be wiped from memory; `Uint8Array`s are zeroed
  (passphrase bytes, KEK, DEK, the plaintext container), and WebCrypto keys are non-extractable.
- Third-party code that runs next to the passphrase is **vendored in the repo** (no CDN), versions
  are pinned and hashes are in `js/vendor/SHA256SUMS`. The files were taken from npm tarballs with
  their integrity verified:
  - hash-wasm 4.12.0 `dist/argon2.umd.min.js` (integrity `sha512-+/2B2rYLb48I/evdOIhP+K/DD2ca2fgBjp6O+GBEnCDk2e4rpeXIK8GvIyRPjTezgmWn9gmKwkQjjx6BtqDHVQ==`).

  Check: `cd js/vendor && sha256sum -c SHA256SUMS`.
- The wordlist `js/wordlist.js` is the official BIP-39 English list: 2048 words, SHA-256 of the list
  (words joined by LF, with a trailing LF) = `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`.
- **Format compatibility** — by hand, via **Open**: both files in `testdata/` must open with the
  phrase `abandon ability able about above absent absorb abstract absurd abuse access accident`.
  - `java-v1.sdoc` — written by the former Java implementation (a Russian title and text, emoji,
    a 48×24 image): checks that older documents still open;
  - `browser-v1.sdoc` — written by the browser (a Russian title, a 48×24 image).

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
| Export to PDF | page printing (`window.print`) |
| Background around the page | colour black / dark blue / dark grey / grey / sepia / white plus a faint pattern (none / dots / grid / lines / diagonal / waves / Penrose tiling — the aperiodic one drawn once onto a canvas / Octagons — regular octagons and squares / Voronoi — irregular polygons from fixed, periodically repeated seeds, in a seamless SVG tile); a view preference in `localStorage`, not in the file |
| Animated background | its own group in the picker, one entry so far: the Penrose tiling with its two greys trading places. The same drawing as the static one plus the copy that inks the other half of the rhombi, cross-fading on two stacked layers behind the page (`.bg-anim`, `z-index: -1`, hence `isolation` on `<body>`; 8 s a cycle). Its fill is half again as deep as the static pattern's: at 30% of the ink the two ends of the swap measure ~10 levels of 255 apart, and over a slow cycle that is not a change the eye can follow — 8 s and ~15 levels is. Both mirrored `ease-in-out` curves sum to 1, so the weight of ink stays even through the swap; `prefers-reduced-motion` holds the tiling still |
| Paste | HTML is cleaned; foreign images are pulled into the store when the browser hands over the bytes |

Continuous scrolling, no paged view.

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
When moving off Java, the HTML matched character for character on test DOCX files (formatting,
a hyperlink, an empty paragraph, images in text and in a cell, patterned shading, Cyrillic).

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
- Argon2 (64 MiB) runs on the main thread in ~0.3–2 s; before it the page gets to show
  "Encrypting…" / "Decrypting the document…".

---

## 10. Distribution

- The project folder (`index.html`, `css/`, `js/`, `icons/`) is the application. Run it with
  `run.bat`, by opening `index.html` from disk, or from a static host with HTTPS. A host needs
  only `index.html`, `css/`, `js/`, `icons/`.
- When hosted, security depends on the host serving honest files: a tampered JS file could steal
  the phrase. A local copy is the most trustworthy option.

---

## 11. Decisions and risks

### Decisions
- **No server-side logic.** A remotely hosted server would see the passphrase and the text;
  everything moved into the browser. The local `serve.ps1` only serves static files.
- **No Node and no build.** Third-party libraries are ready-made files in `js/vendor/`.
- **No Java.** The former Java implementation was removed together with its automated tests;
  checks are manual (§6.6).
- **Layout: continuous scrolling.**
- **12 words: generated or your own** (§6.1).

### Risks
- **R1. No automated tests.** Format regressions are caught only by checking `testdata/` by hand.
- **R2. Tampered third-party code.** Libraries are in the repo, hashes are in `SHA256SUMS`; when
  upgrading, take the npm tarball, verify its integrity and update `SHA256SUMS`.
- **R3. Large documents in memory** (§9).
