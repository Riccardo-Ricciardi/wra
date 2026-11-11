#!/usr/bin/env node
// Le finestre nere che lampeggiano: ci sono o no?
//
// Il difetto è che il server gira **staccato e senza console**, e su Windows un figlio a console
// lanciato da lì se ne fa allocare una nuova — cioè una finestra visibile. Si vede a occhio, e
// «a occhio» è il modo di non accorgersi se torna: chi l'ha visto una volta lo dà per risolto.
//
// Qui c'è un **controllo negativo**, ed è la ragione per cui questo attrezzo esiste: si guarda una
// finestra che *deve* comparire (la stessa chiamata senza `windowsHide`) e poi le stesse chiamate
// con `windowsHide`, e le operazioni vere del server. Senza il controllo negativo, «nessuna
// finestra» e «rivelatore rotto» sono la stessa riga di output.
//
//   node tools/popup-check.mjs            (solo Windows; altrove esce dicendo che non si applica)
//
// Non usa il registro vero e non avvia il server vero: il banco è `bench.mjs`, che si costruisce
// il proprio mondo in %TEMP% e se lo porta via.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBench } from './bench.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== 'win32') {
  console.log('popup-check: solo Windows — su questo sistema non ci sono console allocate a sorpresa.');
  process.exit(0);
}

/**
 * Il rivelatore: un giro di `EnumWindows` che tiene solo le finestre **visibili** la cui classe è
 * una console. Un processo a console può avere `MainWindowHandle` a zero anche quando la finestra
 * c'è, quindi su quello non ci si può appoggiare: si chiede alla finestra, non al processo.
 *
 * Gira in un processo suo per tutta la durata della prova: se si lanciasse un `powershell` a ogni
 * giro sarebbe il rivelatore stesso a creare finestre.
 */
const WATCHER = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$viste = @{}
$fine = (Get-Date).AddSeconds([int]$env:WATCH_SECONDS)
while ((Get-Date) -lt $fine) {
  $trovate = New-Object System.Collections.ArrayList
  $cb = [Win+EnumProc]{
    param($h, $l)
    if ([Win]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 256
      [void][Win]::GetClassName($h, $sb, 256)
      $cls = $sb.ToString()
      if ($cls -match 'ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS|PseudoConsoleWindow') {
        $pid2 = 0
        [void][Win]::GetWindowThreadProcessId($h, [ref]$pid2)
        [void]$trovate.Add("$cls|$pid2")
      }
    }
    return $true
  }
  [void][Win]::EnumWindows($cb, [IntPtr]::Zero)
  foreach ($t in $trovate) {
    if (-not $viste.ContainsKey($t)) {
      $viste[$t] = $true
      $nome = try { (Get-Process -Id ([int]($t -split '\|')[1]) -ErrorAction Stop).ProcessName } catch { '?' }
      Write-Output ("FINESTRA " + $t + "|" + $nome)
    }
  }
  Start-Sleep -Milliseconds 40
}
Write-Output 'FINE'
`;

const viste = [];
let watcher = null;

function avviaRivelatore(seconds) {
  watcher = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', WATCHER], {
    env: { ...process.env, WATCH_SECONDS: String(seconds) },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  watcher.stdout.setEncoding('utf8');
  let buffer = '';
  watcher.stdout.on('data', (chunk) => {
    buffer += chunk;
    const righe = buffer.split('\n');
    buffer = righe.pop() ?? '';
    for (const riga of righe) {
      const pulita = riga.trim();
      if (pulita.startsWith('FINESTRA ')) viste.push(pulita.slice('FINESTRA '.length));
    }
  });
}

/**
 * Un genitore **senza console**, come il server vero: staccato, senza stdio, con `windowsHide`.
 * Il figlio che scrive nel file è quello che fa la chiamata da provare.
 */
function genitoreSenzaConsole(script) {
  const file = path.join(os.tmpdir(), `cc-remote-popup-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, script);
  const child = spawn(process.execPath, [file], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { child, file };
}

const CHIAMATA = (extra) => `
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const out = ${JSON.stringify(path.join(os.tmpdir(), 'cc-remote-popup-out.json'))};
const esito = {};
try {
  const r = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output prova'], {
    encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], ${extra}
  });
  esito.ok = String(r).trim();
} catch (e) { esito.errore = String(e.message); }
// Un secondo processo, per dare al rivelatore il tempo di vedere una finestra che vive poco.
try { execFileSync('where', ['node'], { stdio: 'ignore', ${extra} }); } catch {}
fs.writeFileSync(out, JSON.stringify(esito));
`;

const letti = () => {
  const file = path.join(os.tmpdir(), 'cc-remote-popup-out.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const esiti = [];

async function scenario(nome, script, attendiMs) {
  const prima = viste.length;
  const out = path.join(os.tmpdir(), 'cc-remote-popup-out.json');
  fs.rmSync(out, { force: true });
  const { child, file } = genitoreSenzaConsole(script);
  const scaduto = Date.now() + attendiMs;
  while (Date.now() < scaduto && !letti()) await sleep(100);
  await sleep(700); // il tempo perché una finestra comparsa e sparita venga vista
  const nuove = viste.slice(prima);
  esiti.push({ nome, nuove, esito: letti(), vivo: child.exitCode === null });
  fs.rmSync(file, { force: true });
  fs.rmSync(out, { force: true });
  return nuove;
}

// ── 1. Il controllo negativo: la stessa chiamata **senza** `windowsHide` deve far vedere una
//      finestra. Se non la vediamo, il rivelatore non funziona e il resto della prova non dice
//      niente — ed è meglio saperlo qui che concludere «tutto a posto».
avviaRivelatore(75);
await sleep(1_200);

const conFinestra = await scenario('finestra attesa · senza windowsHide', CHIAMATA(''), 25_000);
console.log(`controllo negativo (senza windowsHide): ${conFinestra.length ? `vista — ${conFinestra.join(', ')}` : 'NESSUNA FINESTRA VISTA'}`);

const senzaFinestra = await scenario('le stesse chiamate · con windowsHide', CHIAMATA('windowsHide: true,'), 25_000);
console.log(`stesse chiamate (con windowsHide): ${senzaFinestra.length ? `vista — ${senzaFinestra.join(', ')}` : 'nessuna finestra'}`);

// ── 2. Il lanciatore dell'avvio automatico, con la forma esatta che scrive `rc autostart`:
//      collegamento → `wscript.exe` → `.vbs` con finestra 0 → `node`. È l'unico altro posto dove
//      una console può comparire da sola, ed è quello che si vede a ogni accesso.
{
  const { launcherScript } = await import('../src/core/autostart.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-launcher-'));
  const marcatore = path.join(dir, 'fatto.txt');
  fs.writeFileSync(path.join(dir, 'lavoro.mjs'), `import fs from 'node:fs';\nfs.writeFileSync(process.env.POPUP_MARK, 'fatto');\n`);
  const vbs = path.join(dir, 'lanciatore.vbs');
  fs.writeFileSync(vbs, launcherScript({
    exe: process.execPath,
    args: [path.join(dir, 'lavoro.mjs')],
    cwd: dir,
    what: 'la prova del lanciatore',
  }), 'utf8');

  const prima = viste.length;
  // Da un genitore **senza console**, che è la condizione in cui si trova il lanciatore quando lo
  // esegue il sistema all'accesso.
  const { child } = genitoreSenzaConsole(`
import { spawn } from 'node:child_process';
const p = spawn('wscript.exe', ['//nologo', ${JSON.stringify(vbs)}], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, POPUP_MARK: ${JSON.stringify(marcatore)} } });
p.unref();
`);
  const scaduto = Date.now() + 15_000;
  while (Date.now() < scaduto && !fs.existsSync(marcatore)) await sleep(150);
  await sleep(800);
  const nuove = viste.slice(prima);
  const partito = fs.existsSync(marcatore);
  esiti.push({ nome: 'lanciatore dell\'avvio automatico', nuove });
  console.log(`lanciatore dell'avvio automatico (wscript → vbs → node): ${partito ? 'partito' : 'NON PARTITO'} · ${nuove.length ? `FINESTRE — ${nuove.join(', ')}` : 'nessuna finestra'}`);
  child.unref();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 3. Le operazioni **vere** del server: quelle che partono aprendo Amministrazione, più una
//      conversazione accesa e spenta (che è l'unico posto dove nasce una console per davvero,
//      quella del PTY dell'agente).
const bench = await startBench({ name: 'popup' });
const token = bench.token;
const chiama = (rotta, opzioni = {}) => fetch(`${bench.base}${rotta}`, {
  ...opzioni,
  headers: { 'x-cc-remote-token': token, 'content-type': 'application/json', ...(opzioni.headers ?? {}) },
});

try {
  const prima = viste.length;
  const registro = await (await chiama('/local/sessions')).json();
  const primaConversazione = registro.sessions.find((s) => !s.archived) ?? registro.sessions[0];

  await chiama('/local/admin/status');
  await chiama('/local/admin/processes');
  await chiama('/local/admin/check', { method: 'POST', body: JSON.stringify({ lines: 40 }) });
  await chiama('/local/session/start', { method: 'POST', body: JSON.stringify({ sessionId: primaConversazione.sessionId }) });
  await sleep(2_500);
  await chiama('/local/session/stop', { method: 'POST', body: JSON.stringify({ sessionId: primaConversazione.sessionId }) });
  await sleep(1_000);

  const delServer = viste.slice(prima);
  esiti.push({ nome: 'operazioni del server', nuove: delServer });
  console.log(`operazioni del server (status, processi, check, avvio e spegnimento di una chat): ${delServer.length ? `FINESTRE — ${delServer.join(', ')}` : 'nessuna finestra'}`);
} finally {
  await bench.stop();
}

watcher?.kill();
await sleep(300);

const negative = esiti[0]?.nuove ?? [];
const positive = esiti.slice(1).flatMap((e) => e.nuove);

console.log('');
if (!negative.length) {
  console.log('RIVELATORE NON AFFIDABILE: non ha visto la finestra del controllo negativo.');
  console.log('Le righe qui sopra non dicono niente sul prodotto: vanno rifatte.');
  process.exitCode = 2;
} else if (positive.length) {
  console.log(`FINESTRE INDESIDERATE: ${positive.join(', ')} — vedi gli scenari qui sopra.`);
  process.exitCode = 1;
} else {
  console.log('Nessuna finestra indesiderata: il controllo negativo è stato visto, le altre no.');
}
