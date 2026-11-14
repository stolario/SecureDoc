# Keeps the shared document code identical in SecureDoc and webchat (DESIGN.md §12).
#
# SecureDoc/js/ is the source. webchat's Documents section carries byte-for-byte copies in
# src/main/resources/static/js/. Edit only the SecureDoc files, then:
#
#   scripts\sync-webchat.ps1 -Copy     copy them into webchat (then bump the ?v= numbers there)
#   scripts\sync-webchat.ps1           check only: exit 1 and list the files that differ
#
# Line endings are ignored (webchat's checkout may turn LF into CRLF); everything else must match.
param(
    [string]$Webchat = (Join-Path $PSScriptRoot '..\..\webchat'),
    [switch]$Copy
)

$ErrorActionPreference = 'Stop'
$shared = @('byte-utils.js', 'zip.js', 'sdoc.js', 'kdf-worker.js', 'doc-html.js', 'editor-core.js')
$source = Join-Path $PSScriptRoot '..\js'
$target = Join-Path $Webchat 'src\main\resources\static\js'

if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    Write-Host "webchat not found: $target (pass -Webchat <path>)"
    exit 2
}

function Normalized([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    return ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)) -replace "`r`n", "`n"
}

$different = @()
foreach ($name in $shared) {
    $from = Join-Path $source $name
    $to = Join-Path $target $name
    if ($Copy) {
        Copy-Item -LiteralPath $from -Destination $to -Force
    }
    if ((Normalized $from) -cne (Normalized $to)) { $different += $name }
}

if ($different.Count -gt 0) {
    Write-Host ('webchat copies differ from SecureDoc/js: ' + ($different -join ', '))
    Write-Host 'Edit SecureDoc/js only, then run scripts\sync-webchat.ps1 -Copy.'
    exit 1
}
if ($Copy) {
    Write-Host ('Copied to ' + (Resolve-Path $target) + ': ' + ($shared -join ', '))
    Write-Host 'Now bump the ?v= of each changed file where webchat loads it (documents.js, chat.js), and VERSION.'
} else {
    Write-Host ('In sync: ' + ($shared -join ', '))
}
exit 0
