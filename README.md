# SecureDoc

An editor for rich-text documents that runs entirely in the browser.
A document is a single `.sdoc` file with optional 12-word passphrase protection.

The passphrase, the text and imported files **never leave the page**: protection, opening and
import all happen in the browser, and the page makes no network requests. There is no server-side
logic, no build step and nothing to install.

## Features

- Formatting: bold, italic, underline, hyperlinks, font size, alignment, indentation.
- Tables: add/remove rows and columns, cell fill colour.
- Images: insert from a file or the clipboard, resize.
- Formulas copied from ChatGPT as rendered math or as readable plain text without LaTeX delimiters.
- Import from **DOCX** (formatting, tables, images).
- Export to PDF via printing.
- Passphrase change.

## Running

Open **`index.html`** in a browser. SecureDoc can also be placed on any static HTTPS host as-is;
there is no build step or backend.

A modern browser is required (Chrome/Edge 109+, Firefox 113+, Safari 16.4+). In Chrome and Edge,
Save asks for a location once and then overwrites the same file; in other browsers saving downloads
the `.sdoc`.

## Usage

1. **Create** — optionally click **Generate**, **write the 12 words down**, then click **Create**.
   Leave the field empty for a document without passphrase protection. A forgotten passphrase
   cannot be recovered.
2. **Save** — the floppy-disk button or Ctrl+S (Ctrl+Shift+S — Save as).
3. **Open** — enter the 12 words for a protected document, or leave the field empty; then pick an
   `.sdoc` file or drop it on the card.
4. **Import** — optionally set a passphrase, then pick or drop a `.docx`; save it as `.sdoc`.
5. **Links** — select text and press Ctrl+K to create or edit a link. Ctrl+click a link to review
   its real destination before opening it in a new tab.

Only a **generated** phrase is strong (132 bits of entropy). Words you choose yourself pass the
check but are far easier to guess.

## Security

- When a passphrase is set, the key is derived with **Argon2id** (64 MiB memory, 3 passes) and a random
  per-file salt.
- The document is encrypted with **AES-256-GCM** under a random key, which is itself encrypted with
  the passphrase-derived key. Every save uses a fresh key, salt and nonces.
- Everything is inside the encryption for protected documents: text, images, title, dates. Only the
  Argon2 parameters are visible in the file header. Without a passphrase, the header explicitly says
  `{"encryption":"none"}` and the ZIP body is readable by anyone who has the file.
- A wrong passphrase and a damaged file are told apart; tampering is detected.
- Third-party code is vendored in the repository (no CDN), versions are pinned, and hashes are in
  `js/vendor/SHA256SUMS`.

When hosted, security depends on the host serving unmodified files. A local copy is the most
trustworthy option.

The file format and design decisions are described in detail in [DESIGN.md](DESIGN.md).

## Verification

There are no automated tests. Manual checks:

- **Vendored libraries are unmodified:**
  ```bash
  cd js/vendor && sha256sum -c SHA256SUMS
  ```
- **Older documents still open:** both files in `testdata/` must open with the passphrase
  `abandon ability able about above absent absorb abstract absurd abuse access accident`
  (each opens with a title, a line of text and a blue image; the sample text itself is in Russian).

## Layout

```
index.html, css/      — user interface (+ icons/)
js/sdoc.js            — .sdoc format and encryption (Argon2 in js/kdf-worker.js)
js/zip.js             — ZIP container
js/import.js          — DOCX import
js/editor.js, app.js  — editor and workflows
js/vendor/            — hash-wasm (Argon2)
testdata/             — .sdoc samples for compatibility checks
```

## Libraries and browser APIs

SecureDoc uses no UI framework, package manager or runtime dependency. It relies on one bundled
library, one bundled data file, and standard browser APIs:

- [hash-wasm](https://github.com/Daninet/hash-wasm) 4.12.0 — bundled WebAssembly implementation of
  Argon2id, MIT licence.
- [BIP-39 English wordlist](https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt) — bundled
  list of 2048 words used to generate memorable passphrases. SecureDoc does not create wallet seeds.
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) — secure random
  bytes and AES-256-GCM encryption/decryption.
- [`CompressionStream` and `DecompressionStream`](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream)
  — ZIP compression and decompression for `.sdoc` and imported `.docx` files.
- [`DOMParser`](https://developer.mozilla.org/en-US/docs/Web/API/DOMParser) — inert parsing and
  sanitisation of document HTML and DOCX XML.
- [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) — direct
  save-over support where available; other browsers use ordinary file downloads.
- Web Workers — background Argon2id derivation when the browser permits it.
