<#
Signs the draft release the Desktop exe workflow made for a tag, after proving its zip was
built by that workflow from the commit you tagged here. Doesn't publish it.

    .\tools\sign-release\sign-draft.ps1 -Tag v0.4.37

1. The tag's commit here must be the one on GitHub.
2. gh attestation verify: lioneye.zip was built by .github/workflows/desktop.yml from that
   commit (an account taken over can't swap the zip or the build without failing this).
3. The exe in the zip must carry this repo's public key.
4. sign-release signs it; the signature is uploaded to the draft.

Needs: gh signed in as kobayashi-maru-1 (used per command; the active account isn't
changed), and sign-release built:
    cd tools\sign-release; $env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\exile-leveling\cargo-target-sign"; cargo build --release; Remove-Item Env:CARGO_TARGET_DIR
Files go to %USERPROFILE%\Downloads\lioneye-signing\releases\<tag>.
#>
#Requires -Version 7
param(
    [Parameter(Mandatory)][ValidatePattern('^v\d+\.\d+\.\d+$')][string]$Tag
)
$ErrorActionPreference = 'Stop'
$repo = 'kobayashi-maru-1/lioneye'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tool = Join-Path $env:LOCALAPPDATA 'exile-leveling\cargo-target-sign\release\sign-release.exe'
if (-not (Test-Path $tool)) { throw "sign-release not built: $tool" }

function Invoke-Checked {
    param([string]$What, [scriptblock]$Command)
    $out = & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
    $out
}

$priorToken = $env:GH_TOKEN
$env:GH_TOKEN = gh auth token -u kobayashi-maru-1
if (-not $env:GH_TOKEN) { throw 'gh has no kobayashi-maru-1 account' }
try {
    # 1. The commit tagged here is the one GitHub built.
    $local = Invoke-Checked 'git rev-parse' { git -C $root rev-parse "$Tag^{commit}" }
    $remoteLines = Invoke-Checked 'git ls-remote' { git -C $root ls-remote origin "refs/tags/$Tag" "refs/tags/$Tag^{}" }
    # An annotated tag lists its commit on the ^{} line, after the tag object's.
    $remote = (@($remoteLines)[-1] -split '\s+')[0]
    if ($remote -ne $local) { throw "Tag $Tag is $remote on GitHub but $local here." }

    $dir = Join-Path $env:USERPROFILE "Downloads\lioneye-signing\releases\$Tag"
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    New-Item -ItemType Directory -Force $dir | Out-Null
    $zip = Join-Path $dir 'lioneye.zip'

    $release = Invoke-Checked 'gh release view' { gh release view $Tag -R $repo --json isDraft,assets } | ConvertFrom-Json
    if (-not $release.isDraft) { throw "$Tag is already published." }
    if ($release.assets.name -contains 'lioneye.zip.minisig') { throw "$Tag is already signed." }
    Invoke-Checked 'gh release download' { gh release download $Tag -R $repo -p lioneye.zip -D $dir } | Out-Null

    # 2. Built by this repo's workflow from that commit.
    Invoke-Checked 'gh attestation verify' {
        gh attestation verify $zip -R $repo --source-digest $local --source-ref "refs/tags/$Tag" `
            --signer-workflow "github.com/$repo/.github/workflows/desktop.yml" --deny-self-hosted-runners
    } | Out-Host

    # 3. The exe trusts this repo's key (include_str! leaves it as text in the exe).
    $keyLine = (Get-Content (Join-Path $root 'log-api\release-key.pub'))[1].Trim()
    $unzipped = Join-Path $dir 'unzipped'
    Expand-Archive $zip $unzipped
    $exeText = [System.Text.Encoding]::Latin1.GetString([System.IO.File]::ReadAllBytes((Join-Path $unzipped 'lioneye.exe')))
    if (-not $exeText.Contains($keyLine)) { throw "The exe in the zip doesn't carry log-api\release-key.pub." }

    # 4. Sign and upload.
    Push-Location $root
    try { Invoke-Checked 'sign-release' { & $tool sign $zip $Tag } | Out-Host } finally { Pop-Location }
    Invoke-Checked 'gh release upload' { gh release upload $Tag "$zip.minisig" -R $repo } | Out-Null
    Write-Host "Signed $Tag. Publish: gh release edit $Tag -R $repo --draft=false --latest --notes-file <notes>"
}
finally {
    if ($priorToken) { $env:GH_TOKEN = $priorToken } else { Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue }
}
