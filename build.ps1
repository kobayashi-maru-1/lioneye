<#
.SYNOPSIS
  Builds exile-leveling.exe (the guide and the log watcher in one program).

.DESCRIPTION
  Needs Node.js 22+ and Rust (rustup) on PATH. Output: .\exile-leveling.exe
  -SkipTree reuses tree data from an earlier build (the download is ~7 MB).
  Each build bundles the latest Path of Building release for the Stats tab
  (log-api\fetch-pob.ps1; skipped when that release is already downloaded).
#>
param(
  [switch]$SkipTree
)

$ErrorActionPreference = 'Stop'

foreach ($tool in 'node', 'npm', 'cargo', 'git') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool isn't on PATH. Install Node.js 22+, Rust (https://rustup.rs) and Git first."
  }
}

function Invoke-Step([string]$Name, [scriptblock]$Command) {
  Write-Host "==> $Name" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
}

# Rust's build output is 1-2 GB. Keep it out of synced folders such as OneDrive.
$savedTargetDir = $env:CARGO_TARGET_DIR
if (-not $env:CARGO_TARGET_DIR -and $env:LOCALAPPDATA) {
  $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'exile-leveling\cargo-target'
}
# cargo runs in log-api, so a relative CARGO_TARGET_DIR is relative to it.
$targetDir = [IO.Path]::Combine((Join-Path $PSScriptRoot 'log-api'),
  $(if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'target' }))

Push-Location $PSScriptRoot
try {
  Invoke-Step 'Installing packages' { npm ci }

  if (-not $SkipTree -or -not (Test-Path 'common\data\tree\*.json')) {
    Invoke-Step 'Downloading skill tree data' { npm -w seeding run seed tree }
  }

  Invoke-Step 'Building the guide' { npm -w web run build:desktop }

  Write-Host '==> Downloading Path of Building' -ForegroundColor Cyan
  & (Join-Path $PSScriptRoot 'log-api\fetch-pob.ps1')

  Push-Location log-api
  try {
    Invoke-Step 'Building the exe' { cargo build --release }
  }
  finally {
    Pop-Location
  }

  $built = Join-Path $targetDir 'release\exile-leveling.exe'
  if (-not (Test-Path -LiteralPath $built)) {
    throw "The build finished but $built is missing."
  }
  $exe = Join-Path $PSScriptRoot 'exile-leveling.exe'
  try {
    Copy-Item -LiteralPath $built -Destination $exe -Force
  }
  catch {
    throw "Couldn't replace $exe ($($_.Exception.Message)). If it's running, close its console window and run .\build.ps1 -SkipTree again."
  }
  Write-Host "Done: $exe" -ForegroundColor Green
}
finally {
  Pop-Location
  $env:CARGO_TARGET_DIR = $savedTargetDir
}
