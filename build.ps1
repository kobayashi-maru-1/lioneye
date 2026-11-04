<#
.SYNOPSIS
  Builds exile-leveling.exe (the guide and the log watcher in one program).

.DESCRIPTION
  Needs Node.js 22+ and Rust (rustup) on PATH. Output: .\exile-leveling.exe
  -SkipTree reuses tree data from an earlier build (the download is ~7 MB).
#>
param(
  [switch]$SkipTree
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

foreach ($tool in 'node', 'npm', 'cargo') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool isn't on PATH. Install Node.js 22+ and Rust (https://rustup.rs) first."
  }
}

function Invoke-Step([string]$Name, [scriptblock]$Command) {
  Write-Host "==> $Name" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
}

Invoke-Step 'Installing packages' { npm ci }

if (-not $SkipTree -or -not (Test-Path 'common\data\tree\*.json')) {
  Invoke-Step 'Downloading skill tree data' { npm -w seeding run seed tree }
}

Invoke-Step 'Building the guide' { npm -w web run build:desktop }

Push-Location log-api
try {
  Invoke-Step 'Building the exe' { cargo build --release }
}
finally {
  Pop-Location
}

Copy-Item 'log-api\target\release\exile-leveling.exe' '.\exile-leveling.exe' -Force
Write-Host "Done: $PSScriptRoot\exile-leveling.exe" -ForegroundColor Green
