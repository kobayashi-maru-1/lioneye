<#
.SYNOPSIS
  Tells whether PoB Redux changed the build checks the guide's Build health is ported from.

.DESCRIPTION
  Build health (pob-host.lua, healthFindings) is a port of PoB Redux's sanity_check in
  crates/pob-engine/lua/bridge.lua (https://github.com/pobredux/pob-redux, MIT). This
  reads that function from Redux's main branch and compares its fingerprint with
  redux-watch.json, the version last ported. A change needs porting by hand: Redux's
  checks use its own helpers and are written for its assistant.

  Prints "unchanged" or "changed" with the commit to compare. In GitHub Actions it also
  writes changed=true|false, commit and compare (a link) to GITHUB_OUTPUT.

.PARAMETER Update
  After porting a change: records Redux's current sanity_check as the ported version.
#>
param(
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
$repo = 'pobredux/pob-redux'
$path = 'crates/pob-engine/lua/bridge.lua'
$pinFile = Join-Path $PSScriptRoot 'redux-watch.json'

$headers = @{ 'User-Agent' = 'exile-leveling-redux-watch' }
if ($env:GITHUB_TOKEN) { $headers.Authorization = "Bearer $env:GITHUB_TOKEN" }
$commit = (Invoke-RestMethod -Headers $headers "https://api.github.com/repos/$repo/commits/main").sha
$source = Invoke-RestMethod -Headers $headers "https://raw.githubusercontent.com/$repo/$commit/$path"

# The function: from its definition to the next top-level M.<name> (or the file's end).
$lines = ($source -replace "`r`n", "`n") -split "`n"
$start = [Array]::FindIndex($lines, [Predicate[string]] { param($l) $l -match '^M\.sanity_check\s*=' })
if ($start -lt 0) { throw "sanity_check isn't in $path any more: Redux moved it. Find it and update this script." }
$end = $start + 1
while ($end -lt $lines.Count -and $lines[$end] -notmatch '^M\.\w+\s*=') { $end++ }
$body = ($lines[$start..($end - 1)] -join "`n").TrimEnd()
$sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($body))).ToLower()

if ($Update) {
  [ordered]@{ repo = $repo; file = $path; function = 'sanity_check'; commit = $commit; sha256 = $sha } |
    ConvertTo-Json | Set-Content -Encoding utf8 $pinFile
  Write-Host "Recorded sanity_check at $commit"
  return
}

$pin = Get-Content -Raw $pinFile | ConvertFrom-Json
$changed = $sha -ne $pin.sha256
$compare = "https://github.com/$repo/compare/$($pin.commit)...$commit"
if ($changed) {
  Write-Host "changed: Redux's sanity_check differs from the ported version. Compare: $compare"
} else {
  Write-Host "unchanged (Redux $commit)"
}
if ($env:GITHUB_OUTPUT) {
  "changed=$($changed.ToString().ToLower())" | Add-Content $env:GITHUB_OUTPUT
  "commit=$commit" | Add-Content $env:GITHUB_OUTPUT
  "compare=$compare" | Add-Content $env:GITHUB_OUTPUT
}
