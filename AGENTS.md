# Agent notes

SecureDoc is a static browser application. It has no backend and no build step.

For browser testing, prefer `run.bat` on Windows. It starts the repository's static-only server at
`http://localhost:8637` and opens the page. The helper exists to avoid `file://` restrictions and to
let the Argon2 Web Worker run; it is testing/development infrastructure, not part of the user flow.
Stop it with Ctrl+C or by closing its console window.

The server implementation is `scripts/serve.ps1`. It serves only `index.html`, `css/`, `js/`, and
`icons/`; it must not expose repository metadata, design documents, or test fixtures.
