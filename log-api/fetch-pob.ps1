<#
.SYNOPSIS
  Downloads Path of Building's calculation code and game data for the exe to bundle.

.DESCRIPTION
  Gets the latest Path of Building Community release (or -Tag) and writes
  log-api\pob\pob.zip and log-api\pob\version.txt. Only what headless calculation
  needs is kept: Lua code, game data and the latest tree. Art and the timeless
  jewel tables are left out (the exe downloads a jewel's table when a build needs it).
  Skips the download when that release is already here, and keeps the bundle it has
  when offline. Needs git on PATH. build.ps1 and build.rs (so a plain cargo build or
  GitHub Actions gets it too) both run it.
#>
param(
  [string]$Tag
)

$ErrorActionPreference = 'Stop'
$repo = 'PathOfBuildingCommunity/PathOfBuilding'
$out = Join-Path $PSScriptRoot 'pob'
$zip = Join-Path $out 'pob.zip'
$versionFile = Join-Path $out 'version.txt'
# Release plus this number, recorded in bundle.txt. Raise the number when the files picked
# or how they're rewritten below change, so an existing bundle of the same release is rebuilt.
$format = 3
$bundleFile = Join-Path $out 'bundle.txt'

function Invoke-Git {
  & git @args
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed (exit $LASTEXITCODE)" }
}

$haveBundle = (Test-Path $zip) -and (Test-Path $versionFile) -and (Test-Path $bundleFile)

if (-not $Tag) {
  # Release tags are vMAJOR.MINOR.PATCH; read them with git (no API rate limit).
  $tags = & git ls-remote --tags --refs "https://github.com/$repo.git"
  if ($LASTEXITCODE -ne 0) {
    if ($haveBundle) {
      Write-Warning "Couldn't check for a newer Path of Building (offline?). Keeping $((Get-Content $versionFile -Raw).Trim())."
      return
    }
    throw "Couldn't list Path of Building's releases (git exit $LASTEXITCODE)"
  }
  $Tag = $tags |
    ForEach-Object { if ($_ -match 'refs/tags/(v(\d+)\.(\d+)\.(\d+))$') { [pscustomobject]@{ Tag = $Matches[1]; Version = [version]"$($Matches[2]).$($Matches[3]).$($Matches[4])" } } } |
    Sort-Object Version | Select-Object -Last 1 -ExpandProperty Tag
  if (-not $Tag) { throw "Couldn't find a Path of Building release tag" }
}

$bundle = "$Tag format $format"
if ($haveBundle -and ((Get-Content $bundleFile -Raw).Trim() -eq $bundle)) {
  Write-Host "Path of Building $Tag is already here."
  return
}

$work = Join-Path ([IO.Path]::GetTempPath()) "exile-leveling-pob-$([guid]::NewGuid().ToString('N'))"
try {
  Write-Host "Downloading Path of Building $Tag"
  # Partial, sparse clone: only the files checked out below are downloaded.
  Invoke-Git clone --quiet --depth 1 --branch $Tag --filter=blob:none --no-checkout "https://github.com/$repo.git" $work
  Invoke-Git -C $work sparse-checkout set --no-cone '/src/GameVersions.lua'
  Invoke-Git -C $work checkout --quiet

  # latestTreeVersion is the last entry of treeVersionList.
  $gameVersions = Get-Content (Join-Path $work 'src\GameVersions.lua') -Raw
  if ($gameVersions -notmatch '(?s)treeVersionList\s*=\s*\{(.*?)\}') { throw "Couldn't read treeVersionList from GameVersions.lua" }
  $tree = ([regex]::Matches($Matches[1], '"([^"]+)"') | Select-Object -Last 1).Groups[1].Value
  Write-Host "Latest tree: $tree"

  Invoke-Git -C $work sparse-checkout set --no-cone `
    '/LICENSE.md' `
    '/manifest.xml' `
    '/runtime/lua/' `
    '/src/*.lua' `
    '/src/Classes/' `
    '/src/Modules/' `
    '/src/Data/' `
    '!/src/Data/TimelessJewelData/*.zip' `
    '!/src/Data/TimelessJewelData/*.zip.part*' `
    "/src/TreeData/$tree/*.lua" `
    '/src/TreeData/legion/*.lua' `
    '/src/TreeData/3_19/Assets.lua'

  # Layout the exe expects: PoB's src folder at the root, its Lua libraries in lua\.
  $stage = Join-Path $work 'stage'
  New-Item -ItemType Directory -Force $stage | Out-Null
  Copy-Item -Recurse (Join-Path $work 'src\*') $stage
  Copy-Item -Recurse (Join-Path $work 'runtime\lua') (Join-Path $stage 'lua')
  Copy-Item (Join-Path $work 'manifest.xml'), (Join-Path $work 'LICENSE.md') $stage

  # PoB's own LuaJIT takes compound assignment ("count += 1", from PoB 2.68); the LuaJIT the
  # exe embeds doesn't. Rewrite each one-statement line to "count = count + (1)". Lines with
  # a comment, a second statement or a call in the target are left alone: the exe's
  # bundled_lua_compiles test then fails the build instead of shipping code that can't load.
  $compound = [regex]'(?m)^(?<indent>[ \t]*)(?<target>[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^\]\r\n()]+\])*)[ \t]*(?<op>\.\.|[-+*/%^])=[ \t]*(?<value>[^;\r\n]*?)[ \t]*(?<eol>\r?)$'
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  foreach ($file in Get-ChildItem $stage -Recurse -Filter '*.lua') {
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $text = $utf8.GetString($bytes, $(if ($bom) { 3 } else { 0 }), $bytes.Length - $(if ($bom) { 3 } else { 0 }))
    $count = 0
    $new = $compound.Replace($text, {
      param($m)
      $value = $m.Groups['value'].Value
      if (-not $value -or $value.Contains('--')) { return $m.Value }
      $script:count++
      $target = $m.Groups['target'].Value
      "$($m.Groups['indent'].Value)$target = $target $($m.Groups['op'].Value) ($value)$($m.Groups['eol'].Value)"
    })
    if ($count -gt 0) {
      $fileBytes = $utf8.GetBytes($new)
      if ($bom) { $fileBytes = [byte[]](@(0xEF, 0xBB, 0xBF) + $fileBytes) }
      [IO.File]::WriteAllBytes($file.FullName, $fileBytes)
      Write-Host "Rewrote $count compound assignment(s) in $($file.FullName.Substring($stage.Length + 1))"
    }
  }

  New-Item -ItemType Directory -Force $out | Out-Null
  Remove-Item $zip -ErrorAction SilentlyContinue
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
  Set-Content -Path $versionFile -Value $Tag -NoNewline
  Set-Content -Path $bundleFile -Value $bundle -NoNewline
  Write-Host ("Wrote {0} ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
