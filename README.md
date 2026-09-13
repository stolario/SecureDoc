# SecureDoc

An editor for encrypted rich-text documents that runs entirely in the browser.
A document is a single `.sdoc` file that opens only with a 12-word passphrase.

The passphrase, the text and imported files **never leave the page**: encryption, decryption and
import all happen in the browser, and the page makes no network requests. There is no server-side
logic, no build step and nothing to install.

## Features

- Formatting: bold, italic, underline, font size, alignment, indentation.
- Tables: add/remove rows and columns, cell fill colour.
- Images: insert from a file or the clipboard, resize.
- Import from **DOCX** (formatting, tables, images).
- Export to PDF via printing.
- Passphrase change.

## Running

| How | What works |
|---|---|
| **`run.bat`** (double-click) — starts a local server on `http://localhost:8637` and opens the browser | everything |
| Open **`index.html`** from disk | everything |
| Put `index.html`, `css/`, `js/`, `icons/` on any static host with HTTPS | everything |

`run.bat` needs only the PowerShell built into Windows. The server (`scripts/serve.ps1`) does no
processing: it only serves the app's own files, and only to this computer. Stop it with Ctrl+C or by
closing the window.

A modern browser is required (Chrome/Edge 103+, Firefox 113+, Safari 16.4+). In Chrome and Edge,
Save asks for a location once and then overwrites the same file; in other browsers saving downloads
the `.sdoc`.

## Usage

1. **Create** — click **Generate**, **write the 12 words down**, then click **Create**.
   A forgotten passphrase cannot be recovered.
2. **Save** — the floppy-disk button or Ctrl+S (Ctrl+Shift+S — Save as).
3. **Open** — enter the 12 words, then pick an `.sdoc` file or drop it on the card.
4. **Import** — set a passphrase, then pick or drop a `.docx`; save it as `.sdoc`.

Only a **generated** phrase is strong (132 bits of entropy). Words you choose yourself pass the
check but are far easier to guess.

## Security

- The key is derived from the passphrase with **Argon2id** (64 MiB memory, 3 passes) and a random
  per-file salt.
- The document is encrypted with **AES-256-GCM** under a random key, which is itself encrypted with
  the passphrase-derived key. Every save uses a fresh key, salt and nonces.
- Everything is inside the encryption: text, images, title, dates. Only the Argon2 parameters are
  in the clear.
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
run.bat, scripts/     — local launch
testdata/             — .sdoc samples for compatibility checks
```

## Third-party code

- [hash-wasm](https://github.com/Daninet/hash-wasm) 4.12.0 — MIT
- [BIP-39 English](https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt) wordlist
