# Local static server for SecureDoc (DESIGN.md §1).
#
# The page also works opened straight from disk; this serves it over http://localhost instead.
# Nothing is processed here — the server only hands out the app's own files; encryption and import
# still run entirely in the browser.
#
#   run.bat                                   (double-click; opens the browser)
#   powershell -File scripts\serve.ps1 [-Port 8637] [-NoBrowser]
#
# Windows PowerShell 5.1+, nothing to install. Ctrl+C stops it.
# Saved as UTF-8 with BOM: without it Windows PowerShell 5.1 reads non-ASCII characters (the dashes) as ANSI.

param(
    [int]$Port = 8637,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
# Non-ASCII output must survive both a console window and a redirected log.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

# Only the app itself is served — never .git, .claude, DESIGN.md, testdata or this script.
$allowedFiles = @('index.html')
$allowedDirs = @('css', 'js', 'icons')

$types = @{
    '.html'  = 'text/html; charset=utf-8'
    '.js'    = 'text/javascript; charset=utf-8'
    '.css'   = 'text/css; charset=utf-8'
    '.png'   = 'image/png'
    '.svg'   = 'image/svg+xml'
    '.ico'   = 'image/x-icon'
}

function Resolve-AppFile([string]$urlPath) {
    $rel = [Uri]::UnescapeDataString($urlPath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $rel = $rel -replace '/', '\'
    $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { return $null } # ..\ escape
    $inside = $full.Substring($root.Length + 1)
    $top = ($inside -split '\\')[0]
    $allowed = ($allowedFiles -contains $inside) -or (($allowedDirs -contains $top) -and $inside.Contains('\'))
    if ($allowed -and (Test-Path -LiteralPath $full -PathType Leaf)) { return $full }
    return $null
}

$url = "http://localhost:$Port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url) # only Host: localhost is routed here; non-local clients are also refused below
try {
    $listener.Start()
} catch {
    Write-Host "Could not start the server on $url — is port $Port in use? Pick another one: -Port 8638" -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 1
}

Write-Host "SecureDoc: $url"
Write-Host "Serving only index.html, css\, js\ and icons\ from $root. Press Ctrl+C to stop."
if (-not $NoBrowser) { Start-Process $url }

try {
    while ($listener.IsListening) {
        # Wait in short slices so Ctrl+C is handled between requests.
        $pending = $listener.GetContextAsync()
        while (-not $pending.AsyncWaitHandle.WaitOne(250)) { }
        $ctx = $pending.GetAwaiter().GetResult()
        $req = $ctx.Request
        $res = $ctx.Response
        try {
            $res.Headers['Cache-Control'] = 'no-store'
            $res.Headers['X-Content-Type-Options'] = 'nosniff'
            if (-not $req.IsLocal) {
                $res.StatusCode = 403 # belt and braces: only this machine, whatever the Host header says
            } elseif ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') {
                $res.StatusCode = 405
            } else {
                $file = Resolve-AppFile $req.Url.AbsolutePath
                if ($null -eq $file) {
                    $res.StatusCode = 404
                } else {
                    $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
                    $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
                    $bytes = [IO.File]::ReadAllBytes($file)
                    $res.ContentLength64 = $bytes.Length
                    if ($req.HttpMethod -eq 'GET') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
                }
            }
            Write-Host ("{0} {1} {2}" -f $res.StatusCode, $req.HttpMethod, $req.Url.AbsolutePath)
        } catch {
            Write-Host "Error on $($req.Url.AbsolutePath): $($_.Exception.Message)" -ForegroundColor Yellow
        } finally {
            $res.Close()
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
