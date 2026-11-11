# Finestra Claude con l'account claude.ai, per usare /remote-control.
#
# Il Remote Control ufficiale (comando `/remote-control`, alias `/rc`) e' l'unico modo per
# rendere una sessione gia' aperta visibile dal telefono senza un secondo processo. Richiede
# pero' due cose che il setup normale di questa macchina non ha: niente apiKeyHelper e niente
# ANTHROPIC_BASE_URL fuori da api.anthropic.com. Questa finestra le toglie *solo per se
# stessa* — il resto delle sessioni continua con OpenRouter/DeepSeek.
#
# La prima volta serve `/login` con l'account claude.ai (Pro/Max). Da li' in poi:
#   claude-cloud          apre la finestra e attiva il Remote Control
#   /remote-control       (o /rc) dentro la sessione: mostra URL + QR per il telefono
param([string]$Directory = (Get-Location).Path)

$ErrorActionPreference = 'Stop'
$quoted = $Directory -replace "'", "''"

$clear = "foreach (`$v in 'ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_CUSTOM_HEADERS','ANTHROPIC_BEDROCK_BASE_URL','ANTHROPIC_AWS_BASE_URL') { Remove-Item `"Env:`$v`" -ErrorAction SilentlyContinue }"
$start = "claude --setting-sources local --remote-control"

$inner = "Set-Location -LiteralPath '$quoted'; $clear; $start"

Start-Process pwsh -ArgumentList '-NoProfile', '-NoExit', '-Command', $inner
Write-Output "finestra claude.ai aperta su $Directory - dentro: /remote-control (alias /rc) per il telefono"