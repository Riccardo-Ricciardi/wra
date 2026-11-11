# WRA 1.0 installer for Windows. No administrator rights, no service, no registry keys:
# everything lives under the current user's profile.
#
#   .\Install-WRA.ps1 -PackagePath .\dist\wra-0.1.0.tgz
#   .\Install-WRA.ps1 -DryRun          # only report what would happen
#
# Defaults: install into %LOCALAPPDATA%\WRA, add that bin folder to the user PATH, keep the
# conversations in %USERPROFILE%\.cc-remote, start the server only if it is not already running.

[CmdletBinding()]
param(
  [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'WRA'),
  [string]$PackagePath = '',
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$NoPath,
  [switch]$NoAutostart,
  [switch]$NoStart,
  [switch]$NoOpen,
  [switch]$NoClaudeCheck
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stateDir = Join-Path $env:USERPROFILE '.cc-remote'
$failures = 0

function Say([string]$text) { Write-Host $text }
function Ok([string]$text) { Write-Host "  ok   $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "  warn $text" -ForegroundColor Yellow }
function Bad([string]$text) { Write-Host "  no   $text" -ForegroundColor Red }
function Ask([string]$question, [bool]$default = $true) {
  if ($Yes) { return $default }
  $suffix = if ($default) { '[Y/n]' } else { '[y/N]' }
  try {
    $answer = Read-Host "$question $suffix"
  } catch {
    # no console (a scheduled or scripted run): take the safe answer, never the aggressive one
    return $default
  }
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer -match '^(y|yes|s|si)$'
}

function Get-NodeInfo {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  try {
    $version = (& node -p "process.versions.node" 2>$null).Trim()
    $major = [int]($version.Split('.')[0])
    return [pscustomobject]@{ Path = $node.Source; Version = $version; Major = $major }
  } catch {
    return $null
  }
}

function Get-ClaudeInfo {
  $configured = $env:CR_CLAUDE_CMD
  if ($configured -and (Test-Path $configured)) {
    return [pscustomobject]@{ Path = $configured; Detail = 'from CR_CLAUDE_CMD' }
  }
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) { return $null }
  $detail = ''
  try {
    $detail = (& $claude.Source --version 2>$null | Select-Object -First 1)
  } catch {
    return [pscustomobject]@{ Path = $claude.Source; Detail = 'found, but --version failed' }
  }
  return [pscustomobject]@{ Path = $claude.Source; Detail = ($detail | Out-String).Trim() }
}

function Resolve-Package([string]$given) {
  if ($given) {
    if (-not (Test-Path $given)) { throw "package not found: $given" }
    return (Resolve-Path $given).Path
  }
  $here = Split-Path -Parent $PSCommandPath
  $candidates = @(
    (Join-Path $here 'dist'),
    $here,
    (Join-Path $here '..')
  ) | Where-Object { Test-Path $_ }
  foreach ($folder in $candidates) {
    $tgz = Get-ChildItem -Path $folder -Filter 'wra-*.tgz' -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($tgz) { return $tgz.FullName }
  }
  throw 'no wra-<version>.tgz found: pass -PackagePath, or build it with installer\build-package.ps1'
}

Say ''
Say 'WRA - Workspace Relay for Agents: installer'
Say '------------------------------------------'

# --- 1. This Windows ---------------------------------------------------------
$os = [Environment]::OSVersion.Version
$arch = $env:PROCESSOR_ARCHITECTURE
if ($os.Major -lt 10) {
  Bad "Windows 10 or later is required (found $($os.ToString()))"
  $failures++
} elseif ($os.Major -eq 10 -and $os.Build -lt 17763) {
  Warn "Windows build $($os.Build) is older than 1809; WRA is expected to work but is untested there"
} else {
  Ok "Windows $($os.Major).$($os.Minor) build $($os.Build), $arch"
}
if ($arch -notin @('AMD64', 'ARM64')) {
  Warn "architecture $arch is untested (Node.js must match it)"
}

# --- 2. Runtime --------------------------------------------------------------
$node = Get-NodeInfo
if (-not $node) {
  Bad 'Node.js not found on the PATH'
  Say '       Install Node.js 24 LTS (no administrator rights needed):'
  Say '         winget install OpenJS.NodeJS.LTS'
  Say '       or https://nodejs.org/en/download'
  $failures++
} elseif ($node.Major -lt 24) {
  Bad "Node.js $($node.Version) is too old (24 or newer required)"
  Say '       Update: winget upgrade OpenJS.NodeJS.LTS'
  $failures++
} else {
  Ok "Node.js $($node.Version) at $($node.Path)"
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
  Bad 'npm not found: it ships with Node.js, so the Node.js installation looks incomplete'
  $failures++
} else {
  Ok "npm at $($npm.Source)"
}

# --- 3. Agent ----------------------------------------------------------------
$claude = Get-ClaudeInfo
if (-not $claude) {
  if ($NoClaudeCheck) { Warn 'Claude Code not found (check skipped)' }
  else {
    Bad 'Claude Code not found on the PATH'
    Say '       Install it with:  npm install -g @anthropic-ai/claude-code'
    Say '       WRA does not install or update the agent for you.'
    $failures++
  }
} else {
  Ok "agent: $($claude.Path) ($($claude.Detail))"
}

# --- 4. What already exists --------------------------------------------------
$existing = $false
if (Test-Path (Join-Path $stateDir 'sessions.json')) {
  $existing = $true
  Ok "existing conversations found in ${stateDir}: they are kept as they are"
}
if (Test-Path $Prefix) {
  $existing = $true
  Say "  note an installation already exists in ${Prefix}: this is an update, not a fresh install"
}
$oldCommand = Get-Command rc -ErrorAction SilentlyContinue
if ($oldCommand -and -not $existing) {
  Say "  note an 'rc' command is on the PATH ($($oldCommand.Source)); WRA installs alongside it"
}

# --- 5. Package --------------------------------------------------------------
try {
  $package = Resolve-Package $PackagePath
  Ok "package: $package"
} catch {
  Bad $_.Exception.Message
  $failures++
  $package = $null
}

if ($failures -gt 0) {
  Say ''
  Bad "Installation not started: $failures prerequisite(s) missing."
  Say 'Fix the lines above and run the installer again.'
  exit 1
}

$binDir = Join-Path $Prefix 'node_modules\.bin'
$pathLine = if ($NoPath) { "add $binDir to the user PATH (skipped: -NoPath)" } else { "add $binDir to the user PATH" }
$startLine = if ($NoStart) { 'start the server (skipped: -NoStart)' } else { 'start the server if it is not already running' }
$autostartLine = if ($NoAutostart) { 'register WRA at logon (off: -NoAutostart)' } else { 'register WRA at logon only if you say yes' }
$openLine = if ($NoOpen) { 'open the dashboard in the browser (skipped: -NoOpen)' } else { 'open the dashboard in the browser' }
$plan = @(
  "install the package into $Prefix",
  $pathLine,
  "keep conversations and state in $stateDir",
  $startLine,
  $autostartLine,
  $openLine
)
Say ''
Say 'Plan:'
foreach ($line in $plan) { Say "  - $line" }
if ($DryRun) {
  Say ''
  Say 'Dry run: nothing was changed.'
  exit 0
}
if (-not (Ask 'Proceed?' $true)) {
  Say 'Nothing changed.'
  exit 0
}

# --- 6. Install --------------------------------------------------------------
Say ''
Say 'Installing...'
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
# No -g and no elevation: the package lands under this user's profile only.
& npm install --prefix $Prefix --no-audit --no-fund --no-save $package | Out-Host
if ($LASTEXITCODE -ne 0) {
  Bad "npm install failed with exit code $LASTEXITCODE"
  exit 1
}
$wraCmd = Join-Path $binDir 'wra.cmd'
if (-not (Test-Path $wraCmd)) {
  Bad "install finished but $wraCmd is missing"
  exit 1
}
Ok "installed: $wraCmd"

# --- 7. PATH ----------------------------------------------------------------
if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split ';' | Where-Object { $_ })
  if ($entries -notcontains $binDir) {
    $newPath = (@($entries) + $binDir) -join ';'
    if ($newPath.Length -gt 30000) {
      Warn 'the user PATH is already very long; add the folder by hand from Settings > Environment Variables'
      Warn "folder to add: $binDir"
    } else {
      [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
      Ok "PATH updated for new terminals: $binDir"
    }
  } else {
    Ok 'PATH already contains the WRA bin folder'
  }
  $env:Path = "$binDir;$env:Path"
}

# --- 8. State ---------------------------------------------------------------
if (-not (Test-Path $stateDir)) {
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  Ok "state folder created: $stateDir"
} else {
  Ok "state folder already there: $stateDir"
}
# The token is created by the server on first run; it never leaves this profile.

# --- 9. Server --------------------------------------------------------------
$port = 4310
$serverFile = Join-Path $stateDir 'server.json'
if (Test-Path $serverFile) {
  try {
    $saved = Get-Content $serverFile -Raw | ConvertFrom-Json
    if ($saved.port) { $port = [int]$saved.port }
  } catch { }
}

if (-not $NoStart) {
  Say ''
  Say 'Starting the server...'
  & $wraCmd start | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Warn 'the server did not report success; run `wra doctor` in a new terminal for the details'
  } else {
    Ok "server listening on http://127.0.0.1:$port"
  }
}

# --- 10. Autostart ----------------------------------------------------------
if (-not $NoAutostart) {
  Say ''
  if (Ask 'Start WRA automatically when you log in?' $false) {
    & $wraCmd autostart install | Out-Host
    if ($LASTEXITCODE -eq 0) { Ok 'autostart installed; remove it with: wra autostart remove' }
    else { Warn 'autostart was not installed; you can retry with: wra autostart install' }
  } else {
    Say '  autostart not installed (you can add it later: wra autostart install)'
  }
}

# --- 11. Open --------------------------------------------------------------
if (-not $NoOpen) {
  $url = "http://127.0.0.1:$port/welcome"
  try {
    Start-Process $url
    Ok "dashboard opened: $url"
  } catch {
    Say "open this address in the browser: $url"
  }
}

Say ''
Say 'Done.'
Say "  new terminal:  wra            open the workspace"
Say "                 wra new        a conversation in this folder"
Say "                 wra -c         resume the latest conversation here"
Say "                 wra doctor     if something does not work"
Say "  uninstall:     installer\Uninstall-WRA.ps1  (conversations are kept by default)"
