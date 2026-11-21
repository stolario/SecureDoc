<#
Replaces origin/main history with one root commit named "init".
Tracked changes are included automatically. Untracked files remain local.
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    $output = & git @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)
    }
    return $output
}

$repository = (Invoke-Git rev-parse --show-toplevel | Select-Object -First 1).ToString()
Push-Location $repository
try {
    $branch = (Invoke-Git branch --show-current | Select-Object -First 1).ToString().Trim()
    if ($branch -ne 'main') {
        throw "Expected the main branch, currently on '$branch'."
    }

    $oldHead = (Invoke-Git rev-parse HEAD | Select-Object -First 1).ToString().Trim()
    $remoteLine = @(Invoke-Git ls-remote --heads origin refs/heads/main)
    if ($remoteLine.Count -ne 1) {
        throw 'origin/main does not exist or is ambiguous.'
    }
    $remoteHead = ($remoteLine[0].ToString() -split '\s+')[0]

    # Include modifications and deletions of tracked files. Deliberately leave every untracked file
    # local, including GOOGLE_DRIVE_OPTIONS.md.
    Invoke-Git add -u | Out-Null
    $tree = (Invoke-Git write-tree | Select-Object -First 1).ToString().Trim()
    $newHead = (Invoke-Git commit-tree $tree -m init | Select-Object -First 1).ToString().Trim()
    Invoke-Git update-ref refs/heads/main $newHead $oldHead | Out-Null

    try {
        Invoke-Git push "--force-with-lease=refs/heads/main:$remoteHead" origin main | Out-Null
    } catch {
        Invoke-Git update-ref refs/heads/main $oldHead $newHead | Out-Null
        throw "Push failed; restored local main to $oldHead.`n$($_.Exception.Message)"
    }

    Write-Host "origin/main now contains one commit: $newHead init"
} finally {
    Pop-Location
}
