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
- Section dividers: ornaments, arrows and composed rules, from a drop-down.
- A background around the page: six colours, patterns from dots to a Penrose tiling, and a few
  optical illusions, two of them animated. The choice is a view preference, not part of the file.
- Import from **DOCX** (formatting, tables, images).
- Export to PDF via printing.
- Passphrase change.

Documents use the bundled Roboto Flex by default and can use the bundled Roboto Serif for selected
text. Both travel with the app, so a document looks the same — and breaks its lines in the same
places — on every machine.

## Running

Open **`index.html`** in a browser — on Windows, double-clicking `run.bat` does just that. There is
nothing to install, nothing to build and no server: the page is the whole application. The same
folder can also be dropped on any static HTTPS host as it is.

Running from disk costs one thing: Chrome will not start a Web Worker from `file://`, so the key
derivation runs on the main thread and saving or opening a protected document holds the page for a
second or two. While that happens the app puts up a dialog saying what it is doing, rather than
appearing frozen. On a host the worker starts and nothing blocks.

A modern browser is required (Chrome/Edge 109+, Firefox 113+, Safari 16.4+). In Chrome and Edge,
Save asks for a location once and then overwrites the same file; in other browsers saving downloads
the `.sdoc`.

## The document font

Documents use bundled variable fonts: **[Roboto Flex](https://github.com/googlefonts/roboto-flex)**
by default and **[Roboto Serif](https://github.com/googlefonts/roboto-serif)** as a selectable serif
face. Their files and SIL Open Font License 1.1 texts travel in `css/fonts/`; both may be used,
modified and redistributed, including commercially. Nothing is downloaded at runtime, and system
fonts remain only as fallbacks.

It is there for two reasons. A font that comes with the app draws a document the same way on every
machine, so the same `.sdoc` breaks its lines in the same places and prints to the same number of
pages — with the system font it was a different document on every system. And Roboto Flex is a
*variable* font: one file covers every weight the editor needs, and its axes can be asked for
proportions a static font cannot give. The app uses that to set the letters taller than the font's
own default, at the same line pitch and the same widths:

```css
font-variation-settings: "YTLC" 570, "YTAS" 854, "YTUC" 760, "YTFI" 788;
```

x-height, ascenders, capitals and figures, each at the top of its axis. Because the height comes
from the font's own drawing rather than from a CSS transform, it survives printing: a PDF looks
like the screen and still breaks across pages correctly.

The divider ornaments and the diagonal arrows are not in this font and come from the reader's
system font, so they are the one part of a document that still varies between machines.

The two bundled fonts account for most of the first load; the browser caches them afterwards.

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
- **Compatibility samples still open:** the four files in `testdata/` must open with the passphrase
  `abandon ability able about above absent absorb abstract absurd abuse access accident`:
  - `java-v1.sdoc` and `browser-v1.sdoc` — a title, a line of text and a blue image;
  - `weak-kdf-v1.sdoc` — the same, but written with weak key-derivation settings: it must open
    with a warning about them, and a save must bring the file up to today's parameters;
  - `rich-v1.sdoc` — every format the editor writes (a link, coloured text, an indent, a MathML
    fraction, a table with a filled cell and rounded corners, a divider, a resized image).

## Layout

```
index.html, css/      — user interface (+ icons/)
css/fonts/            — RobotoFlex.ttf + OFL.txt; RobotoSerif.ttf + RobotoSerif-OFL.txt
js/sdoc.js            — .sdoc format and encryption (Argon2 in js/kdf-worker.js)
js/byte-utils.js      — byte helpers shared by zip.js and sdoc.js
js/zip.js             — ZIP container
js/import.js          — DOCX import
js/doc-html.js        — document HTML contract (sanitizing, shared with webchat)
js/editor-core.js     — editor commands (shared with webchat)
js/passphrase.js      — generating, normalising and checking the 12 words
js/wordlist.js        — the BIP-39 English wordlist
js/app.js             — workflows and UI
js/vendor/            — hash-wasm (Argon2)
testdata/             — .sdoc samples for compatibility checks
run.bat               — opens index.html in the browser
scripts/              — the sync with webchat's copies of the shared files
tools/                — development helpers the app never loads (a font tuner)
```

## Libraries and browser APIs

SecureDoc uses no UI framework, package manager or runtime dependency. It relies on one bundled
library, one bundled data file, two bundled fonts, and standard browser APIs:

- [hash-wasm](https://github.com/Daninet/hash-wasm) 4.12.0 — bundled WebAssembly implementation of
  Argon2id, MIT licence.
- [Roboto Flex](https://github.com/googlefonts/roboto-flex) — the default bundled variable font,
  SIL Open Font License 1.1. Copyright 2011 The Roboto Flex Project Authors.
- [Roboto Serif](https://github.com/googlefonts/roboto-serif) — the bundled variable serif option,
  SIL Open Font License 1.1. Copyright 2020 The Roboto Serif Project Authors.
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
