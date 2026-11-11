// Prova dal vivo (manuale): il processo dell'agente muore mentre lavora.
//
// Col `claude` vero: si apre una chat, si uccide il processo del `claude` (non il server), e si
// guarda cosa succede. Deve succedere questo: il turno finisce **subito** con un errore che lo
// dice, la conversazione resta nel registro, e la si può riaccendere.
//
// Perché è una prova a parte: l'exit del PTY su Windows passa da ConPTY, e una morte secca del
// figlio non è detto che arrivi come un evento pulito. Se non arrivasse, il turno resterebbe
// appeso fino alla scadenza lunga — e nessun test con la TUI finta lo mostrerebbe.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const home = process.env.USERPROFILE ?? os.homedir();
const root = fs.mkdtempSync(path.join(home, 'AppData', 'Local', 'Temp', 'cc-remote-crash-'));
const project = path.join(root, 'progetto');
fs.mkdirSync(project, { recursive: true });

const TOKEN = 'token-di-prova-lungo-abbastanza';
const PORT = Number(process.env.CR_CRASH_PORT ?? 4392);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? ' ok ' : 'NO  '} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
  env: {
    ...process.env,
    CR_TOKEN: TOKEN,
    CR_PORT: String(PORT),
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: project,
    CR_LOG_FILE: path.join(root, 'server.log'),
    CR_PERMISSION_MODE: 'default',
    CR_DEFAULT_WAIT_S: '60',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });

const api = async (route, { method = 'GET', body = null } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers: { 'x-cc-remote-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${route}: ${json?.error ?? response.status}`);
  return json;
};

/** Il `claude` è un figlio del server: si trova per parentela, non per nome. */
function childrenOf(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId`],
    { encoding: 'utf8' });
  return out.split('\n').map((line) => Number(line.trim())).filter(Boolean);
}

let sessionId = null;
try {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !/cc-remote su http:\/\//.test(log)) await sleep(100);
  check('server acceso', /cc-remote su http:\/\//.test(log), log.slice(0, 120));

  const created = (await api('/local/sessions', { method: 'POST', body: { projectPath: project, name: 'che muore' } })).session;
  sessionId = created.sessionId;
  const serverPid = child.pid;

  console.log('\n⏳ aspetto che l\'agente vero sia partito\n');
  const waitStart = Date.now();
  let claudePid = null;
  while (Date.now() - waitStart < 40_000 && !claudePid) {
    claudePid = childrenOf(serverPid).find((pid) => pid !== process.pid) ?? null;
    if (!claudePid) await sleep(500);
  }
  check('il processo dell\'agente c\'è', Boolean(claudePid), `pid ${claudePid} figlio di ${serverPid}`);
  await sleep(6_000); // lascialo disegnare, come nella realtà

  // --- 1. il processo muore MENTRE sta lavorando ---
  // È il caso in cui, senza il controllo sulla vita del processo, il turno resterebbe appeso
  // fino alla scadenza lunga (dieci minuti) aspettando una risposta che non arriverà mai.
  console.log('\n⏳ mando un turno, e dopo due secondi uccido l\'agente mentre ci sta lavorando\n');
  const inFlight = api('/local/talk', {
    method: 'POST',
    body: { sessionId, message: 'Conta da 1 a 300, un numero per riga, senza commenti.' },
  });
  inFlight.catch(() => {});
  await sleep(2_500);
  try {
    execFileSync('taskkill', ['/PID', String(claudePid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* già morto */ }

  const startedAt = Date.now();
  const turn = await inFlight;
  const elapsed = Date.now() - startedAt;
  check('il turno in corso lo scopre subito', elapsed < 60_000, `ci ha messo ${Math.round(elapsed / 1000)}s dall\'uccisione`);
  check('e finisce in errore, dicendo cos\'è successo', turn.turn.state === 'error' && /terminato/.test(String(turn.turn.error)),
    `stato: ${turn.turn.state} errore: ${String(turn.turn.error).slice(0, 90)}`);

  const afterDeath = (await api('/local/sessions')).sessions.find((session) => session.sessionId === sessionId);
  check('la chat resta nel registro', Boolean(afterDeath));
  check('e il suo stato diventa offline', afterDeath?.state === 'offline', `stato: ${afterDeath?.state}`);

  // --- 2. dopo il crash, la chat non è da buttare: torna su da sola ---
  console.log('\n⏳ la stessa chat, un turno nuovo: deve riaccendersi da sola\n');
  const revived = await api('/local/talk', { method: 'POST', body: { sessionId, message: 'Rispondi solo con: VIVO' } });
  check('riprende senza che nessuno la riaccenda a mano', revived.turn.state === 'done',
    `stato: ${revived.turn.state} errore: ${String(revived.turn.error).slice(0, 80)}`);
  check('ed è la stessa conversazione, non una nuova',
    (await api('/local/sessions')).sessions.filter((session) => session.projectPath === project).length === 1);

} catch (error) {
  check('giro di prova', false, error.message);
} finally {
  await api('/local/shutdown', { method: 'POST' }).catch(() => {});
  await sleep(1_500);
  if (child.exitCode === null) child.kill();
  for (const dir of [path.join(home, '.claude', 'projects', project.replace(/[^A-Za-z0-9]/g, '-'))]) {
    // solo il transcript di questa prova: creato adesso, in una cartella temporanea
    if (sessionId) fs.rmSync(path.join(dir, `${sessionId}.jsonl`), { force: true });
  }
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* il PTY lo tiene ancora */ }
}

console.log(`\n${failures === 0 ? 'CRASH LIVE PASS' : `CRASH LIVE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
