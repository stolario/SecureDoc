---
name: run-app
description: Launch and drive the SecureDoc app — a static page (index.html) served by run.bat / scripts/serve.ps1 on localhost:8637; all logic runs in the browser.
---

# Running SecureDoc

SecureDoc is a **static web page** with no build step and no backend: `index.html`, `css/`, `js/`
at the repo root. Encryption (`js/sdoc.js`), the ZIP container (`js/zip.js`) and
DOCX import (`js/import.js`) all run in the browser. Third-party code is vendored in
`js/vendor/` (hash-wasm Argon2) — never loaded from a CDN.

## Launch

- **User:** double-click `run.bat` — runs `scripts/serve.ps1` (Windows PowerShell static server) on
  **http://localhost:8637** and opens the browser.
- **Agent (in-app Browser pane):** `preview_start {name: "securedoc"}` from `.claude/launch.json` —
  the same `scripts/serve.ps1` with `-NoBrowser`. It is long-running; stop with `preview_stop`.
  Server log (one line per request) via `preview_logs`.
- Opening `index.html` from disk also works. The in-app Browser pane renders `file://` pages as
  inert `data:` snapshots, so test through the server instead.

`serve.ps1` serves only `index.html`, `css/`, `js/` (404 for `.git`, `DESIGN.md`, `testdata/`,
`scripts/`…), GET/HEAD only, local clients only. It has no cache (`no-store`): edits show on reload,
no restart. It is UTF-8 **with BOM** — keep the BOM when editing, or Windows PowerShell 5.1 garbles
its non-ASCII characters. Asset paths in `index.html` must stay **relative** (`js/app.js`).

Never put helper scripts or scratch files outside the project; scratch goes to `tmp/`.

## Drive it (smoke test)

1. Tab **Create** → **Generate** (12-word passphrase) → **Create**; type in the editor.
2. Tab **Open** (testdata/ is not served — read the file from disk and pass its bytes in):
   `testdata/java-v1.sdoc` (written by the old Java implementation) and
   `testdata/browser-v1.sdoc` must both open with the passphrase
   `abandon ability able about above absent absorb abstract absurd abuse access accident`.

## Checks that used to be automated

There are no automated tests (no Java, no Node). See DESIGN.md §6.6:
- vendored libraries: `cd js/vendor && sha256sum -c SHA256SUMS`;
- `.sdoc` compatibility: the two `testdata/` samples above.
