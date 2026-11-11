# Builds the versioned installation artifact: dist\wra-<version>.tgz plus its SHA-256.
# Reproducible given the same Node.js, npm and lockfiles:
#   web\npm ci && npm run build          (React UI, baked into the package)
#   npm pack                              (src, README, LICENSE, web\dist)
# No secrets and no user state are included: `files` in package.json is the whole list.

[CmdletBinding()]
param([switch]$SkipWebBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $PSScriptRoot 'dist'

if (-not $SkipWebBuild) {
  Write-Host 'Building the web UI...'
  Push-Location (Join-Path $root 'web')
  try {
    if (-not (Test-Path 'node_modules')) { & npm ci | Out-Host }
    & npm run build | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'web build failed' }
  } finally {
    Pop-Location
  }
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
Push-Location $root
try {
  $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
  & npm pack --pack-destination $dist | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
  $tgz = Join-Path $dist "wra-$version.tgz"
  if (-not (Test-Path $tgz)) { throw "expected $tgz, not found" }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($tgz)
    try { $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
  "$hash  wra-$version.tgz" | Set-Content -Encoding ascii (Join-Path $dist "wra-$version.tgz.sha256")
  Write-Host ''
  Write-Host "artifact: $tgz"
  Write-Host "sha256:   $hash"
  Write-Host "install:  installer\Install-WRA.ps1 -PackagePath `"$tgz`""
} finally {
  Pop-Location
}
