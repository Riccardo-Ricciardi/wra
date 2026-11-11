import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Il registro quando qualcosa va storto: un file corrotto, una scrittura che non riesce.
//
// Due promesse, e sono quelle che contano:
//   1. **le conversazioni già registrate non si perdono** — nemmeno se il file su disco è rotto,
//      perché lo stato buono è quello in memoria e la versione rotta va messa da parte, non
//      cancellata;
//   2. **niente stati fantasma** — una conversazione che non è riuscita ad arrivare su disco non
//      deve esistere nell'elenco: si vedrebbe, si rinominerebbe, e al riavvio non ci sarebbe più.

const repo = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(name, { statePath = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cc-corrupt-${name}-`));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  const TOKEN = 'token-di-prova-lungo-abbastanza';
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CR_')) delete env[key];
  Object.assign(env, {
    CR_TOKEN: TOKEN,
    CR_PORT: '0',
    CR_STATE_FILE: statePath ?? path.join(root, 'sessions.json'),
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

  // Perché non ci si limita ad aspettare: questa prova porta via l'ACL a un file, e su Windows è
  // l'unica del suo genere. Quando andava storta il messaggio era «il server non si è annunciato: »
  // e basta — il log **vuoto**, nessun codice di uscita, nessun modo di sapere se il processo era
  // morto, se non era mai partito, o se era appeso. Un'attesa che scade senza dire niente costa un
  // giro di diagnosi ogni volta. Adesso si guarda anche l'errore di `spawn` e l'uscita, e il
  // messaggio li porta con sé.
  let spawnError = null;
  serve.on('error', (error) => { spawnError = error.message; });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !/WRA on http/.test(log) && !spawnError && serve.exitCode === null) await sleep(120);
  const port = Number(log.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
  if (!port) {
    throw new Error(`il server non si è annunciato in ${45_000 / 1000}s — `
      + `uscita ${serve.exitCode ?? 'nessuna'}, errore di avvio ${spawnError ?? 'nessuno'}, `
      + `${log.length} caratteri di log: ${log.trim().slice(0, 400) || '(vuoto)'}`);
  }

  const api = (route, body = null) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-cc-remote-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => null) }));

  const close = async () => {
    try { serve.kill(); } catch { /* già morto */ }
    await sleep(300);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try { fs.rmSync(root, { recursive: true, force: true }); return; } catch { await sleep(250); }
    }
  };
  return { root, project, env, api, close, stateFile: env.CR_STATE_FILE };
}

test('registro corrotto a server acceso: si continua a salvare, e nessuna conversazione si perde', async () => {
  const b = await startServer('midrun');
  try {
    const first = await b.api('/local/sessions', { projectPath: b.project, name: 'prima' });
    assert.equal(first.status, 200);
    assert.equal(fs.existsSync(b.stateFile), true);

    // Il file su disco si rompe **mentre il server gira** (disco, editor, un altro programma).
    fs.writeFileSync(b.stateFile, '{ troncato');

    const second = await b.api('/local/sessions', { projectPath: b.project, name: 'dopo-la-corruzione' });
    assert.equal(second.status, 200, `non si salva più niente: ${JSON.stringify(second.json)}`);

    const listed = (await b.api('/local/sessions')).json.sessions.map((session) => session.name).sort();
    assert.deepEqual(listed, ['dopo-la-corruzione', 'prima'], 'una delle due conversazioni è sparita');

    // Su disco c'è tutto: la conversazione nuova **e** quella di prima (lo stato buono era in
    // memoria, e la versione rotta del file non è la verità).
    const onDisk = JSON.parse(fs.readFileSync(b.stateFile, 'utf8'));
    assert.deepEqual(onDisk.sessions.map((session) => session.name).sort(), ['dopo-la-corruzione', 'prima']);
    // E la versione rotta è stata messa da parte, non buttata.
    const quarantined = fs.readdirSync(b.root).filter((name) => name.includes('.corrupt-'));
    assert.equal(quarantined.length, 1, 'il file rotto doveva essere conservato, non sovrascritto');
  } finally {
    await b.close();
  }
});

test('dopo la corruzione, un riavvio ritrova tutte le conversazioni', async () => {
  const b = await startServer('restart');
  try {
    await b.api('/local/sessions', { projectPath: b.project, name: 'una' });
    fs.writeFileSync(b.stateFile, '{ troncato');
    await b.api('/local/sessions', { projectPath: b.project, name: 'due' });
    const port = Number((await b.api('/healthz')).json ? 0 : 0); // (nessun uso: la porta serve solo al server)
    assert.ok(port === 0);

    // Il server si spegne e riparte: quello che sta su disco è quello che si ritrova.
    await b.api('/local/shutdown', {});
    await sleep(1_500);

    const restart = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env: b.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    restart.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
    restart.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !/WRA on http/.test(log)) await sleep(120);
    const newPort = Number(log.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
    assert.ok(newPort, `il server non è ripartito: ${log}`);
    const listed = await fetch(`http://127.0.0.1:${newPort}/local/sessions`, { headers: { 'x-cc-remote-token': b.env.CR_TOKEN } })
      .then((response) => response.json());
    assert.deepEqual(listed.sessions.map((session) => session.name).sort(), ['due', 'una']);
    restart.kill();
  } finally {
    await b.close();
  }
});

// Il 02/11 il server non è partito con «primary and backup invalid» mentre il backup era
// perfettamente sano. La causa non era il JSON: il primario era **illeggibile** (permessi), e
// il recupero finiva nello stesso `catch` il fallimento della lettura del backup e quello dello
// spostamento del primario. Il test riproduce lo stato esatto: si toglie l'ereditarietà dal file,
// che diventa illeggibile **e non spostabile** — su Windows un registro con i permessi rotti.
test('un registro illeggibile non fa credere che manchi il backup', async (t) => {
  if (process.platform !== 'win32') {
    return t.skip("l'ACL che rende un file illeggibile e non spostabile è di Windows");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-corrupt-acl-'));
  const stateFile = path.join(dir, 'sessions.json');
  const entry = (sessionId, name) => ({
    sessionId, name, projectPath: dir, mcpAllowed: false, permissionMode: 'default',
    imported: false, archived: false, createdAt: '2026-10-30T00:00:00.000Z', lastActivityAt: null,
  });
  const state = {
    version: 1,
    savedAt: '2026-10-30T00:00:00.000Z',
    sessions: [entry('11111111-1111-4111-8111-111111111111', 'una'), entry('22222222-2222-4222-8222-222222222222', 'due')],
  };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(`${stateFile}.bak`, JSON.stringify(state));
  execFileSync('icacls', [stateFile, '/inheritance:r']); // niente eredità → DACL vuoto
  assert.throws(() => fs.readFileSync(stateFile), { code: 'EPERM' }, 'la premessa del test non regge: il file è leggibile');

  const b = await startServer('acl', { statePath: stateFile });
  try {
    // Prima promessa: si parte lo stesso, dalle conversazioni del backup. Prima qui il server
    // si rifiutava di partire accusando un backup che era integro.
    const listed = (await b.api('/local/sessions')).json.sessions.map((session) => session.name).sort();
    assert.deepEqual(listed, ['due', 'una'], 'il server doveva caricare il backup invece di rifiutarsi');

    // Seconda promessa: non si scrive sopra un file che forse si poteva ancora leggere. Il
    // salvataggio si rifiuta e lo dice, invece di distruggere l'unica copia più recente.
    const created = await b.api('/local/sessions', { projectPath: b.project, name: 'nuova' });
    assert.equal(created.status, 400, `il salvataggio doveva essere rifiutato: ${JSON.stringify(created.json)}`);
    assert.match(JSON.stringify(created.json), /illeggibile/);
    assert.equal(fs.existsSync(stateFile), true, 'il registro illeggibile è stato tolto di mezzo');
  } finally {
    await b.close();
    execFileSync('icacls', [stateFile, '/reset']);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('una scrittura che non riesce non lascia una conversazione fantasma', async () => {
  // Il registro sta in una cartella che non si può creare (al posto suo c'è un file): ogni
  // scrittura fallisce, e fallisce in modo deterministico.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-corrupt-phantom-'));
  fs.writeFileSync(path.join(root, 'blocco'), 'non sono una cartella');
  const b = await startServer('phantom', { statePath: path.join(root, 'blocco', 'sessions.json') });
  try {
    const seenBefore = (await b.api('/local/sessions')).json.sessions.length;
    assert.equal(seenBefore, 0, 'il registro doveva partire vuoto');

    const attempt = await b.api('/local/sessions', { projectPath: b.project, name: 'fantasma' });
    assert.equal(attempt.status, 400, `la scrittura doveva fallire, invece: ${JSON.stringify(attempt.json)}`);

    // La promessa: non esiste nell'elenco. Prima esisteva — in memoria ma non su disco — e al
    // riavvio spariva senza che nessuno l'avesse cancellata.
    const listed = (await b.api('/local/sessions')).json.sessions.map((session) => session.name);
    assert.deepEqual(listed, [], `c'è una conversazione che non esiste su disco: ${listed.join(', ')}`);
  } finally {
    await b.close();
  }
});
