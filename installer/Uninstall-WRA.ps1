# WRA uninstaller. Removes the program and the PATH entry. Conversations, OAuth clients, backups
# and settings in %USERPROFILE%\.cc-remote are KEPT unless you pass -PurgeState and confirm by
# typing DELETE. That folder is the only copy of the registry, so removing it is irreversible.

[CmdletBinding()]
param(
  [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'WRA'),
  [switch]$Yes,
  [switch]$PurgeState,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:USERPROFILE '.cc-remote'
$binDir = Join-Path $Prefix 'node_modules\.bin'
$wraCmd = Join-Path $binDir 'wra.cmd'

function Say([string]$text) { Write-Host $text }
function Ok([string]$text) { Write-Host "  ok   $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "  warn $text" -ForegroundColor Yellow }
function Ask([string]$question, [bool]$default = $true) {
  if ($Yes) { return $default }
  try { $answer = Read-Host "$question $(if ($default) { '[Y/n]' } else { '[y/N]' })" }
  catch { return $default }
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer -match '^(y|yes|s|si)$'
}

Say ''
Say 'WRA - uninstall'
Say '---------------'

if (-not (Test-Path $Prefix)) {
  Warn "no installation found in $Prefix"
} else {
  Say "  program: $Prefix"
}
Say "  kept:    $stateDir (conversations, backups, settings)"

if ($DryRun) {
  Say ''
  Say 'Dry run: nothing was changed.'
  exit 0
}

# Stop the server and remove the logon entry before deleting the program that knows how.
if (Test-Path $wraCmd) {
  try { & $wraCmd stop | Out-Null } catch { Warn 'the server did not stop cleanly' }
  try { & $wraCmd autostart remove | Out-Null } catch { Warn 'autostart entry not removed (it may not exist)' }
}

# PATH: remove only our exact entry, never rewrite the rest.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $entries = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $binDir })
  if ($entries.Count -ne ($userPath -split ';' | Where-Object { $_ }).Count) {
    [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
    Ok "removed $binDir from the user PATH"
  }
}

if ((Test-Path $Prefix) -and (Ask "Remove the program folder $Prefix?" $true)) {
  Remove-Item -Recurse -Force $Prefix
  Ok 'program folder removed'
}

$purge = $PurgeState
if (-not $purge -and -not $Yes) {
  $purge = Ask 'Also delete ALL conversations and state in .cc-remote? This cannot be undone' $false
}
if ($purge) {
  $confirmation = if ($Yes) { 'DELETE' } else { Read-Host 'Type DELETE to confirm' }
  if ($confirmation -eq 'DELETE') {
    Remove-Item -Recurse -Force $stateDir
    Ok 'state folder deleted'
  } else {
    Say '  state folder kept'
  }
} else {
  Ok "state kept in $stateDir"
}

Say ''
Say 'Uninstalled. To install again, run installer\Install-WRA.ps1.'
