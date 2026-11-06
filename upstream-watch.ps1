#Requires -Version 7
<#
.SYNOPSIS
  Tells whether HeartofPhos's exile-leveling (routes, gems, trees) or exile-log-api has
  changes this repo hasn't merged yet.

.DESCRIPTION
  Lioneye's route and game data come from upstream exile-leveling, merged by hand
  (DESKTOP.md, "Pull upstream updates"). This compares each upstream's latest commit with
  web/src/upstream.json, the versions last merged; the guide's footer shows that route date.

  Prints "unchanged" or "changed" with links to compare. In GitHub Actions it also writes
  changed=true|false and summary to GITHUB_OUTPUT.

.PARAMETER Update
  After merging upstream: records the upstreams' current commits as merged.
#>
param(
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
$pinFile = Join-Path $PSScriptRoot 'web/src/upstream.json'
$repos = [ordered]@{
  exileLeveling = 'HeartofPhos/exile-leveling'
  logApi        = 'HeartofPhos/exile-log-api'
}

$headers = @{ 'User-Agent' = 'lioneye-upstream-watch' }
if ($env:GITHUB_TOKEN) { $headers.Authorization = "Bearer $env:GITHUB_TOKEN" }

$current = [ordered]@{}
foreach ($name in $repos.Keys) {
  $commit = Invoke-RestMethod -Headers $headers "https://api.github.com/repos/$($repos[$name])/commits/main"
  $current[$name] = [ordered]@{
    repo   = $repos[$name]
    commit = $commit.sha
    date   = ([datetime]$commit.commit.committer.date).ToUniversalTime().ToString('yyyy-MM-dd')
  }
}

if ($Update) {
  $current | ConvertTo-Json | Set-Content -Encoding utf8 $pinFile
  foreach ($name in $repos.Keys) { Write-Host "Recorded $($repos[$name]) $($current[$name].commit.Substring(0, 7)) ($($current[$name].date))" }
  return
}

$pin = Get-Content -Raw $pinFile | ConvertFrom-Json
$lines = @()
foreach ($name in $repos.Keys) {
  $merged = $pin.$name.commit
  if ($merged -ne $current[$name].commit) {
    $lines += "$($repos[$name]) has changes since $($pin.$name.date): https://github.com/$($repos[$name])/compare/$merged...$($current[$name].commit)"
  }
}
$changed = $lines.Count -gt 0
if ($changed) { $lines | ForEach-Object { Write-Host "changed: $_" } } else { Write-Host 'unchanged' }
if ($env:GITHUB_OUTPUT) {
  "changed=$($changed.ToString().ToLower())" | Add-Content $env:GITHUB_OUTPUT
  "summary=$($lines -join ' | ')" | Add-Content $env:GITHUB_OUTPUT
}
