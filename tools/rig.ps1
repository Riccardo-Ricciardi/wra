# Lo stato dell'impianto, e i tre comandi che servono: start, stop, web.
# E' quello che usa `/rig` da dentro Claude Code, dove serve una risposta in una riga.
#
#   rig.ps1            stato: server acceso o spento, chat, indirizzo
#   rig.ps1 start      accende il server (un server solo: se c'e' gia', non ne fa un secondo)
#   rig.ps1 stop       spegne tutto (le chat restano nel registro)
#   rig.ps1 web        apre l'interfaccia nel browser
#   rig.ps1 doctor     diagnostica per esteso
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'src\cli\index.mjs'
$what = if ($Rest -and $Rest.Count -gt 0) { $Rest[0] } else { 'stato' }

function Show-Stato {
    # `rc status` parla col server: se e' spento lo dice lui, e va detto bene.
    $out = & node $cli status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Output "cc-remote: spento. Accendilo con `"rig.ps1 start`" (o con `cc`)."
        return
    }
    $out
    $port = if ($env:CR_PORT) { $env:CR_PORT } else { '4310' }
    Write-Output "interfaccia: http://127.0.0.1:$port  (`"rig.ps1 web`" per aprirla)"
}

switch ($what) {
    'stato' { Show-Stato }
    'start' { & node $cli start }
    'stop' { & node $cli stop }
    'web' { & node $cli web }
    'doctor' { & node $cli doctor }
    default {
        Write-Output "rig.ps1: non conosco `"$what`". Usa: (vuoto) | start | stop | web | doctor"
        exit 1
    }
}
