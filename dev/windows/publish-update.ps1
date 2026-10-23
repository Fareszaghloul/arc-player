<#
.SYNOPSIS
Builds the Arc Windows installer and writes the update feed that Arc's in-app
updater reads.

.DESCRIPTION
1. Runs bundle.bat (unless -SkipBuild) to produce build\Arc-<VERSION>-x64.exe.
2. Hashes it (SHA-256) and writes build\arc-update.json pointing at
   <DownloadBaseUrl>/Arc-<VERSION>-x64.exe.

Upload both files so that:
  - the installer is reachable at the URL written into the feed, and
  - arc-update.json is reachable at the feed URL baked into Arc
    (CMake -DARC_UPDATE_FEED_URL=...).

With GitHub Releases on your own repository, a stable feed URL is
  https://github.com/<owner>/<repo>/releases/latest/download/arc-update.json
and the download base for a release tagged v0.2.0 is
  https://github.com/<owner>/<repo>/releases/download/v0.2.0

Bump VERSION before each release: Arc only offers versions newer than its own.

.EXAMPLE
.\dev\windows\publish-update.ps1 -DownloadBaseUrl "https://github.com/me/arc/releases/download/v0.2.0" -Notes "New home screen."
#>
param(
    [Parameter(Mandatory = $true)]
    [string] $DownloadBaseUrl,

    [string] $Notes = "",

    [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+') {
    throw "VERSION must start with major.minor.patch, found '$version'"
}

if (-not $DownloadBaseUrl.StartsWith('https://') -and $DownloadBaseUrl -notmatch '^http://(localhost|127\.0\.0\.1)(:\d+)?(/|$)') {
    throw "DownloadBaseUrl must use HTTPS (Arc refuses plain HTTP except from this machine): $DownloadBaseUrl"
}

if (-not $SkipBuild) {
    & cmd /c "`"$PSScriptRoot\bundle.bat`""
    if ($LASTEXITCODE -ne 0) {
        throw "bundle.bat failed with exit code $LASTEXITCODE"
    }
}

$installerName = "Arc-$version-x64.exe"
$installer = Join-Path $root "build\$installerName"
if (-not (Test-Path $installer)) {
    throw "Installer not found: $installer"
}

$sha256 = (Get-FileHash -Path $installer -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item $installer).Length

$feed = [ordered]@{
    version   = $version
    released  = (Get-Date -Format 'yyyy-MM-dd')
    notes     = $Notes
    platforms = [ordered]@{
        'windows-x64' = [ordered]@{
            url    = "$($DownloadBaseUrl.TrimEnd('/'))/$installerName"
            sha256 = $sha256
            size   = $size
        }
    }
}

$feedPath = Join-Path $root 'build\arc-update.json'
# UTF-8 without a byte-order mark, which Windows PowerShell's Set-Content would add.
[System.IO.File]::WriteAllText($feedPath, ($feed | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))

Write-Host ""
Write-Host "Arc $version is ready to publish."
Write-Host "  Installer: $installer"
Write-Host "  SHA-256:   $sha256"
Write-Host "  Feed:      $feedPath"
Write-Host ""
Write-Host "Upload the installer to $($DownloadBaseUrl.TrimEnd('/'))/ and arc-update.json to your feed URL."
