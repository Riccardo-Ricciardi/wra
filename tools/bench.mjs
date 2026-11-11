// Il banco si costruisce il proprio mondo: una cartella usa e getta, un registro appena seminato,
// un server su una porta effimera, e una spegnimento che porta via tutto.
//
// Sta qui perché il difetto che questo file chiude era **dei banchi**, non del programma:
// `ui-check.mjs` puntava a un server acceso a mano, su un registro che il giro precedente aveva
// già archiviato, fissato e rinominato. Due giri di fila davano due numeri diversi — e il secondo
// fallimento non c'entrava niente con il codice. Un banco che dipende da cosa ha lasciato in giro
// il giro prima non è un banco: è una cronaca.
//
// Le tre regole, e ognuna risponde a un difetto visto davvero:
//   1. **niente `~/.cc-remote`.** Il registro è nella cartella di prova, e tutto quello che gli sta
//      accanto (progetti, giornale, accesso, impostazioni, lucchetto, `server.json`) lo segue —
//      l'ha imparato a sue spese `projects.json`, che si era riempito di 64 voci di prova.
//   2. **dati identici a ogni giro**, seminati *adesso*: si ri-semina a ogni esecuzione, non si
//      riusa quello di prima.
//   3. **niente processi orfani.** Si spegne dalla rotta di spegnimento del server (che chiude i
//      PTY), non con un `kill` che su Windows non consegna nessun segnale; e se non basta,
//      si abbatte l'albero.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Un token fisso e lungo abbastanza: senza `CR_TOKEN` il server se ne genera uno e lo **scrive in
// `~/.cc-remote/token`**, che è esattamente la cosa che questo file esiste per non fare.
const TOKEN = 'bench-token-0123456789abcdef';

// I mondi di prova aperti adesso: il processo del server e la sua cartella. Servono all'ultima
// rete, che è l'unico posto dove si può ancora fare qualcosa se il banco muore male.
const vivi = new Set();

/** L'ultima rete: se il processo del banco muore male, i server di prova non restano. */
function abbatti(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch {
    // già morto
  }
}

/**
 * L'ultima rete, e vale per tutte e due le cose: il processo di prova **e** la sua cartella.
 *
 * La cartella l'ha aggiunta un caso vero: un mio errore in `ui-perf.mjs` ha fatto uscire il banco
 * con un'eccezione prima del suo `stop()`, e in `%TEMP%` è rimasto un mondo intero. Un `kill` sui
 * figli non basta — un banco che muore male deve lasciare la macchina come l'ha trovata.
 */
function pulisci() {
  for (const { child, root } of vivi) {
    abbatti(child);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // un `conhost` che tiene un handle: lo porta via il sistema
    }
  }
}

process.on('exit', pulisci);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { pulisci(); process.exit(130); });
}

/**
 * Semina, accende, aspetta. Restituisce l'indirizzo e il token, e un `stop()` che porta via
 * **tutto**: il server, i suoi processi figli, e la cartella.
 *
 * L'attesa è sull'evento vero — la riga che il server stampa quando è in ascolto — non su un
 * tempo scelto a occhio: `sleep(2500)` è troppo corto sulla macchina lenta e uno spreco su quella
 * veloce, e sbaglia in tutti e due i casi.
 *
 * @param {object} [input]
 * @param {number} [input.sessions]  quante conversazioni seminare
 * @param {number} [input.projects]  quante cartelle
 * @param {string} [input.name]      come si chiama, nei messaggi
 */
export async function startBench({ sessions = 520, projects = 24, name = 'banco', publicHost = null } = {}) {
  // Sempre una cartella **nuova**, e sempre sotto la cartella temporanea del sistema: il mondo di
  // prova si cancella alla fine, e un percorso che arriva da fuori — da un `--dir`, da un chiamante
  // distratto — non deve poter diventare «cancella quello che c'è qui». Nessun chiamante ha bisogno
  // di sceglierla: chi vuole rivedere i dati di un giro non cancella, guarda.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-bench-'));
  const seed = spawnSync(process.execPath, [
    path.join(repo, 'tools', 'seed-demo.mjs'), '--dir', root,
    '--sessions', String(sessions), '--projects', String(projects),
  ], { encoding: 'utf8' });
  if (seed.status !== 0) {
    throw new Error(`il seme non è riuscito: ${seed.stderr || seed.stdout || `uscita ${seed.status}`}`);
  }

  // Si eredita l'ambiente — serve per `PATH`, `TEMP`, `SystemRoot` — ma **niente `CR_*`**: la shell
  // di chi lancia questo banco è la shell di chi usa cc-remote, e ci sono davvero dentro
  // `CR_PUBLIC_ORIGIN`, `CR_ISSUER_URL`, `CR_CLAUDE_CMD` e altri. Una di quelle che non conosciamo —
  // il giornale dei turni, il relay delle approvazioni — riporterebbe la prova a scrivere fuori
  // dalla sua cartella, o a parlare con un server vero. (Trovato da una revisione del diff: le
  // variabili pinnate erano tutte quelle note, e la regola dev'essere «tutte», non «quelle note».)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CR_')));
  Object.assign(env, {
    CR_TOKEN: TOKEN,
    // Porta 0: la sceglie il sistema. Due banchi insieme (interfaccia e pannello) non si pestano,
    // e non si scontra con il server vero su 4310.
    CR_PORT: '0',
    CR_HOST: '127.0.0.1',
    // Il registro **e tutto quello che gli sta accanto** (projects.json, turns.json, access.json,
    // settings.json, serve.lock, server.json) seguono questa riga.
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_PROJECTS_FILE: path.join(root, 'projects.json'),
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: root,
    CR_LOG_FILE: path.join(root, 'cc-remote.log'),
    CR_ACCESS_FILE: path.join(root, 'access.json'),
    CR_SETTINGS_FILE: path.join(root, 'settings.json'),
    // La TUI finta: un banco che lancia il `claude` vero apre agenti veri in cartelle usa e getta,
    // costa chiamate vere e introduce attese che dipendono dall'agente.
    CR_CLAUDE_CMD: process.execPath,
    CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
    // Nessuna configurazione pubblica: un banco non deve poter credere di essere raggiungibile.
    // Chi vuole provare la strada pubblica lo dice (`publicHost`): allora il banco finge di
    // **essere** quell'hostname, e il guard dell'host si può provare senza un tunnel vero.
    CR_PUBLIC_ORIGIN: publicHost ? `https://${publicHost}` : '',
    CR_ISSUER_URL: publicHost ? `https://${publicHost}` : '',
    CR_RESOURCE_URL: publicHost ? `https://${publicHost}/mcp` : '',
    CR_MCP_HOST: publicHost ?? '',
  });

  const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const mondo = { child, root };
  vivi.add(mondo);

  let uscita = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { uscita += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { uscita += chunk; });

  let port = null;
  const scaduto = Date.now() + 30_000;
  while (Date.now() < scaduto && !port) {
    if (child.exitCode !== null) {
      vivi.delete(mondo);
      throw new Error(`il server di prova è uscito con ${child.exitCode}:\n${uscita.trim() || '(nessuna riga)'}`);
    }
    const match = uscita.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) port = Number(match[1]);
    else await sleep(100);
  }
  if (!port) {
    abbatti(child);
    vivi.delete(mondo);
    throw new Error(`il server di prova non si è acceso in 30s:\n${uscita.trim() || '(nessuna riga)'}`);
  }

  const base = `http://127.0.0.1:${port}`;
  // La riga di ascolto c'è, ma la prima richiesta è la prova che la pagina si aprirà: un server
  // che ascolta e non risponde è un guasto, e va detto qui e non al primo controllo.
  const salute = await fetch(`${base}/healthz`, { headers: { 'x-cc-remote-token': TOKEN } }).catch(() => null);
  if (!salute?.ok) {
    abbatti(child);
    vivi.delete(mondo);
    throw new Error(`il server di prova risponde ${salute?.status ?? 'mai'}: ${uscita.trim()}`);
  }

  let fermato = false;
  async function stop() {
    if (fermato) return;
    fermato = true;
    // La via ordinata: questa rotta chiude i PTY e i processi figli. Un `kill` su Windows non
    // consegna `SIGTERM` — termina e basta — e le TUI finte resterebbero appese al nulla.
    await fetch(`${base}/local/shutdown`, {
      method: 'POST', headers: { 'x-cc-remote-token': TOKEN }, signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
    const fine = Date.now() + 5_000;
    while (Date.now() < fine && child.exitCode === null) await sleep(100);
    abbatti(child);
    vivi.delete(mondo);
    // La cartella: se un `conhost` sopravvive al padre e tiene un handle, si riprova invece di
    // lasciare in `%TEMP%` una cartella per ogni giro.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  }

  console.log(`${name}: registro di prova in ${root} (${sessions} conversazioni), server su ${base}`);
  return { base, token: TOKEN, port, stop, log: () => uscita };
}
