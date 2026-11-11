import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

// Il server si spegne e riparte davvero (processo nuovo, stesso file di stato).
//
// È il giro che conta per due cose che in memoria non si possono provare:
//  - le conversazioni restano, e restano *loro* (stesso id, stesso transcript);
//  - una `requestId` già eseguita non riesegue: senza il giornale, dopo il riavvio quel
//    controllo non esiste più e il client che riprova fa partire un secondo prompt.

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'token-di-prova-lungo-abbastanza';
const FAKE = path.join(repo, 'tools', 'fake-claude.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-restart-'));
const project = path.join(root, 'progetto');
fs.mkdirSync(project, { recursive: true });
let port = 0;
let child = null;
let log = '';

const env = () => ({
  ...process.env,
  CR_TOKEN: TOKEN,
  CR_PORT: String(port),
  CR_CLAUDE_CMD: process.execPath,
  CR_CLAUDE_ARGS: JSON.stringify([FAKE]),
  CR_STATE_FILE: path.join(root, 'sessions.json'),
  CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
  CR_DEFAULT_PROJECT: project,
  CR_ALLOWED_ROOTS: root,
  CR_PROJECTS_ROOT: path.join(root, 'projects'),
  CR_LOG_FILE: path.join(root, 'server.log'),
});

async function start() {
  log = '';
  child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (/WRA on http:\/\//.test(log)) return true;
    if (child.exitCode !== null) return false;
    await sleep(100);
  }
  return false;
}

async function stop() {
  await api('/local/shutdown', { method: 'POST' }).catch(() => {});
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && child?.exitCode === null) await sleep(150);
  if (child?.exitCode === null) child.kill();
  await sleep(300);
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

test.before(async () => {
  port = await freePort();
  assert.equal(await start(), true, `il server non è partito: ${log}`);
});

test.after(async () => {
  await stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test('la conversazione sopravvive allo spegnimento, e la requestId non riesegue', async () => {
  const created = (await api('/local/sessions', { method: 'POST', body: { projectPath: project, name: 'che riparte' } })).session;
  const sessionId = created.sessionId;

  const first = await api('/local/talk', { method: 'POST', body: { sessionId, requestId: 'r1', message: 'prima del riavvio' } });
  assert.equal(first.turn.state, 'done');
  assert.equal(first.turn.reused, false);

  const transcript = path.join(root, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
  const sizeBefore = fs.statSync(transcript).size;
  assert.ok(fs.existsSync(path.join(root, 'turns.json')), 'il giornale è stato scritto');
  const journalBefore = JSON.parse(fs.readFileSync(path.join(root, 'turns.json'), 'utf8')).turns.length;
  assert.equal(journalBefore, 1);

  // --- il server muore e rinasce: processo nuovo, stessa cartella ---
  await stop();
  assert.notEqual(child.exitCode ?? 0, null, 'il processo è uscito');
  assert.equal(await start(), true, `il server non è ripartito: ${log}`);
  const health = await api('/healthz');
  assert.equal(health.journal, 1, 'il giornale è stato riletto dal disco');

  // la chat c'è ancora, con il suo id, e il processo è spento
  const after = (await api('/local/sessions')).sessions.find((session) => session.sessionId === sessionId);
  assert.ok(after, 'la conversazione non è sparita');
  assert.equal(after.state, 'offline');

  // e la stessa richiesta non riparte: risposta di allora, niente prompt nuovo
  const again = await api('/local/talk', { method: 'POST', body: { sessionId, requestId: 'r1', message: 'prima del riavvio' } });
  assert.equal(again.turn.reused, true, 'la richiesta è riconosciuta come già eseguita');
  assert.equal(again.turn.fromJournal, true, 'e viene dal giornale, non dalla memoria di questo processo');
  assert.equal(again.turn.reply, first.turn.reply, 'con la risposta di allora');

  await sleep(2_000);
  assert.equal(fs.statSync(transcript).size, sizeBefore, 'il transcript non è cresciuto: nessun secondo prompt');

  // e la chat si riprende, con lo stesso id (--resume), non con una nuova conversazione
  const resumed = await api('/local/talk', { method: 'POST', body: { sessionId, message: 'dopo il riavvio' } });
  assert.equal(resumed.turn.state, 'done');
  assert.equal((await api('/local/sessions')).sessions.filter((session) => session.projectPath === project).length, 1,
    'riprendere non crea una seconda conversazione nella stessa cartella');
  assert.ok(fs.statSync(transcript).size > sizeBefore, 'e scrive nello stesso transcript');
});
