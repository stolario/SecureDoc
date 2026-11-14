@echo off
rem Launch SecureDoc on Windows: opens index.html in the default browser.
rem Everything runs in the page itself - there is nothing to serve and nothing to install.
start "" "%~dp0index.html"
