# Apre una finestra PowerShell collegata a una chat di questa cartella, dentro cc-remote.
# E' il «collegati» che serve da dentro Claude Code, dove la finestra corrente non si puo'
# rendere live: questa ne apre *una nuova*, che nasce gia' agganciata.
#
#   cc-window.ps1                 aggancia la chat di questa cartella (la crea se non c'e')
#   cc-window.ps1 -New            una chat nuova in questa cartella
#   cc-window.ps1 -Directory X    un'altra cartella
#   cc-window.ps1 -Continue       come senza argomenti (la piu' recente di questa cartella)
#
# Il server non deve essere gia' acceso: `rc attach` lo accende se serve, e se e' gia' acceso
# usa quello. Un server solo, sempre.
param(
    [string]$Directory = (Get-Location).Path,
    [switch]$New,
    [switch]$Continue
)

$ErrorActionPreference = 'Stop'
$rc = "$HOME\.local\bin\rc.cmd"
$quoted = $Directory -replace "'", "''"
$mode = if ($New) { ' --new' } else { '' }

$inner = "Set-Location -LiteralPath '$quoted'; & `"$rc`" attach$mode"

Start-Process pwsh -ArgumentList '-NoProfile', '-NoExit', '-Command', $inner
Write-Output "finestra collegata a $Directory - live su sito e telefono (Ctrl+Q per staccarti)"
