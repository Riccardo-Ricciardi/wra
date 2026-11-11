// Prova dal vivo (manuale, non in CI) del relay delle approvazioni, col `claude` vero:
// un turno che ha bisogno di un permesso, la richiesta che arriva al browser, la decisione che
// torna indietro, il comando che parte. E, per ultimo, il caso che conta: se nessuno risponde,
// non si concede niente.
//
// Va rilanciata a ogni aggiornamento di Claude Code, insieme a `rc doctor`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const repo = path.resolve(import.meta.dirname, '..');
const home = process.env.USERPROFILE ?? os.homedir();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-approve-'));
const TOKEN = 'token-di-prova-lungo-abbastanza';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Un comando che *sicuramente* chiede il permesso: `echo` lo lascerebbe passare la lista dei
// comandi innocui, e il test passerebbe senza aver provato niente.
const COMMAND = 'curl -sS https://example.com';
// Corto apposta: la prova include il caso «nessuno risponde», e aspettare due minuti veri
// renderebbe la prova una cosa che non si lancia più.
const TTL_S = Number(process.env.CR_APPROVAL_TTL_S ?? 15);
const TTL_MS = TTL_S * 1000;

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? ' ok ' : 'NO  '} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
  env: {
    ...process.env,
    CR_TOKEN: TOKEN,
    CR_PORT: '0',
    CR_ALLOWED_ROOTS: home,
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_DEFAULT_PROJECT: home,
    CR_PERMISSION_MODE: 'default',
    CR_APPROVAL_TTL_S: String(TTL_S),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });

const api = async (route, { method = 'GET', body = null } = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'x-cc-remote-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${route}: ${json?.error ?? response.status}`);
  return json;
};

let port = null;
const deadline = Date.now() + 25_000;
while (Date.now() < deadline && !port) {
  const match = log.match(/cc-remote su http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) port = Number(match[1]);
  else await sleep(100);
}

const created = [];
const cleanup = () => {
  for (const session of created) {
    const dir = path.join(home, '.claude', 'projects', session.projectPath.replace(/[^A-Za-z0-9]/g, '-'));
    for (const target of [path.join(dir, `${session.sessionId}.jsonl`), path.join(dir, session.sessionId)]) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* non c'era */ }
    }
  }
  child.kill();
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* il PTY tiene la cartella */ }
};

/** Un client come il browser: si aggancia a una chat e aspetta i messaggi. */
function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`bearer.${TOKEN}`]);
  const seen = [];
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  const ready = new Promise((resolve) => ws.on('open', resolve));
  return {
    ready,
    seen,
    send: (message) => ws.send(JSON.stringify(message)),
    until: async (predicate, { timeoutMs = 180_000, what = 'condizione' } = {}) => {
      const stop = Date.now() + timeoutMs;
      while (Date.now() < stop) {
        const found = seen.find(predicate);
        if (found) return found;
        await sleep(200);
      }
      throw new Error(`tempo scaduto aspettando ${what}`);
    },
    close: () => ws.close(),
  };
}

if (!port) {
  console.log('server non partito:', log);
  process.exit(1);
}

try {
  const session = (await api('/local/sessions', { method: 'POST', body: { projectPath: home, name: 'approve-live' } })).session;
  created.push(session);

  const browser = connect();
  await browser.ready;
  browser.send({ t: 'hello', proto: 2, role: 'chat', sessionId: session.sessionId, cols: 120, rows: 40 });

  console.log(`\n⏳ l'agente vero sta partendo; poi chiederà il permesso per: ${COMMAND}\n`);
  const turn = api('/local/talk', {
    method: 'POST',
    body: { sessionId: session.sessionId, message: `Esegui esattamente questo comando shell, senza alternative: ${COMMAND}` },
  });

  // 1. la richiesta arriva al client, con dentro la cosa su cui si sta decidendo
  const asked = await browser.until((m) => m.t === 'approval', { what: 'la richiesta di permesso' });
  check('la richiesta di permesso arriva al browser', true, `${asked.approval.toolName}: ${JSON.stringify(asked.approval.input).slice(0, 70)}`);
  check("la richiesta dice qual è il comando, non solo che c'è",
    JSON.stringify(asked.approval.input).includes(COMMAND));
  check("nell'elenco (quello che interroga il telefono) la richiesta si vede",
    (await api('/local/approvals')).approvals.some((entry) => entry.id === asked.approval.id));

  // 2. la persona decide: il turno deve riprendere e il comando deve partire davvero
  browser.send({ t: 'approve', id: asked.approval.id, behavior: 'allow' });
  const gone = await browser.until((m) => m.t === 'approval_gone' && m.id === asked.approval.id, { what: 'la richiesta tolta di mezzo' });
  check('la decisione chiude la richiesta', gone.reason === 'decided', gone.reason);

  const finished = await turn;
  check('il turno arriva alla fine: il permesso è stato concesso davvero',
    finished.turn.state === 'done', `${finished.turn.state} — ${String(finished.turn.reply).slice(0, 80)}`);
  check('e il comando ha girato: la risposta contiene quello che ha stampato',
    /Example Domain|example\.com/i.test(String(finished.turn.reply)), String(finished.turn.reply).slice(0, 90));

  // 3. il caso che conta davvero: nessuno risponde. La richiesta deve scadere e il comando
  //    NON deve girare — l'unico esito inaccettabile sarebbe un permesso concesso da solo.
  const second = (await api('/local/sessions', { method: 'POST', body: { projectPath: home, name: 'approve-senza-risposta' } })).session;
  created.push(second);
  const quiet = api('/local/talk', {
    method: 'POST',
    body: { sessionId: second.sessionId, message: `Esegui esattamente questo comando shell, senza alternative: ${COMMAND}` },
  });
  quiet.catch(() => {});

  // Un secondo client agganciato alla seconda chat: è il telefono che guarda *quella*
  // conversazione, e la richiesta deve arrivargli da sola (non solo nell'elenco).
  const phone = connect();
  await phone.ready;
  phone.send({ t: 'hello', proto: 2, role: 'chat', sessionId: second.sessionId, cols: 120, rows: 40 });
  const secondAsk = await phone.until((m) => m.t === 'approval', { what: 'la seconda richiesta' });
  check('anche la seconda chat chiede il permesso, e arriva a chi la guarda', Boolean(secondAsk.approval.id));

  const expired = await phone.until(
    (m) => m.t === 'approval_gone' && m.id === secondAsk.approval.id,
    { timeoutMs: TTL_MS + 30_000, what: 'la scadenza della richiesta' },
  );
  check('senza risposta la richiesta scade', expired.reason === 'expired', expired.reason);
  phone.close();

  await sleep(3_000);
  const chat = await api(`/local/sessions/${second.sessionId}/chat`);
  check('e il comando NON è stato eseguito: nessun permesso regalato',
    !JSON.stringify(chat.messages).includes('Example Domain'));

  const orphan = await fetch(`http://127.0.0.1:${port}/local/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cc-remote-token': TOKEN },
    body: JSON.stringify({ sessionId: 'inesistente', toolName: 'Bash', input: {} }),
  }).then((response) => response.json());
  check('una richiesta per una sessione che non esiste non mette in attesa nessuno', orphan.decision === null);

  browser.close();
} catch (error) {
  check('giro dal vivo', false, error.message);
} finally {
  cleanup();
}

console.log(`\n${failures === 0 ? 'APPROVE LIVE PASS' : `APPROVE LIVE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
