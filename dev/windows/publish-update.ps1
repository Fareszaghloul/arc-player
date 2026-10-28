<#
.SYNOPSIS
Builds the Arc Windows installer, a patch installer from the previous release, and
the update feed that Arc's in-app updater reads.

.DESCRIPTION
1. Runs bundle.bat (unless -SkipBuild) to produce build\Arc-<VERSION>-x64.exe.
2. Writes build\arc-files.json: every file the release ships, with its SHA-256.
3. Unless -NoPatch, compares that with the previous release's arc-files.json and, when
   only some files changed, compiles build\Arc-<VERSION>-patch-from-<PREVIOUS>-x64.exe
   holding just those files. Arc on <PREVIOUS> downloads the patch (usually a few MB)
   instead of the full installer; any other version, or a patch that fails, uses the
   full installer. No patch is made when the Visual C++ runtime changed, or when the
   patch would not be much smaller than the full installer.
4. Hashes the installers (SHA-256) and writes build\arc-update.json pointing at
   <DownloadBaseUrl>/<file>.

Upload the installer, the patch (if any), arc-files.json and arc-update.json so that:
  - the installers are reachable at the URLs written into the feed,
  - arc-update.json is reachable at the feed URL baked into Arc
    (CMake -DARC_UPDATE_FEED_URL=...), and
  - arc-files.json is there for the next release to build its patch from.

Arc's builds read the feed from (CMakeModules/VersionConfiguration.cmake)
  https://github.com/Fareszaghloul/arc-player/releases/latest/download/arc-update.json
so attach these files to each GitHub release. The download base for a release
tagged v0.2.0 is
  https://github.com/Fareszaghloul/arc-player/releases/download/v0.2.0
and, before it is published, .../releases/latest/download/arc-files.json is the
previous release's file list (the default for -PreviousManifest).

Bump VERSION before each release: Arc only offers versions newer than its own.

.EXAMPLE
.\dev\windows\publish-update.ps1 -DownloadBaseUrl "https://github.com/me/arc/releases/download/v0.2.0" -Notes "New home screen."
#>
param(
    [Parameter(Mandatory = $true)]
    [string] $DownloadBaseUrl,

    [string] $Notes = "",

    [switch] $SkipBuild,

    # The previous release's arc-files.json, as a path or URL. Defaults to the latest
    # GitHub release's when DownloadBaseUrl is a GitHub release URL.
    [string] $PreviousManifest = "",

    [switch] $NoPatch
)

$ErrorActionPreference = 'Stop'

# A patch must be at most this share of the full installer to be worth publishing.
$MaxPatchRatio = 0.5

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$buildDir = Join-Path $root 'build'
$deployDir = Join-Path $buildDir 'output'
$version = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+') {
    throw "VERSION must start with major.minor.patch, found '$version'"
}

if (-not $DownloadBaseUrl.StartsWith('https://') -and $DownloadBaseUrl -notmatch '^http://(localhost|127\.0\.0\.1)(:\d+)?(/|$)') {
    throw "DownloadBaseUrl must use HTTPS (Arc refuses plain HTTP except from this machine): $DownloadBaseUrl"
}
$baseUrl = $DownloadBaseUrl.TrimEnd('/')

if (-not $SkipBuild) {
    & cmd /c "`"$PSScriptRoot\bundle.bat`""
    if ($LASTEXITCODE -ne 0) {
        throw "bundle.bat failed with exit code $LASTEXITCODE"
    }
}

$installerName = "Arc-$version-x64.exe"
$installer = Join-Path $buildDir $installerName
if (-not (Test-Path $installer)) {
    throw "Installer not found: $installer"
}

# The installer must carry the VERSION being published, or Arc would keep offering it.
$iss = Join-Path $buildDir 'Arc.iss'
$built = if (Test-Path $iss) { [regex]::Match((Get-Content $iss -Raw), '#define MyAppVersion "([^"]+)"').Groups[1].Value } else { '' }
if ($built -ne $version) {
    throw "The build is configured for version '$built', not $version; reconfigure and rebuild before publishing"
}

function Write-Json($value, $path) {
    # UTF-8 without a byte-order mark, which Windows PowerShell's Set-Content would add.
    [System.IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding $false))
}

function Get-Sha256($path) {
    (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# ------------------------------------------------------------------ file manifest

if (-not (Test-Path $deployDir)) {
    throw "Staged files not found: $deployDir (bundle.bat stages them)"
}
$files = [ordered]@{}
Get-ChildItem -Path $deployDir -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($deployDir.Length + 1).Replace('\', '/')
    $files[$relative] = [ordered]@{ sha256 = (Get-Sha256 $_.FullName); size = $_.Length }
}
$manifestPath = Join-Path $buildDir 'arc-files.json'
Write-Json ([ordered]@{ version = $version; files = $files }) $manifestPath

# ------------------------------------------------------------------ patch installer

$sha256 = Get-Sha256 $installer
$size = (Get-Item $installer).Length
$patches = @()
$patchPath = $null

if (-not $NoPatch) {
    if (-not $PreviousManifest -and $baseUrl -match '^(https://github\.com/[^/]+/[^/]+)/releases/download/') {
        $PreviousManifest = "$($Matches[1])/releases/latest/download/arc-files.json"
    }

    $previous = $null
    if (-not $PreviousManifest) {
        Write-Host "No previous file list given (-PreviousManifest); publishing without a patch."
    } elseif ($PreviousManifest -match '^https?://') {
        try {
            $previous = Invoke-WebRequest -Uri $PreviousManifest -UseBasicParsing | Select-Object -ExpandProperty Content
            if ($previous -is [byte[]]) { $previous = [System.Text.Encoding]::UTF8.GetString($previous) }
            $previous = $previous | ConvertFrom-Json
        } catch {
            Write-Host "Could not read the previous file list ($PreviousManifest): $($_.Exception.Message); publishing without a patch."
        }
    } else {
        $previous = Get-Content $PreviousManifest -Raw | ConvertFrom-Json
    }

    if ($previous) {
        $from = [string]$previous.version
        $old = @{}
        foreach ($p in $previous.files.PSObject.Properties) { $old[$p.Name] = $p.Value.sha256 }

        $changed = @($files.Keys | Where-Object { $old[$_] -ne $files[$_].sha256 })
        $removed = @($old.Keys | Where-Object { -not $files.Contains($_) } | Sort-Object)
        $runtimeChanged = @($changed + $removed | Where-Object { $_ -like 'redist/*' -or $_ -eq 'vc_redist.x64.exe' })

        if ($from -eq $version) {
            Write-Host "The previous file list is for $version itself; publishing without a patch."
        } elseif ($runtimeChanged.Count) {
            Write-Host "The Visual C++ runtime changed since $from; publishing without a patch."
        } else {
            Write-Host "Patch from ${from}: $($changed.Count) changed file(s), $($removed.Count) removed."
            $lines = @('[Files]')
            foreach ($f in $changed) {
                $source = Join-Path $deployDir ($f.Replace('/', '\'))
                $subdir = Split-Path ($f.Replace('/', '\')) -Parent
                $dest = if ($subdir) { "{app}\$subdir" } else { '{app}' }
                $lines += "Source: `"$source`"; DestDir: `"$dest`"; Flags: ignoreversion"
            }
            if ($removed.Count) {
                $lines += '[InstallDelete]'
                foreach ($f in $removed) { $lines += "Type: files; Name: `"{app}\$($f.Replace('/', '\'))`"" }
            }
            $patchList = Join-Path $buildDir 'patch-files.iss'
            [System.IO.File]::WriteAllLines($patchList, $lines, (New-Object System.Text.UTF8Encoding $false))

            $iscc = [regex]::Match((Get-Content (Join-Path $buildDir 'CMakeCache.txt') -Raw), '(?m)^ISCC:FILEPATH=(.+)$').Groups[1].Value.Trim()
            if (-not $iscc -or -not (Test-Path $iscc)) { throw "Inno Setup compiler not found (ISCC in build\CMakeCache.txt)" }
            $patchBase = "Arc-$version-patch-from-$from-x64"
            & $iscc /Q "/O$buildDir" "/F$patchBase" "/DPatchFrom=$from" "/DPatchFiles=$patchList" $iss
            if ($LASTEXITCODE -ne 0) { throw "Building the patch installer failed with exit code $LASTEXITCODE" }

            $patchPath = Join-Path $buildDir "$patchBase.exe"
            $patchSize = (Get-Item $patchPath).Length
            if ($patchSize -gt $size * $MaxPatchRatio) {
                Write-Host "The patch is $([math]::Round($patchSize / 1MB, 1)) MB, not much smaller than the full installer; publishing without it."
                Remove-Item $patchPath
                $patchPath = $null
            } else {
                $patches += [ordered]@{
                    from   = $from
                    url    = "$baseUrl/$patchBase.exe"
                    sha256 = (Get-Sha256 $patchPath)
                    size   = $patchSize
                }
            }
        }
    }
}

# ------------------------------------------------------------------ feed

$entry = [ordered]@{
    url    = "$baseUrl/$installerName"
    sha256 = $sha256
    size   = $size
}
if ($patches.Count) { $entry.patches = $patches }

$feed = [ordered]@{
    version   = $version
    released  = (Get-Date -Format 'yyyy-MM-dd')
    notes     = $Notes
    platforms = [ordered]@{ 'windows-x64' = $entry }
}
$feedPath = Join-Path $buildDir 'arc-update.json'
Write-Json $feed $feedPath

Write-Host ""
Write-Host "Arc $version is ready to publish."
Write-Host "  Installer: $installer ($([math]::Round($size / 1MB, 1)) MB)"
Write-Host "  SHA-256:   $sha256"
if ($patchPath) {
    Write-Host "  Patch:     $patchPath ($([math]::Round($patches[0].size / 1MB, 1)) MB, from $($patches[0].from))"
}
Write-Host "  Files:     $manifestPath"
Write-Host "  Feed:      $feedPath"
Write-Host ""
Write-Host "Upload these to $baseUrl/ (arc-update.json must also be reachable at the feed URL)."
