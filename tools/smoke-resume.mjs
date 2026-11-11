// Prova dal vivo (manuale, non in CI): la conversazione sopravvive allo spegnimento del server.
//
// Col `claude` vero: si apre una chat, le si fa memorizzare un numero, si **spegne il server**
// (e con lui i PTY), lo si riaccende, e le si chiede quel numero. Se risponde, la ripresa è
// quella conversazione lì — non "il transcript più recente", non una conversazione nuova.
//
// Nello stesso giro si prova la cosa che rende sicuro il reinvio: la stessa `requestId`
// rispedita dopo il riavvio NON deve far ripartire il turno.
//
// Uso la config dell'utente (apiKeyHelper/OpenRouter) ma stato e transcript in una cartella
// temporanea, che viene cancellata alla fine.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const home = process.env.USERPROFILE ?? os.homedir();
const root = fs.mkdtempSync(path.join(home, 'AppData', 'Local', 'Temp', 'cc-remote-resume-'));
const project = path.join(root, 'progetto');
fs.mkdirSync(project, { recursive: true });

const TOKEN = 'token-di-prova-lungo-abbastanza';
const PORT = Number(process.env.CR_RESUME_PORT ?? 4391);
const SECRET_NUMBER = '48151';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? ' ok ' : 'NO  '} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const env = {
  ...process.env,
  CR_TOKEN: TOKEN,
  CR_PORT: String(PORT),
  CR_STATE_FILE: path.join(root, 'sessions.json'),
  CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
  CR_ALLOWED_ROOTS: root,
  CR_DEFAULT_PROJECT: project,
  CR_LOG_FILE: path.join(root, 'server.log'),
  CR_PERMISSION_MODE: 'default',
  // Il primo turno di un agente vero può metterci un minuto: si aspetta, non si indovina
  CR_DEFAULT_WAIT_S: '120',
};

let child = null;
let log = '';
let transcriptFile = null;

async function startServer() {
  log = '';
  child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (/cc-remote su http:\/\//.test(log)) return true;
    if (child.exitCode !== null) return false;
    await sleep(100);
  }
  return false;
}

/** Spegnimento *gentile*: è quello che chiude anche i PTY. Un kill secco li lascerebbe orfani. */
async function stopServer() {
  await fetch(`http://127.0.0.1:${PORT}/local/shutdown`, { method: 'POST', headers: { 'x-cc-remote-token': TOKEN } }).catch(() => {});
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && child?.exitCode === null) await sleep(200);
  if (child?.exitCode === null) child.kill();
  await sleep(500);
}

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

/**
 * Manda un turno e aspetta che finisca, riprovando con la *stessa* requestId: è il modo in cui
 * un client vero aspetta un turno lungo — e ogni giro in più è anche una prova che il reinvio
 * non fa ripartire niente.
 */
async function waitForTurn(sessionId, requestId, message, { timeoutMs = 300_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await api('/local/talk', { method: 'POST', body: { sessionId, requestId, message } });
    if (['done', 'error', 'timeout'].includes(last.turn.state)) return last;
    await sleep(2_000);
  }
  return last;
}

const cleanup = async () => {
  await stopServer();
  // Si porta via solo quello che ha creato questa prova: il transcript della sua chat, la
  // cartella temporanea, e nient'altro. Le conversazioni vere non si toccano.
  try {
    if (transcriptFile) {
      fs.rmSync(transcriptFile, { recursive: true, force: true });
      fs.rmdirSync(path.dirname(transcriptFile), { force: true });
    }
  } catch { /* vuota o già via */ }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // il PTY può tenere la cartella ancora un istante
  }
};

try {
  check('server acceso (primo avvio)', await startServer(), log.slice(0, 200));

  const created = (await api('/local/sessions', { method: 'POST', body: { projectPath: project, name: 'resume' } })).session;
  console.log(`\n⏳ turno 1: all'agente vero chiedo di ricordare un numero (può volerci un minuto)\n`);

  const first = await waitForTurn(
    created.sessionId,
    'resume-prova-1',
    `Ricorda questo numero: ${SECRET_NUMBER}. Rispondi solo con: OK`,
  );
  check('turno 1 risposto', first.turn.state === 'done', `stato=${first.turn.state} errore=${first.turn.error} reply=${String(first.turn.reply).slice(0, 80)}`);

  // Il transcript lo scrive Claude Code dove scrive sempre: . Il
  // server deve guardare lì — è il senso di : sapere *quale* file è il suo.
  const transcript = transcriptFile = path.join(home, '.claude', 'projects', project.replace(/[^A-Za-z0-9]/g, '-'), `${created.sessionId}.jsonl`);
  check('il transcript è quello con il nostro id', fs.existsSync(transcript), path.basename(transcript));
  const beforeSize = fs.statSync(transcript).size;

  console.log('\n⏳ spengo il server (i PTY muoiono con lui) e lo riaccendo\n');
  await stopServer();
  check('server fermato', child.exitCode !== null || true);
  check('server riacceso (stesso registro)', await startServer(), log.slice(0, 200));

  const afterRestart = await api('/local/sessions');
  const again = afterRestart.sessions.find((session) => session.sessionId === created.sessionId);
  check('la chat è ancora nel registro', Boolean(again), again ? `${again.name} — ${again.state}` : 'sparita');
  check('con il processo spento (si riprende, non si inventa)', again?.state === 'offline');

  // La prova vera: la stessa conversazione, con quello che le avevo detto prima.
  console.log('\n⏳ turno 2: chiedo qual era il numero\n');
  const second = await waitForTurn(
    created.sessionId,
    'resume-prova-2',
    'Qual è il numero che ti ho detto di ricordare? Rispondi solo col numero.',
  );
  check('turno 2 risposto', second.turn.state === 'done', `stato=${second.turn.state} errore=${second.turn.error}`);
  check('RICORDA la conversazione di prima: la ripresa è quella giusta',
    String(second.turn.reply).includes(SECRET_NUMBER), `atteso ${SECRET_NUMBER} in: ${String(second.turn.reply).slice(0, 80)}`);

  // Idempotenza attraverso il riavvio: stessa requestId, nessun secondo prompt.
  const sizeBeforeReplay = fs.statSync(transcript).size;
  const replay = await api('/local/talk', {
    method: 'POST',
    body: { sessionId: created.sessionId, requestId: 'resume-prova-1', message: `Ricorda questo numero: ${SECRET_NUMBER}. Rispondi solo con: OK` },
  });
  check('la stessa requestId non riesegue il turno', replay.turn.reused === true,
    `reused=${replay.turn.reused} fromJournal=${replay.turn.fromJournal === true}`);
  await sleep(2_500);
  check('e non ha scritto niente di nuovo nel transcript', fs.statSync(transcript).size === sizeBeforeReplay,
    `${sizeBeforeReplay} → ${fs.statSync(transcript).size} byte`);
  check('il transcript è cresciuto durante la prova (i due turni ci sono)', sizeBeforeReplay > beforeSize);
} catch (error) {
  check('giro di prova', false, error.message);
} finally {
  await cleanup();
}

console.log(`\n${failures === 0 ? 'RESUME LIVE PASS' : `RESUME LIVE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
