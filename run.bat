@echo off
rem Launch SecureDoc on Windows: serves the app on http://localhost:8637 and opens the browser.
rem Optional: the app also works by opening index.html directly.
rem Ctrl+C (or closing this window) stops the server.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve.ps1" %*
