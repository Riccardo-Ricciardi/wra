import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.mjs';
import { createRegistry, transcriptFor } from '../src/host/session-registry.mjs';

// Il processo di una conversazione: chi vive, chi muore, e chi non deve restare orfano.
//
// Il difetto che questi test sorvegliano è una **corsa**: `stop()` seguito da `start()` (cambio di
// modalità dei permessi, riavvio di una chat) lascia in giro il processo vecchio, che muore un
// istante dopo. La sua uscita cancellava la voce del processo **nuovo**: da lì la chat risultava
// senza processo — non scrivibile, e con un secondo `--resume` pronto a partire sulla stessa
// conversazione. Due processi su una conversazione sono esattamente quello che il registro esiste
// per impedire.

const repo = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Vivo = c'è un processo, e non è marcato come finito. */
const live = (registry, id) => {
  const view = registry.get(id);
  return Boolean(registry.runtime(id)) && view.state !== 'exited' && view.state !== 'offline';
};

/**
 * Un processo finto di cui si può decidere **quando** esce: ogni processo avviato conserva la
 * callback d'uscita che il registro gli ha dato, così il test può farla scattare *dopo* che la
 * sessione è passata a un processo nuovo — che è esattamente quello che succede quando il
 * processo vecchio muore in ritardo.
 */
function controllableSpawn(launches) {
  return ({ projectDir, args, onExit }) => {
    const record = {
      projectDir,
      args,
      killed: false,
      exited: false,
      written: [],
      die: (exitCode = 0) => { record.exited = true; onExit({ exitCode }); },
    };
    launches.push(record);
    return {
      projectDir,
      pid: 1000 + launches.length,
      get exited() { return record.exited; },
      write(data) { record.written.push(data); },
      resize() {},
      kill() { record.killed = true; record.exited = true; },
      onData() { return () => {}; },
      onExit() { return () => {}; },
    };
  };
}

function bench(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cc-process-${name}-`));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  const launches = [];
  const registry = createRegistry({
    config: {
      ...loadConfig({}),
      allowedRoots: [root],
      stateFile: path.join(root, 'sessions.json'),
      projectsRoot: path.join(root, 'projects'),
      claudeCmd: 'claude',
      claudeArgs: [],
      permissionMode: 'default',
      replayBytes: 1024,
      port: 4310,
      token: 'token-di-prova',
      hooks: false,
      home: root,
    },
    spawn: controllableSpawn(launches),
  });
  return {
    root,
    project,
    launches,
    registry,
    close: () => { registry.closeAll(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('l\'uscita tardiva del processo vecchio non tocca quello nuovo', () => {
  const b = bench('late-exit');
  try {
    const created = b.registry.create({ projectPath: b.project, name: 'una' });
    const first = b.launches.at(-1);

    // stop + start nello stesso giro: è quello che fa il cambio di modalità dei permessi.
    b.registry.stop(created.sessionId);
    b.registry.start(created.sessionId);
    const second = b.launches.at(-1);
    assert.equal(b.launches.length, 2, 'dopo il riavvio ci dev\'essere un processo solo, il nuovo');
    assert.ok(live(b.registry, created.sessionId), 'la sessione non ha un processo vivo');

    // Il processo **vecchio** finisce di morire adesso, e chiama la sua uscita.
    first.die(0);

    assert.ok(live(b.registry, created.sessionId), 'l\'uscita del vecchio ha cancellato il processo nuovo');
    assert.equal(b.registry.get(created.sessionId).pid, 1000 + b.launches.length, 'il processo tracciato non è quello nuovo');
    assert.equal(b.launches.length, 2, 'non deve essere partito un terzo processo');
    assert.equal(second.killed, false, 'il processo nuovo è stato ucciso senza motivo');
  } finally {
    b.close();
  }
});

test('quando muore il processo vivo, la sessione lo dice — e riaccenderla riparte', () => {
  const b = bench('real-death');
  try {
    const created = b.registry.create({ projectPath: b.project, name: 'morte' });
    b.launches.at(-1).die(3);
    const after = b.registry.get(created.sessionId);
    assert.equal(after.state, 'exited', 'una morte deve leggersi come morte');
    assert.equal(after.pid, null);

    // Riparte senza `--resume`: il transcript non esiste, e inventare una ripresa sarebbe
    // fingere una continuità che non c'è.
    b.registry.start(created.sessionId);
    assert.ok(live(b.registry, created.sessionId), 'non è ripartita');
    assert.equal(b.launches.length, 2);
    assert.ok(!b.launches.at(-1).args.includes('--resume'));
    assert.ok(b.launches.at(-1).args.includes('--session-id'));

    // Con il transcript al suo posto, invece, riprende **la stessa** conversazione. (Al registro
    // basta che esista: è `claude` a leggerlo.)
    b.registry.stop(created.sessionId);
    const transcript = transcriptFor(b.registry.get(created.sessionId), path.join(b.root, 'projects'));
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, 'una riga qualsiasi');
    b.registry.start(created.sessionId);
    assert.ok(b.launches.at(-1).args.includes('--resume'));
    assert.ok(b.launches.at(-1).args.includes(created.sessionId));
  } finally {
    b.close();
  }
});

test('una chat fermata e riaccesa resta la stessa conversazione', () => {
  const b = bench('restart');
  try {
    const created = b.registry.create({ projectPath: b.project, name: 'due' });
    b.registry.stop(created.sessionId);
    assert.equal(b.registry.runtime(created.sessionId), null);
    assert.equal(b.registry.get(created.sessionId).state, 'offline', 'uno stop chiesto non è una morte');

    b.registry.start(created.sessionId);
    const after = b.registry.get(created.sessionId);
    assert.equal(after.sessionId, created.sessionId, 'l\'id non cambia');
    assert.ok(live(b.registry, created.sessionId));
    assert.equal(b.launches.length, 2);
  } finally {
    b.close();
  }
});

// ── e adesso lo stesso, attraverso la rete, con processi veri ────────────────
test('cambiare la modalità dei permessi non lascia la chat senza processo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-process-api-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  const TOKEN = 'token-di-prova-lungo-abbastanza';
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CR_')) delete env[key];
  Object.assign(env, {
    CR_TOKEN: TOKEN,
    CR_PORT: '0',
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_PROJECTS_FILE: path.join(root, 'projects.json'),
    CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: project,
    CR_LOG_FILE: path.join(root, 'serve.log'),
    CR_CLAUDE_CMD: process.execPath,
    CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
  });

  const serve = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  serve.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  serve.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/WRA on http/.test(log)) await sleep(120);
  const port = Number(log.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
  assert.ok(port, `il server non si è annunciato: ${log}`);

  const api = (route, body = null) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-cc-remote-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((response) => response.json());

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`bearer.${TOKEN}`]);
  const seen = [];
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  try {
    const created = await api('/local/sessions', { projectPath: project, name: 'modalità' });
    const id = created.session.sessionId;
    ws.send(JSON.stringify({ t: 'hello', proto: 2, role: 'terminal', sessionId: id, cols: 100, rows: 30 }));
    await sleep(1_500);

    const before = (await api('/local/sessions')).sessions.find((session) => session.sessionId === id);
    assert.equal(before.state, 'ready', `la sessione non è pronta: ${before.state}`);

    // 1. Cambio di modalità: dentro fa stop() + start(), cioè la corsa.
    await api(`/local/sessions/${id}/permissions`, { mode: 'acceptEdits' });
    await sleep(3_000);

    const after = (await api('/local/sessions')).sessions.find((session) => session.sessionId === id);
    assert.equal(after.state, 'ready', `dopo il cambio di modalità la chat è «${after.state}»: è la corsa che la lascia senza processo`);
    assert.ok(after.pid, 'la sessione non ha un processo');
    assert.notEqual(after.pid, before.pid, 'il processo deve essere quello nuovo');

    // 2. L'input deve arrivare: se `runtime()` fosse nullo verrebbe scartato in silenzio.
    const from = seen.length;
    ws.send(JSON.stringify({ t: 'input', data: 'prova-dopo-il-riavvio\r' }));
    const until = Date.now() + 8_000;
    let echoed = false;
    while (Date.now() < until && !echoed) {
      echoed = seen.slice(from).some((message) => message.t === 'output' && /prova-dopo-il-riavvio/.test(message.data));
      await sleep(200);
    }
    assert.ok(echoed, 'l\'input è stato scartato: la chat non ha un processo vivo');

    // 3. E `stop` deve raggiungerla davvero.
    await api(`/local/sessions/${id}/stop`, {});
    await sleep(1_200);
    const stopped = (await api('/local/sessions')).sessions.find((session) => session.sessionId === id);
    assert.equal(stopped.state, 'offline', `dopo lo stop lo stato è «${stopped.state}»`);
    assert.equal(stopped.pid, null, 'il processo è rimasto attaccato');

    // 4. Riaccesa: stessa conversazione, un processo solo. «Pronta» arriva col primo disegno
    // della TUI, quindi si aspetta invece di pretendere che sia già così.
    const restarted = await api(`/local/sessions/${id}/start`, {});
    assert.equal(restarted.session.sessionId, id, 'l\'id non cambia mai');
    const ready = Date.now() + 10_000;
    let state = restarted.session.state;
    while (Date.now() < ready && state === 'starting') {
      state = (await api('/local/sessions')).sessions.find((session) => session.sessionId === id)?.state;
      await sleep(200);
    }
    assert.equal(state, 'ready', `dopo la riaccensione lo stato è «${state}»`);
  } finally {
    try { ws.close(); } catch { /* già chiuso */ }
    serve.kill();
    await sleep(400);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await sleep(250); }
    }
  }
});

// ── un client che sbaglia paga da solo ───────────────────────────────────────
test('un frame oltre il limite chiude quella connessione, non il server', async () => {
  // Prima: `error` sul socket senza ascoltatore = eccezione non gestita = processo morto. Un solo
  // client abbatteva il server, e con lui le conversazioni di tutti.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ws-oversize-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  const TOKEN = 'token-di-prova-lungo-abbastanza';
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CR_')) delete env[key];
  Object.assign(env, {
    CR_TOKEN: TOKEN,
    CR_PORT: '0',
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_PROJECTS_FILE: path.join(root, 'projects.json'),
    CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: project,
    CR_LOG_FILE: path.join(root, 'serve.log'),
    CR_CLAUDE_CMD: process.execPath,
    CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
  });

  const serve = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  serve.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  serve.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/WRA on http/.test(log)) await sleep(120);
  const port = Number(log.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
  assert.ok(port, `il server non si è annunciato: ${log}`);

  const good = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`bearer.${TOKEN}`]);
  const goodSeen = [];
  good.on('message', (raw) => goodSeen.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { good.on('open', resolve); good.on('error', reject); });

  try {
    const rude = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`bearer.${TOKEN}`]);
    const rudeClosed = new Promise((resolve) => rude.on('close', (code) => resolve(code)));
    rude.on('error', () => {});
    await new Promise((resolve, reject) => { rude.on('open', resolve); rude.on('error', reject); });
    rude.send('x'.repeat(5 * 1024 * 1024));

    const code = await Promise.race([rudeClosed, sleep(8_000).then(() => 'timeout')]);
    assert.notEqual(code, 'timeout', 'la connessione maleducata non è stata chiusa');
    assert.equal(serve.exitCode, null, 'il server è morto per colpa di un client');

    // Il server risponde ancora, e l'altro client è ancora collegato e servito.
    const health = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { 'x-cc-remote-token': TOKEN } });
    assert.equal(health.status, 200, 'il server non risponde più');
    const from = goodSeen.length;
    good.send(JSON.stringify({ t: 'sessions' }));
    const back = Date.now() + 5_000;
    while (Date.now() < back && goodSeen.slice(from).length === 0) await sleep(150);
    assert.ok(goodSeen.slice(from).some((message) => message.t === 'sessions'), 'l\'altro client non riceve più niente');
  } finally {
    try { good.close(); } catch { /* già chiuso */ }
    serve.kill();
    await sleep(400);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await sleep(250); }
    }
  }
});

test('scrivere in una conversazione senza processo non sparisce nel nulla', async () => {
  // Prima l'input veniva scartato in silenzio: chi scriveva vedeva i tasti sparire, senza un
  // messaggio e senza capire che la conversazione non aveva più un processo.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dead-input-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  const TOKEN = 'token-di-prova-lungo-abbastanza';
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CR_')) delete env[key];
  Object.assign(env, {
    CR_TOKEN: TOKEN,
    CR_PORT: '0',
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_PROJECTS_FILE: path.join(root, 'projects.json'),
    CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: project,
    CR_LOG_FILE: path.join(root, 'serve.log'),
    CR_CLAUDE_CMD: process.execPath,
    CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
  });

  const serve = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  serve.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  serve.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/WRA on http/.test(log)) await sleep(120);
  const port = Number(log.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
  assert.ok(port, `il server non si è annunciato: ${log}`);

  const api = (route, body = null) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-cc-remote-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((response) => response.json());

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`bearer.${TOKEN}`]);
  const seen = [];
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

  try {
    const created = await api('/local/sessions', { projectPath: project, name: 'senza processo' });
    const id = created.session.sessionId;
    ws.send(JSON.stringify({ t: 'hello', proto: 2, role: 'terminal', sessionId: id, cols: 100, rows: 30 }));
    await sleep(1_000);
    await api(`/local/sessions/${id}/stop`, {});
    await sleep(800);

    const from = seen.length;
    ws.send(JSON.stringify({ t: 'input', data: 'ciao' }));
    const until = Date.now() + 6_000;
    let told = null;
    while (Date.now() < until && !told) {
      told = seen.slice(from).find((message) => message.t === 'error')?.message ?? null;
      await sleep(150);
    }
    assert.ok(told, 'l\'input è sparito senza dire niente');
    assert.match(told, /no running process/, `il messaggio non spiega cosa manca: ${told}`);
  } finally {
    try { ws.close(); } catch { /* già chiuso */ }
    serve.kill();
    await sleep(400);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await sleep(250); }
    }
  }
});
