#Requires -Version 7
<#
.SYNOPSIS
    Registers the lioneye-notebook MCP server in Claude Desktop (or removes it with -Remove).

.DESCRIPTION
    Adds "lioneye-notebook" to Claude Desktop's claude_desktop_config.json, pointing at server.py in this clone
    and the poe-build-expert venv's Python (any Python 3 works: the server uses the standard library only).
    Other servers in the file are kept. The old file is copied to Downloads first.
    Restart Claude Desktop afterwards (quit it from the tray, then start it again).

.EXAMPLE
    .\install-notebook-mcp.ps1
    .\install-notebook-mcp.ps1 -Remove
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$config = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
$server = Join-Path $PSScriptRoot 'server.py'
$python = Join-Path $env:LOCALAPPDATA 'poe-build-expert\venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $python) { throw 'No Python found: install Python 3 or set up the poe-build-expert venv.' }
}

if (Test-Path $config) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $env:USERPROFILE "Downloads\claude-desktop-config-backup-$stamp.json"
    Copy-Item $config $backup
    Write-Host "Backup: $backup"
    $raw = Get-Content $config -Raw
    $data = if ($raw.Trim()) { $raw | ConvertFrom-Json -AsHashtable } else { @{} }
} else {
    New-Item -ItemType Directory -Force (Split-Path $config) | Out-Null
    $data = @{}
}
if (-not $data.ContainsKey('mcpServers')) { $data['mcpServers'] = @{} }

if ($Remove) {
    $data['mcpServers'].Remove('lioneye-notebook')
    Write-Host 'Removed lioneye-notebook.'
} else {
    $data['mcpServers']['lioneye-notebook'] = [ordered]@{
        command = $python
        args    = @($server)
    }
    Write-Host "Added lioneye-notebook: $python $server"
}

$json = $data | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($config, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host 'Restart Claude Desktop to load it.'
