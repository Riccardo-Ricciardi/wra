// Prova dal vivo (manuale, non in CI): due chat vere dello stesso progetto, una sola
// autorizzata a MCP, nessuna contaminazione. Col `claude` vero e la config dell'utente.
// Va rilanciata a ogni aggiornamento di Claude Code, insieme a `rc doctor`.
// Prova dal vivo del criterio di completamento, col claude vero:
//   due chat nello STESSO progetto → due processi e due conversazioni diverse
//   solo una autorizzata a MCP → i messaggi vanno solo dove deciso, senza contaminazione
//
// Uso la config vera dell'utente (i transcript finiscono in ~/.claude/projects e li cancello
// alla fine) e una cartella già fidata, così il TUI parte subito.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const home = process.env.USERPROFILE ?? os.homedir();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-live-'));
const TOKEN = 'token-di-prova-lungo-abbastanza';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
  env: {
    ...process.env,
    CR_TOKEN: TOKEN,
    CR_PORT: '0',
    CR_ALLOWED_ROOTS: home,
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_DEFAULT_PROJECT: home,
    CR_PERMISSION_MODE: 'default',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });

let port = null;
const deadline = Date.now() + 25_000;
while (Date.now() < deadline && !port) {
  const match = log.match(/cc-remote su http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) port = Number(match[1]);
  else await sleep(100);
}
if (!port) {
  console.log('server non partito:', log);
  process.exit(1);
}

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

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? ' ok ' : 'NO  '} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

try {
  const a = (await api('/local/sessions', { method: 'POST', body: { projectPath: home, name: 'live-A' } })).session;
  created.push(a);
  const b = (await api('/local/sessions', { method: 'POST', body: { projectPath: home, name: 'live-B' } })).session;
  created.push(b);

  check('due chat nello stesso progetto, id diversi', a.sessionId !== b.sessionId && a.projectPath === b.projectPath,
    `${a.sessionId.slice(0, 8)} e ${b.sessionId.slice(0, 8)}`);

  const list = await api('/local/sessions');
  check('MCP spento di default su entrambe', list.sessions.every((session) => session.mcpAllowed === false));

  await api(`/local/sessions/${a.sessionId}/mcp`, { method: 'POST', body: { allowed: true } });
  const after = await api('/local/sessions');
  check('solo A è autorizzata a MCP',
    after.sessions.find((s) => s.sessionId === a.sessionId).mcpAllowed === true
    && after.sessions.find((s) => s.sessionId === b.sessionId).mcpAllowed === false);

  console.log('\n... i due agenti veri stanno partendo (può volerci un mezzo minuto)');
  const turnA = await api('/local/talk', { method: 'POST', body: { sessionId: a.sessionId, message: 'Rispondi solo con: LIVE-A' } });
  check('turno su A risposto', turnA.turn.state === 'done', `${turnA.turn.reply}`.slice(0, 60));

  const turnB = await api('/local/talk', { method: 'POST', body: { sessionId: b.sessionId, message: 'Rispondi solo con: LIVE-B' } });
  check('turno su B risposto', turnB.turn.state === 'done', `${turnB.turn.reply}`.slice(0, 60));

  const dir = path.join(home, '.claude', 'projects', home.replace(/[^A-Za-z0-9]/g, '-'));
  const readA = fs.existsSync(path.join(dir, `${a.sessionId}.jsonl`)) ? fs.readFileSync(path.join(dir, `${a.sessionId}.jsonl`), 'utf8') : '';
  const readB = fs.existsSync(path.join(dir, `${b.sessionId}.jsonl`)) ? fs.readFileSync(path.join(dir, `${b.sessionId}.jsonl`), 'utf8') : '';

  check('A ha il suo transcript, con il suo id', readA.includes(a.sessionId) && readA.includes('LIVE-A'));
  check('B ha il suo transcript, con il suo id', readB.includes(b.sessionId) && readB.includes('LIVE-B'));
  check('nessuna contaminazione: A non ha i messaggi di B', !readA.includes('LIVE-B'), 'e viceversa', !readB.includes('LIVE-A'));

  // lo stesso request id due volte: un solo turno
  const again = await api('/local/talk', { method: 'POST', body: { sessionId: a.sessionId, message: 'Rispondi solo con: LIVE-A', requestId: 'doppio' } });
  const twice = await api('/local/talk', { method: 'POST', body: { sessionId: a.sessionId, message: 'Rispondi solo con: LIVE-A', requestId: 'doppio' } });
  check('stesso request id: un turno solo, riusato',
    again.turn.turnId === twice.turn.turnId,
    `turnId ${again.turn.turnId.slice(0, 8)} — riusato=${twice.turn.reused}`);
} catch (error) {
  check('giro dal vivo', false, error.message);
} finally {
  cleanup();
}

console.log(`\n${failures === 0 ? 'LIVE PASS' : `LIVE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);