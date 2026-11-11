import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { serverEnv } from '../tools/server-env.mjs';

// End-to-end senza browser: server vero, TUI finta, client websocket veri (proto 2).
// Copre il criterio: due chat dello stesso progetto, ognuna col suo processo e il suo output;
// ruoli (chi guarda non scrive); l'interruttore MCP che si vede da tutti i client.

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'test-token-lungo-abbastanza';
const FAKE = path.join(repo, 'tools', 'fake-claude.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Su Windows il processo figlio lascia le maniglie sulla cartella per un attimo dopo `kill()`:
// un tentativo solo lasciava dietro una cartella a ogni esecuzione. Qualche giro con una pausa
// basta, e se non basta si lascia lì: è pulizia, non un test.
async function dropDir(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      return;
    } catch {
      await sleep(250);
    }
  }
}

async function startServer(project) {
  const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
    env: {
      ...serverEnv(),
      CR_TOKEN: TOKEN,
      CR_PORT: '0',
      CR_CLAUDE_CMD: process.execPath,
      CR_CLAUDE_ARGS: JSON.stringify([FAKE]),
      CR_DEFAULT_PROJECT: project,
      CR_ALLOWED_ROOTS: path.dirname(project),
      // la suite apre molte chat nello stesso server: il tetto di default è per l'uso vero
      CR_MAX_SESSIONS: '64',
      CR_STATE_FILE: path.join(path.dirname(project), 'sessions.json'),
      CR_TURN_JOURNAL_FILE: path.join(path.dirname(project), 'turns.json'),
      CR_PROJECTS_ROOT: path.join(path.dirname(project), 'projects'),
      CR_LOG_FILE: path.join(path.dirname(project), 'test.log'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = out.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return { child, port: Number(match[1]), log: () => out };
    if (child.exitCode !== null) throw new Error(`il server è uscito: ${out}`);
    await sleep(100);
  }
  throw new Error(`il server non si è annunciato: ${out}`);
}

function connect(port, { token = TOKEN, role = 'terminal', origin = null, cols = 100, rows = 30 } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, token ? [`bearer.${token}`] : [], origin ? { origin } : {});
  const state = {
    messages: [],
    output: new Map(),
    sessions: [],
    opened: null,
    errors: [],
    wsState: { opened: false, closed: false, failed: false, error: null },
  };

  ws.on('open', () => {
    state.wsState.opened = true;
    ws.send(JSON.stringify({ t: 'hello', proto: 2, role, cols, rows }));
  });
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    state.messages.push(message);
    if (message.t === 'welcome' || message.t === 'sessions') state.sessions = message.sessions ?? state.sessions;
    if (message.t === 'opened') {
      state.opened = message.session;
      if (message.replay) state.output.set(message.session.sessionId, message.replay);
    }
    if (message.t === 'output') {
      state.output.set(message.sessionId, (state.output.get(message.sessionId) ?? '') + message.data);
    }
    if (message.t === 'error') state.errors.push(message.message);
  });
  ws.on('close', () => { state.wsState.closed = true; });
  ws.on('error', (error) => { state.wsState.failed = true; state.wsState.error = error?.message ?? String(error); });

  state.send = (message) => ws.send(JSON.stringify(message));
  state.create = (projectPath, name) => state.send({ t: 'create', projectPath, name });
  state.open = (sessionId) => state.send({ t: 'open', sessionId });
  state.input = (data) => state.send({ t: 'input', data });
  state.until = async (predicate, { timeoutMs = 8_000, what = 'condizione', from = 0 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let found = null;
      for (let index = from; index < state.messages.length; index += 1) {
        if (predicate(state.messages[index], index)) { found = state.messages[index]; break; }
      }
      if (found) return found;
      if (state.wsState.closed && !state.wsState.opened) {
        throw new Error(`socket chiuso prima di ${what} (error=${state.wsState.error})`);
      }
      await sleep(50);
    }
    throw new Error(`tempo scaduto aspettando ${what}: ${JSON.stringify(state.messages).slice(0, 300)}`);
  };
  state.stateOf = (sessionId) => state.sessions.find((session) => session.sessionId === sessionId);
  state.close = () => ws.close();
  return state;
}

// Questo `api` è **il browser di questa macchina**, e da adesso lo dice: manda l'`Origin` che un
// browser manda sempre sulla POST. Non è cosmesi — l'esposizione di una chat che salta i permessi
// si autorizza dal browser locale, e «locale» adesso si argomenta dall'`Origin` invece che dalla
// sua assenza (un'assenza la ottiene chiunque, anche chi arriva da internet).
const api = async (route, { method = 'GET', body = null, origin = null } = {}) => {
  const response = await fetch(`http://127.0.0.1:${shared.server.port}${route}`, {
    method,
    headers: {
      'x-cc-remote-token': TOKEN,
      origin: origin ?? `http://127.0.0.1:${shared.server.port}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};

/** Quello che fa l'hook dentro il `claude`: chiede il permesso e resta appeso alla risposta. */
const askPermission = (sessionId, toolName, input) => api('/local/approve', {
  method: 'POST',
  body: { sessionId, toolName, input },
});

const shared = { server: null, project: null };

test.before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-e2e-'));
  shared.project = path.join(root, 'progetto');
  fs.mkdirSync(shared.project, { recursive: true });
  shared.server = await startServer(shared.project);
});

test.after(async () => {
  const child = shared.server?.child;
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, sleep(3_000)]);
  }
  if (shared.project) await dropDir(path.dirname(shared.project));
});

test('un token sbagliato non entra', async () => {
  const client = connect(shared.server.port, { token: 'sbagliato' });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !client.wsState.opened && !client.wsState.failed && !client.wsState.closed) await sleep(50);
  assert.equal(client.wsState.opened, false);
  client.close();
});

test("un'origine estranea non entra (DNS rebinding)", async () => {
  const client = connect(shared.server.port, { origin: 'http://evil.example' });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !client.wsState.opened && !client.wsState.failed && !client.wsState.closed) await sleep(50);
  assert.equal(client.wsState.opened, false);
  client.close();
});

test('due chat dello stesso progetto: processi e output separati', async () => {
  const client = connect(shared.server.port);
  try {
    await client.until((m) => m.t === 'welcome');

    client.create(shared.project, 'prima');
    const first = await client.until((m) => m.t === 'opened');
    await client.until(() => (client.output.get(first.session.sessionId) ?? '').includes('FAKE-CLAUDE pronto'));

    const watcher = connect(shared.server.port, { role: 'viewer' });
    await watcher.until((m) => m.t === 'welcome');
    watcher.open(first.session.sessionId);
    await watcher.until((m) => m.t === 'opened');

    client.create(shared.project, 'seconda');
    const second = await client.until((m) => m.t === 'opened' && m.session.sessionId !== first.session.sessionId);

    assert.notEqual(first.session.sessionId, second.session.sessionId);
    assert.equal(first.session.projectPath, shared.project);
    assert.equal(second.session.projectPath, shared.project);

    // scriviamo nella seconda: la prima non deve vederlo
    client.input('per la seconda\r');
    await client.until(() => (client.output.get(second.session.sessionId) ?? '').includes('ECHO'));
    const firstOutput = client.output.get(first.session.sessionId) ?? '';
    assert.equal(firstOutput.includes('per la seconda'), false, 'due chat non si vedono i tasti a vicenda');

    watcher.close();
  } finally {
    client.close();
  }
});

test('chi guarda non scrive', async () => {
  const owner = connect(shared.server.port);
  await owner.until((m) => m.t === 'welcome');
  owner.create(shared.project, 'guardata');
  const opened = await owner.until((m) => m.t === 'opened');

  const viewer = connect(shared.server.port, { role: 'viewer' });
  await viewer.until((m) => m.t === 'welcome');
  viewer.open(opened.session.sessionId);
  await viewer.until((m) => m.t === 'opened');

  viewer.input('non dovrei\r');
  await viewer.until((m) => m.t === 'error', { what: 'errore di sola lettura' });
  assert.match(viewer.errors.join(' '), /read-only/);

  viewer.close();
  owner.close();
});

test("l'interruttore «Consenti a ChatGPT» si vede dagli altri client", async () => {
  const owner = connect(shared.server.port);
  const other = connect(shared.server.port);
  try {
    await owner.until((m) => m.t === 'welcome');
    await other.until((m) => m.t === 'welcome');

    owner.create(shared.project, 'da autorizzare');
    const opened = await owner.until((m) => m.t === 'opened');
    assert.equal(opened.session.mcpAllowed, false, 'spento di default');

    owner.send({ t: 'mcp_allowed', sessionId: opened.session.sessionId, allowed: true });
    await other.until(() => (other.stateOf(opened.session.sessionId)?.mcpAllowed ?? false) === true, { what: 'MCP acceso anche dall altro client' });
  } finally {
    owner.close();
    other.close();
  }
});

test("il permesso chiesto dall'hook arriva al client, e la decisione torna indietro", async () => {
  const client = connect(shared.server.port);
  try {
    await client.until((m) => m.t === 'welcome');
    client.create(shared.project, 'con permesso');
    const opened = await client.until((m) => m.t === 'opened');
    const sessionId = opened.session.sessionId;

    const asking = askPermission(sessionId, 'Bash', { command: 'rm -rf /tmp/x' });
    const asked = await client.until((m) => m.t === 'approval', { what: 'la richiesta di permesso' });
    assert.equal(asked.approval.toolName, 'Bash');
    assert.equal(asked.approval.input.command, 'rm -rf /tmp/x', 'chi decide vede cosa verrebbe eseguito');
    assert.equal(asked.approval.sessionId, sessionId);

    // e si vede anche nell'elenco, che è quello che il telefono interroga
    const listed = await api('/local/sessions');
    assert.equal(listed.json.approvals.length, 1);
    assert.equal(listed.json.approvals[0].id, asked.approval.id);

    client.send({ t: 'approve', id: asked.approval.id, behavior: 'allow' });
    const answer = await asking;
    assert.equal(answer.json.decision.behavior, 'allow', "l'hook riceve la decisione e la passa al TUI");
    await client.until((m) => m.t === 'approval_gone' && m.id === asked.approval.id, { what: 'la richiesta tolta di mezzo' });

    const after = await api('/local/sessions');
    assert.equal(after.json.approvals.length, 0);
  } finally {
    client.close();
  }
});

test('chi decide può anche rifiutare, e il motivo viaggia', async () => {
  const client = connect(shared.server.port);
  try {
    await client.until((m) => m.t === 'welcome');
    client.create(shared.project, 'da rifiutare');
    const opened = await client.until((m) => m.t === 'opened');

    const asking = askPermission(opened.session.sessionId, 'Write', { file_path: '/etc/passwd' });
    const asked = await client.until((m) => m.t === 'approval');
    client.send({ t: 'approve', id: asked.approval.id, behavior: 'deny', reason: 'non si tocca' });

    const answer = await asking;
    assert.equal(answer.json.decision.behavior, 'deny');
    assert.equal(answer.json.decision.message, 'non si tocca');
    await client.until((m) => m.t === 'approval_gone' && m.id === asked.approval.id);
  } finally {
    client.close();
  }
});

test('la richiesta si vede solo da chi guarda quella chat', async () => {
  const owner = connect(shared.server.port);
  const other = connect(shared.server.port);
  try {
    await owner.until((m) => m.t === 'welcome');
    await other.until((m) => m.t === 'welcome');

    owner.create(shared.project, 'osservata');
    const opened = await owner.until((m) => m.t === 'opened');

    other.create(shared.project, 'altra');
    await other.until((m) => m.t === 'opened' && m.session.sessionId !== opened.session.sessionId);

    const asking = askPermission(opened.session.sessionId, 'Bash', { command: 'ls' });
    await owner.until((m) => m.t === 'approval');

    assert.equal(other.messages.some((m) => m.t === 'approval'), false, 'un altra chat non deve vederla');
    const listed = await api('/local/sessions');
    assert.equal(listed.json.approvals.length, 1, "ma l'elenco le mostra tutte, per chi le cerca");

    owner.send({ t: 'approve', id: listed.json.approvals[0].id, behavior: 'deny' });
    await asking;
  } finally {
    owner.close();
    other.close();
  }
});

test('chi guarda soltanto non concede permessi', async () => {
  const owner = connect(shared.server.port);
  const viewer = connect(shared.server.port, { role: 'viewer' });
  try {
    await owner.until((m) => m.t === 'welcome');
    viewer.until((m) => m.t === 'welcome');
    owner.create(shared.project, 'solo lettura');
    const opened = await owner.until((m) => m.t === 'opened');

    viewer.open(opened.session.sessionId);
    await viewer.until((m) => m.t === 'opened');

    const asking = askPermission(opened.session.sessionId, 'Bash', { command: 'ls' });
    const asked = await viewer.until((m) => m.t === 'approval', { what: 'la richiesta anche al viewer' });

    viewer.input('no');
    viewer.send({ t: 'approve', id: asked.approval.id, behavior: 'allow' });
    await viewer.until((m) => m.t === 'error' && /read-only/.test(m.message), { what: 'il rifiuto del viewer' });

    owner.send({ t: 'approve', id: asked.approval.id, behavior: 'deny' });
    await asking;
  } finally {
    owner.close();
    viewer.close();
  }
});

test('una sessione che non esiste non mette in attesa nessuno', async () => {
  const answer = await askPermission('00000000-0000-4000-8000-000000000000', 'Bash', { command: 'ls' });
  assert.equal(answer.json.decision, null, 'nessuna decisione: il dialog resta al terminale');
  const listed = await api('/local/sessions');
  assert.equal(listed.json.approvals.length, 0);
});

test('decidere due volte: la seconda non trova più niente', async () => {
  const client = connect(shared.server.port);
  try {
    await client.until((m) => m.t === 'welcome');
    client.create(shared.project, 'una volta sola');
    const opened = await client.until((m) => m.t === 'opened');

    const asking = askPermission(opened.session.sessionId, 'Bash', { command: 'ls' });
    const asked = await client.until((m) => m.t === 'approval');
    const first = await api(`/local/approvals/${asked.approval.id}`, { method: 'POST', body: { behavior: 'allow' } });
    const second = await api(`/local/approvals/${asked.approval.id}`, { method: 'POST', body: { behavior: 'allow' } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 404);
    await asking;
  } finally {
    client.close();
  }
});

test('senza token non si decide niente', async () => {
  const response = await fetch(`http://127.0.0.1:${shared.server.port}/local/approvals`, { headers: { 'x-cc-remote-token': 'sbagliato' } });
  assert.equal(response.status, 401);
});

test('switchare chat non perde lo stato: riaprendo, il replay è ancora lì', async () => {
  const client = connect(shared.server.port);
  try {
    await client.until((m) => m.t === 'welcome');
    client.create(shared.project, 'A');
    const a = await client.until((m) => m.t === 'opened');
    client.input('segno in A\r');
    await client.until(() => (client.output.get(a.session.sessionId) ?? '').includes('segno in A'));

    client.create(shared.project, 'B');
    await client.until((m) => m.t === 'opened' && m.session.sessionId !== a.session.sessionId);

    // torno su A: il server manda il replay della sua schermata
    const from = client.messages.length;
    client.open(a.session.sessionId);
    const reopened = await client.until((m, index) => index >= from && m.t === 'opened' && m.session.sessionId === a.session.sessionId);
    assert.match(reopened.replay ?? '', /segno in A/, 'la chat di prima è ancora lì, con la sua storia');
  } finally {
    client.close();
  }
});
test('se il processo dell agente muore durante un turno, il turno lo dice subito', async () => {
  const client = connect(shared.server.port);
  try {
    await client.until((m) => m.t === 'welcome');
    client.create(shared.project, 'che muore');
    const opened = await client.until((m) => m.t === 'opened');
    const sessionId = opened.session.sessionId;
    await client.until(() => client.stateOf(sessionId)?.state === 'ready', { what: 'la TUI pronta' });

    // la TUI finta esce quando riceve "exit": è un crash, dal punto di vista del server
    const startedAt = Date.now();
    const answer = await api('/local/talk', { method: 'POST', body: { sessionId, message: 'exit' } });
    const elapsed = Date.now() - startedAt;

    assert.equal(answer.json.turn.state, 'error', `stato: ${answer.json.turn.state}`);
    assert.match(String(answer.json.turn.error), /agent process ended/, `errore: ${answer.json.turn.error}`);
    assert.ok(elapsed < 20_000, `non deve aspettare la scadenza lunga (ci ha messo ${elapsed}ms)`);

    // la conversazione resta, il processo no — e lo stato lo dice: `exited` (il processo c'era ed
    // è morto) non è `offline` (non è mai stato acceso). Prima erano la stessa parola, e chi
    // guardava una finestra agganciata a una sessione morta non poteva saperlo.
    const listed = await api('/local/sessions');
    const session = listed.json.sessions.find((entry) => entry.sessionId === sessionId);
    assert.ok(session, 'la chat non sparisce quando il processo muore');
    assert.equal(session.state, 'exited');
    assert.equal(session.pid, null);
  } finally {
    client.close();
  }
});

test('due client sulla stessa chat: un processo solo', async () => {
  const first = connect(shared.server.port);
  const second = connect(shared.server.port);
  try {
    await first.until((m) => m.t === 'welcome');
    await second.until((m) => m.t === 'welcome');

    first.create(shared.project, 'una sola');
    const opened = await first.until((m) => m.t === 'opened');
    const sessionId = opened.session.sessionId;
    await first.until(() => first.stateOf(sessionId)?.state === 'ready');

    const before = first.stateOf(sessionId).pid;
    second.open(sessionId);
    await second.until((m) => m.t === 'opened' && m.session.sessionId === sessionId);
    await first.until(() => first.stateOf(sessionId)?.state === 'ready');

    const after = first.stateOf(sessionId).pid;
    assert.equal(after, before, 'il secondo client si aggancia, non fa partire un secondo processo');

    // La prova che il terminale è uno solo e condiviso: quello che scrive un client lo vede
    // l'altro. Due processi darebbero due schermate separate, ognuna con le sue righe.
    first.input('segno-croce\r');
    await second.until(() => (second.output.get(sessionId) ?? '').includes('segno-croce'), { what: 'lo stesso terminale per tutti e due' });

    const listed = await api('/local/sessions');
    assert.equal(listed.json.sessions.filter((entry) => entry.sessionId === sessionId).length, 1, 'una chat, non due');
    assert.equal(listed.json.sessions.find((entry) => entry.sessionId === sessionId).pid, before, 'e sempre lo stesso processo');
  } finally {
    first.close();
    second.close();
  }
});

test('chiudere il browser non chiude la chat: si riapre e c è ancora tutto', async () => {
  const first = connect(shared.server.port);
  await first.until((m) => m.t === 'welcome');
  first.create(shared.project, 'sopravvive');
  const opened = await first.until((m) => m.t === 'opened');
  const sessionId = opened.session.sessionId;

  first.input('prima di chiudere\r');
  await first.until(() => (first.output.get(sessionId) ?? '').includes('prima di chiudere'));
  first.close();
  await sleep(1_500);

  const listed = await api('/local/sessions');
  const session = listed.json.sessions.find((entry) => entry.sessionId === sessionId);
  assert.ok(session, 'la chat resta nell elenco');
  assert.equal(session.state, 'ready', 'e il processo dell agente resta vivo: il browser è solo uno schermo');

  const again = connect(shared.server.port);
  try {
    await again.until((m) => m.t === 'welcome');
    again.open(sessionId);
    const reopened = await again.until((m) => m.t === 'opened' && m.session.sessionId === sessionId);
    assert.match(reopened.replay ?? '', /prima di chiudere/, 'la schermata è ancora quella');
  } finally {
    again.close();
  }
});

test('la modalità dei permessi: nasce per chat, si vede, si cambia, e non la tocca un client remoto', async () => {
  // Le rotte HTTP sono quelle che usa il sito. La chat la crea la CLI (o il sito), ma la
  // modalità la decide **chi la crea**: il bypass si chiede esplicitamente, e solo la CLI lo fa.
  const root = path.join(path.dirname(shared.project), 'progetto-permessi');
  fs.mkdirSync(root, { recursive: true });

  const normale = await api('/local/sessions', { method: 'POST', body: { projectPath: root, name: 'normale' } });
  assert.equal(normale.status, 200, JSON.stringify(normale.json));
  assert.equal(normale.json.session.permissionMode, 'default', 'senza chiedere, la modalità è la normale');

  const bypass = await api('/local/sessions', { method: 'POST', body: { projectPath: root, name: 'bypass', permissionMode: 'bypassPermissions' } });
  assert.equal(bypass.json.session.permissionMode, 'bypassPermissions');
  const id = bypass.json.session.sessionId;

  // Visibile a chi elenca (è quello che rende il chip nel sito).
  const listed = await api('/local/sessions');
  assert.equal(listed.json.sessions.find((s) => s.sessionId === id).permissionMode, 'bypassPermissions');

  // E si torna indietro.
  const back = await api(`/local/sessions/${id}/permissions`, { method: 'POST', body: { mode: 'default' } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json.session.permissionMode, 'default');

  // Una modalità inventata non diventa un argomento sulla riga di comando di claude.
  const bad = await api(`/local/sessions/${id}/permissions`, { method: 'POST', body: { mode: 'evilMode' } });
  assert.equal(bad.status, 400);
  assert.match(String(bad.json.error), /unrecognized/);
});

// ── «MCP automatico controllato»: dal sito fino alla risposta dell'hook ──────
// Il giro completo: si accende dalla dashboard (la stessa chiamata che fa il menu), l'hook dentro
// il `claude` chiede un permesso, e la risposta che riceve dipende dal criterio — non da una
// spunta nell'interfaccia. Poi si spegne, e la richiesta successiva torna a chiedere.

/** Aspetta che una richiesta di quella conversazione compaia fra quelle in attesa. */
async function waitPending(sessionId, what) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = (await api('/local/approvals')).json.approvals.find((entry) => entry.sessionId === sessionId);
    if (found) return found;
    await sleep(50);
  }
  throw new Error(`nessuna richiesta in attesa: ${what}`);
}

/** Chiede un permesso, si assicura che sia finito in attesa, e lo rifiuta per liberare l'hook. */
async function askAndDeny(sessionId, toolName, input, message) {
  const asking = askPermission(sessionId, toolName, input);
  const pending = await waitPending(sessionId, `${toolName} doveva chiedere`);
  await api(`/local/approvals/${pending.id}`, { method: 'POST', body: { behavior: 'deny', message } });
  return (await asking).json.decision;
}

test('automatico controllato: acceso concede dentro il progetto, e la revoca vale subito', async () => {
  const root = path.join(path.dirname(shared.project), 'progetto-auto');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });

  const created = await api('/local/sessions', { method: 'POST', body: { projectPath: root, name: 'auto' } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const sessionId = created.json.session.sessionId;
  assert.equal(created.json.session.autoApprove, null, 'nasce senza scelta: spento');

  // Spento: una modifica dentro il progetto **chiede**, come sempre.
  const denied = await askAndDeny(sessionId, 'Edit', { file_path: path.join(root, 'src', 'a.js'), old_string: 'a', new_string: 'b' }, 'spento');
  assert.equal(denied.behavior, 'deny');

  // Si accende dalla dashboard — è la stessa POST che fa il menu della conversazione.
  const on = await api(`/local/sessions/${sessionId}/auto`, { method: 'POST', body: { enabled: true } });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.session.autoApprove, true);
  assert.equal(on.json.session.permissionMode, 'default', "accendere l'automatico non salta i permessi");

  // Dentro il progetto: la risposta arriva subito e nessuno deve decidere niente.
  const inside = await askPermission(sessionId, 'Edit', { file_path: path.join(root, 'src', 'a.js'), old_string: 'a', new_string: 'b' });
  assert.equal(inside.json.decision.behavior, 'allow', 'dentro il progetto non si chiede');
  assert.equal((await api('/local/approvals')).json.approvals.length, 0, 'non è rimasta niente in attesa');
  const trace = (await api('/local/sessions')).json.autoApprovals;
  assert.equal(trace.length, 1, "la concessione automatica si vede nell'elenco");
  assert.equal(trace[0].automatic, true);
  assert.match(trace[0].reason, /inside the project/);

  // Fuori dal progetto: si chiede — anche quando il nome della cartella *sembra* quello giusto.
  const outside = await askAndDeny(sessionId, 'Write', { file_path: path.join(path.dirname(root), 'fuori.js') }, 'fuori');
  assert.equal(outside.behavior, 'deny');

  // Un comando: si chiede sempre, anche con l'automatico acceso.
  const command = await askAndDeny(sessionId, 'Bash', { command: 'npm test' }, 'comando');
  assert.equal(command.behavior, 'deny');

  // Credenziali dentro il progetto: si chiedono lo stesso.
  const secret = await askAndDeny(sessionId, 'Write', { file_path: path.join(root, '.env') }, 'credenziali');
  assert.equal(secret.behavior, 'deny');

  // La revoca dalla dashboard: la richiesta **successiva** torna a chiedere, senza riavviare niente.
  const off = await api(`/local/sessions/${sessionId}/auto`, { method: 'POST', body: { enabled: false } });
  assert.equal(off.json.session.autoApprove, false);
  const again = await askAndDeny(sessionId, 'Edit', { file_path: path.join(root, 'src', 'a.js') }, 'revocato');
  assert.equal(again.behavior, 'deny');
});

test('automatico e bypass non stanno accesi insieme, e il progetto lo accende per la cartella', async () => {
  const root = path.join(path.dirname(shared.project), 'progetto-auto-2');
  fs.mkdirSync(root, { recursive: true });

  const bypass = await api('/local/sessions', { method: 'POST', body: { projectPath: root, name: 'bypass', permissionMode: 'bypassPermissions' } });
  const id = bypass.json.session.sessionId;
  const refused = await api(`/local/sessions/${id}/auto`, { method: 'POST', body: { enabled: true } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /skips permissions/);
  assert.equal((await api('/local/sessions')).json.sessions.find((s) => s.sessionId === id).autoApprove, null, 'un rifiuto non accende niente');

  // L'interruttore di progetto: vale per le conversazioni della cartella che non hanno scelto.
  const project = await api('/local/projects/update', { method: 'POST', body: { path: root, autoApprove: true } });
  assert.equal(project.status, 200, JSON.stringify(project.json));
  assert.equal(project.json.projects.find((entry) => entry.path === root)?.autoApprove, true);

  const plain = await api('/local/sessions', { method: 'POST', body: { projectPath: root, name: 'erede' } });
  const plainId = plain.json.session.sessionId;
  const inside = await askPermission(plainId, 'Write', { file_path: path.join(root, 'nuovo.js') });
  assert.equal(inside.json.decision.behavior, 'allow', 'la conversazione senza scelta prende quella del progetto');

  // La conversazione che dice «spento» resta spenta anche dentro il progetto acceso.
  await api(`/local/sessions/${plainId}/auto`, { method: 'POST', body: { enabled: false } });
  const denied = await askAndDeny(plainId, 'Write', { file_path: path.join(root, 'nuovo-2.js') }, 'no');
  assert.equal(denied.behavior, 'deny', 'la scelta della conversazione vince su quella del progetto');

  // E spegnere il progetto spegne la cartella.
  await api('/local/projects/update', { method: 'POST', body: { path: root, autoApprove: false } });
  assert.equal((await api('/local/sessions')).json.projects.find((entry) => entry.path === root)?.autoApprove, false);
});

// ---------------------------------------------------------------------------
// La modalità ad alto privilegio, dal sito: consenso esplicito, da questa macchina, revocabile.
//
// Il divieto assoluto («una chat in bypass non si espone mai») diventa un consenso: la chat si
// espone, ma solo se il proprietario lo dice per esteso — la conferma ripete il nome, la
// richiesta arriva dal browser di questa macchina, e resta scritto quando è successo.
// ---------------------------------------------------------------------------

test('una chat che salta i permessi si espone solo con il consenso, e solo da qui', async () => {
  const created = await api('/local/sessions', {
    method: 'POST',
    body: { projectPath: shared.project, name: 'bypass-da-esporre', permissionMode: 'bypassPermissions' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.session.sessionId;
  assert.equal(created.json.session.mcpReachable, false, 'nasce non raggiungibile');
  assert.equal(created.json.session.mcpBypassAt, null, 'e senza nessun consenso registrato');

  const view = async () => (await api('/local/sessions')).json.sessions.find((entry) => entry.sessionId === id);

  // 1. senza la conferma: rifiutata, e non resta esposta lo stesso
  const noConfirm = await api(`/local/sessions/${id}/mcp`, { method: 'POST', body: { allowed: true } });
  assert.equal(noConfirm.status, 400);
  assert.match(noConfirm.json.error, /skips permissions/);
  assert.match(noConfirm.json.error, /explicit confirmation/);
  assert.equal((await view()).mcpReachable, false);

  // 2. con la conferma sbagliata: rifiutata
  const wrong = await api(`/local/sessions/${id}/mcp`, { method: 'POST', body: { allowed: true, confirm: 'un altro nome' } });
  assert.equal(wrong.status, 400);
  assert.equal((await view()).mcpReachable, false);

  // 3. da un'origine estranea: rifiutata anche con la conferma giusta — è il consenso che si dà
  //    dal browser di questa macchina, non da un sito qualsiasi che ha il token
  const foreign = await fetch(`http://127.0.0.1:${shared.server.port}/local/sessions/${id}/mcp`, {
    method: 'POST',
    headers: { 'x-cc-remote-token': TOKEN, 'content-type': 'application/json', origin: 'https://un-altro-sito.example' },
    body: JSON.stringify({ allowed: true, confirm: 'bypass-da-esporre' }),
  });
  assert.equal(foreign.status, 403, await foreign.text());
  assert.equal((await view()).mcpReachable, false);

  // 4. con la conferma giusta e dal browser di qui: esposta, e il consenso è datato
  const granted = await api(`/local/sessions/${id}/mcp`, { method: 'POST', body: { allowed: true, confirm: 'bypass-da-esporre' } });
  assert.equal(granted.status, 200, JSON.stringify(granted.json));
  assert.equal(granted.json.session.mcpReachable, true);
  assert.ok(granted.json.session.mcpBypassAt, 'il consenso si sa da quando vale');

  // 5. il registro delle operazioni: la concessione è nel log, con la chat
  const logText = fs.readFileSync(path.join(path.dirname(shared.project), 'test.log'), 'utf8');
  assert.match(logText, /high-privilege exposure/, 'la concessione resta scritta nel log');
  assert.ok(logText.includes(id), 'con la chat a cui si riferisce');

  // 6. la revoca è un gesto solo, e vale subito
  const revoked = await api(`/local/sessions/${id}/mcp`, { method: 'POST', body: { allowed: false } });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.session.mcpReachable, false);
  assert.equal(revoked.json.session.mcpBypassAt, null);
  assert.match(fs.readFileSync(path.join(path.dirname(shared.project), 'test.log'), 'utf8'), /high-privilege exposure revoked/);

  // 7. e cambiare modalità fa cadere il consenso: tornare in bypass richiede una decisione nuova.
  //    È una revoca a tutti gli effetti, quindi dev'essere **registrata** come tale: senza, la
  //    revoca che passa dal gesto più comune sarebbe l'unica che il log non racconta.
  const revokedBefore = (fs.readFileSync(path.join(path.dirname(shared.project), 'test.log'), 'utf8').match(/high-privilege exposure revoked/g) ?? []).length;
  await api(`/local/sessions/${id}/mcp`, { method: 'POST', body: { allowed: true, confirm: 'bypass-da-esporre' } });
  const back = await api(`/local/sessions/${id}/permissions`, { method: 'POST', body: { mode: 'default' } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json.session.mcpBypassAt, null, 'il consenso non si eredita');
  assert.equal(back.json.session.mcpReachable, true, 'ma l esposizione scelta resta, come chat normale');
  const revokedAfter = (fs.readFileSync(path.join(path.dirname(shared.project), 'test.log'), 'utf8').match(/high-privilege exposure revoked/g) ?? []).length;
  assert.equal(revokedAfter, revokedBefore + 1, 'la revoca per cambio modalità non è finita nel log');

  // 8. e il consenso **scade**: un consenso dato una volta e dimenticato non vale per sempre
  await api(`/local/sessions/${id}/permissions`, { method: 'POST', body: { mode: 'bypassPermissions' } });
  await api(`/local/sessions/${id}/mcp`, { method: 'POST', body: { allowed: true, confirm: 'bypass-da-esporre' } });
  assert.equal((await view()).mcpReachable, true);
});
