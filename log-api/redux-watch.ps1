#Requires -Version 7
<#
.SYNOPSIS
  Tells whether PoB Redux changed the build checks the guide's Build health is ported from.

.DESCRIPTION
  Build health (pob-host.lua, healthFindings) is a port of PoB Redux's sanity_check in
  crates/pob-engine/lua/bridge.lua (https://github.com/pobredux/pob-redux, MIT), and of the
  helpers ported with it (build_summary, the act table, quest points, press class, granted
  gems, requirements, keystones). This reads each from Redux's main branch and compares
  their fingerprints with redux-watch.json, the versions last ported. A change needs porting
  by hand: Redux's checks use its own helpers and are written for its assistant.

  Prints "unchanged" or "changed" with the parts and a link to compare. In GitHub Actions
  it also writes changed=true|false, commit and compare to GITHUB_OUTPUT.

.PARAMETER Update
  After porting a change: records Redux's current versions as the ported ones.
#>
param(
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
$repo = 'pobredux/pob-redux'
$path = 'crates/pob-engine/lua/bridge.lua'
$pinFile = Join-Path $PSScriptRoot 'redux-watch.json'

# What was ported, by the line that starts it.
$parts = [ordered]@{
  sanity_check        = '^M\.sanity_check\s*='
  build_summary       = '^M\.build_summary\s*='
  POE1_ACTS           = '^local POE1_ACTS\s*='
  questPointsForLevel = '^local function questPointsForLevel\('
  gemPressClass       = '^function gemUtil\.gemPressClass\('
  grantedGemNote      = '^function gemUtil\.grantedGemNote\('
  requirementSummary  = '^function gemUtil\.requirementSummary\('
  keystoneProfile     = '^function keystone\.profile\('
}
# Where the next top-level definition starts, and so where one ends.
$definition = '^((local\s+)?function\s|M\.\w+\s*=|local\s+[\w,\s]+=|return\s)'

$headers = @{ 'User-Agent' = 'exile-leveling-redux-watch' }
if ($env:GITHUB_TOKEN) { $headers.Authorization = "Bearer $env:GITHUB_TOKEN" }
$commit = (Invoke-RestMethod -Headers $headers "https://api.github.com/repos/$repo/commits/main").sha
$source = Invoke-RestMethod -Headers $headers "https://raw.githubusercontent.com/$repo/$commit/$path"
$lines = ($source -replace "`r`n", "`n") -split "`n"

# A part's fingerprint: its lines from its start to the next definition (or the file's end).
function Get-Fingerprint([string]$name, [string]$startPattern) {
  $start = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $startPattern) { $start = $i; break }
  }
  if ($start -lt 0) { throw "$name isn't in $path any more: Redux moved it. Find it and update this script." }
  $end = $start + 1
  while ($end -lt $lines.Count -and $lines[$end] -notmatch $definition) { $end++ }
  $body = ($lines[$start..($end - 1)] -join "`n").TrimEnd()
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($body))).ToLower()
}

$current = [ordered]@{}
foreach ($name in $parts.Keys) { $current[$name] = Get-Fingerprint $name $parts[$name] }

if ($Update) {
  [ordered]@{ repo = $repo; file = $path; commit = $commit; functions = $current } |
    ConvertTo-Json | Set-Content -Encoding utf8 $pinFile
  Write-Host "Recorded $($parts.Keys -join ', ') at $commit"
  return
}

$pin = Get-Content -Raw $pinFile | ConvertFrom-Json
$changedNames = @($parts.Keys | Where-Object { $pin.functions.$_ -ne $current[$_] })
$changed = $changedNames.Count -gt 0
$compare = "https://github.com/$repo/compare/$($pin.commit)...$commit"
if ($changed) {
  Write-Host "changed: Redux's $($changedNames -join ', ') differ from the ported versions. Compare: $compare"
} else {
  Write-Host "unchanged (Redux $commit)"
}
if ($env:GITHUB_OUTPUT) {
  "changed=$($changed.ToString().ToLower())" | Add-Content $env:GITHUB_OUTPUT
  "commit=$commit" | Add-Content $env:GITHUB_OUTPUT
  "compare=$compare" | Add-Content $env:GITHUB_OUTPUT
}
