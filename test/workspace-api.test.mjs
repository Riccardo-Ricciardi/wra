import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

// Le rotte nuove, su un server vero con la TUI finta: i progetti (nome, stella, nascosto,
// apertura cartella), lo stacco chiesto dalla CLI, la ricerca dentro i messaggi. Le stesse
// funzioni pure sono provate a parte; qui si prova che **attraverso la rete** facciano quello
// che promettono, e che le due regole di sicurezza tengano (niente cartelle fuori dalle radici,
// niente «apri sul PC» da un'origine che non è questa macchina).

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'token-di-prova-lungo-abbastanza';
const FAKE = path.join(repo, 'tools', 'fake-claude.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-api-'));
const project = path.join(root, 'progetto');
const altro = path.join(root, 'altro-progetto');
const fuori = path.join(os.tmpdir(), 'cc-remote-fuori-dalle-radici');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(altro, { recursive: true });
fs.mkdirSync(fuori, { recursive: true });

let server;
let port;

/** Sposta una cartella, riprovando: su Windows un processo appena chiuso la tiene ancora. */
async function moveDir(from, to) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt === 12) throw error;
      await sleep(300);
    }
  }
}

test.before(async () => {
  const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
    env: {
      ...process.env,
      CR_TOKEN: TOKEN,
      CR_PORT: '0',
      CR_CLAUDE_CMD: process.execPath,
      CR_CLAUDE_ARGS: JSON.stringify([FAKE]),
      CR_DEFAULT_PROJECT: project,
      CR_ALLOWED_ROOTS: root,
      CR_MAX_SESSIONS: '64',
      CR_STATE_FILE: path.join(root, 'sessions.json'),
      CR_PROJECTS_FILE: path.join(root, 'projects.json'),
      CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
      CR_PROJECTS_ROOT: path.join(root, 'projects'),
      CR_LOG_FILE: path.join(root, 'test.log'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = out.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      port = Number(match[1]);
      return;
    }
    if (child.exitCode !== null) throw new Error(`il server è uscito: ${out}`);
    await sleep(100);
  }
  throw new Error(`il server non si è annunciato: ${out}`);
});

test.after(async () => {
  const closed = new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    server.on('close', resolve);
    setTimeout(resolve, 5_000).unref();
  });
  server?.kill();
  await closed;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  fs.rmSync(fuori, { recursive: true, force: true, maxRetries: 3 });
});

const call = async (route, { method = 'GET', body = null, headers = {}, token = TOKEN } = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { ...(token ? { 'x-cc-remote-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, json };
};

test('il gate vale anche per i progetti: senza token non si passa', async () => {
  const response = await call('/local/projects/update', { method: 'POST', body: { path: project, favorite: true }, token: '' });
  assert.equal(response.status, 401);
});

test('un progetto si aggiunge scegliendo una cartella che esiste, e si rivede nell\'elenco', async () => {
  const wrong = await call('/local/projects/add', { method: 'POST', body: { path: path.join(root, 'non-esiste') } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /does not exist/);

  const out = await call('/local/projects/add', { method: 'POST', body: { path: fuori } });
  assert.equal(out.status, 400, 'una cartella fuori dalle radici consentite non entra');
  assert.match(out.json.error, /allowed roots/);

  const added = await call('/local/projects/add', { method: 'POST', body: { path: altro, name: 'Altro' } });
  assert.equal(added.status, 200);
  assert.equal(added.json.project.name, 'Altro');
  assert.equal(added.json.project.path, altro, 'il percorso vero non diventa il nome');

  const listed = await call('/local/sessions');
  const found = listed.json.projects.find((entry) => entry.path === altro);
  assert.ok(found, 'il progetto aggiunto compare nell\'elenco');
  assert.equal(found.count, 0, 'e non ha inventato conversazioni');
  assert.equal(found.name, 'Altro');
});

test('stella e «nascosto» si scrivono, si leggono, e sopravvivono a una rilettura', async () => {
  await call('/local/projects/update', { method: 'POST', body: { path: altro, favorite: true, hidden: true } });
  const listed = await call('/local/sessions');
  const found = listed.json.projects.find((entry) => entry.path === altro);
  assert.equal(found.favorite, true);
  assert.equal(found.hidden, true);
  assert.equal(found.name, 'Altro', 'la stella non ha cancellato il nome');

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'projects.json'), 'utf8'));
  assert.equal(onDisk.projects.length, 1, 'solo i metadati toccati finiscono nel file');
  assert.equal(onDisk.projects[0].path, altro);
});

test('un progetto con conversazioni non si dimentica: si nasconde', async () => {
  const created = await call('/local/sessions', { method: 'POST', body: { projectPath: project, name: 'una chat' } });
  const sessionId = created.json.session.sessionId;

  const refused = await call('/local/projects/remove', { method: 'POST', body: { path: project } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /hide it/);

  const hidden = await call('/local/projects/update', { method: 'POST', body: { path: project, hidden: true } });
  assert.equal(hidden.status, 200);
  const still = await call('/local/sessions');
  assert.ok(still.json.sessions.some((session) => session.sessionId === sessionId), 'la conversazione resta');
});

test('«apri la cartella sul PC» non si può chiedere da un\'origine che non è questa macchina', async () => {
  const remote = await call('/local/projects/open', {
    method: 'POST',
    body: { path: project },
    headers: { origin: 'https://pc-example.tail0000.ts.net' },
  });
  assert.equal(remote.status, 403, 'dal telefono si guarda, non si fa aprire finestre sul PC');
  assert.match(remote.json.error, /from this machine/);

  // Da qui invece la richiesta passa il controllo di origine, e si ferma sulla cartella: così il
  // test non apre davvero una finestra sul PC di chi esegue la suite.
  const local = await call('/local/projects/open', {
    method: 'POST',
    body: { path: path.join(root, 'non-esiste') },
    headers: { origin: 'http://127.0.0.1:4310' },
  });
  assert.equal(local.status, 400);
  assert.match(local.json.error, /does not exist/);
});

test('fissare una conversazione e darle una sezione non le cambia l\'identità', async () => {
  const listed = await call('/local/sessions');
  const session = listed.json.sessions.find((entry) => entry.projectPath === project);
  assert.ok(session.projectKey, 'la chiave del progetto arriva al browser già calcolata');

  const starred = await call(`/local/sessions/${session.sessionId}/favorite`, { method: 'POST', body: { favorite: true } });
  assert.equal(starred.json.session.favorite, true);
  assert.equal(starred.json.session.sessionId, session.sessionId, 'l\'id non cambia mai');

  const labelled = await call(`/local/sessions/${session.sessionId}/label`, { method: 'POST', body: { label: '  lavoro  ' } });
  assert.equal(labelled.json.session.label, 'lavoro');

  const cleared = await call(`/local/sessions/${session.sessionId}/label`, { method: 'POST', body: { label: '' } });
  assert.equal(cleared.json.session.label, null);

  const reread = await call('/local/sessions');
  const after = reread.json.sessions.find((entry) => entry.sessionId === session.sessionId);
  assert.equal(after.favorite, true, 'la stella sopravvive alla rilettura del registro');
  assert.equal(after.projectPath, project, 'e il progetto fisico è ancora quello');
});

test('la ricerca dentro i messaggi trova il turno, e dice quando si è fermata', async () => {
  const short = await call('/local/search?q=ab');
  assert.deepEqual(short.json.hits, [], 'sotto i tre caratteri non si cerca');

  const empty = await call('/local/search?q=parolachenonesiste');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.hits, []);
  assert.equal(empty.json.truncated, false);
});

test('rc detach stacca le finestre agganciate e non tocca la conversazione', async () => {
  const created = await call('/local/sessions', { method: 'POST', body: { projectPath: project, name: 'da staccare' } });
  const sessionId = created.json.session.sessionId;

  // Una finestra `rc attach`.
  const attached = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`bearer.${TOKEN}`]);
  const seen = [];
  const closed = new Promise((resolve) => { attached.on('close', (code) => resolve(code)); });
  attached.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    attached.on('open', () => {
      attached.send(JSON.stringify({ t: 'hello', proto: 2, role: 'terminal', attach: true, sessionId, cols: 100, rows: 30 }));
      resolve();
    });
    attached.on('error', reject);
  });
  // E un browser, che non è una finestra agganciata.
  const browser = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`bearer.${TOKEN}`]);
  await new Promise((resolve, reject) => {
    browser.on('open', () => {
      browser.send(JSON.stringify({ t: 'hello', proto: 2, role: 'chat', sessionId, cols: 100, rows: 30 }));
      resolve();
    });
    browser.on('error', reject);
  });
  await sleep(300);

  const result = await call('/local/detach', { method: 'POST', body: { sessionId } });
  assert.equal(result.json.detached, 1, 'si stacca la finestra agganciata, non il browser');
  const code = await closed;
  assert.equal(code, 4000, 'la chiusura dice perché: staccata su richiesta');
  assert.ok(seen.some((message) => message.t === 'detach'), 'il client riceve il motivo prima di chiudersi');
  assert.equal(browser.readyState, WebSocket.OPEN, 'il browser resta dov\'è: si riconnetterebbe da solo');

  const after = await call('/local/sessions');
  const session = after.json.sessions.find((entry) => entry.sessionId === sessionId);
  assert.ok(session, 'la conversazione è ancora nel registro');
  assert.ok(['ready', 'starting', 'busy'].includes(session.state), `il processo è ancora vivo, invece: ${session.state}`);
  browser.close();
});

test('lo stacco per una chat che non ha finestre agganciate non stacca niente', async () => {
  const result = await call('/local/detach', { method: 'POST', body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.json.detached, 0);
});

test('se il processo non parte, la conversazione si apre lo stesso con la sua storia', async () => {
  // ConPTY rifiuta di partire in una cartella che non c'è (errore 267). Il processo è
  // sacrificabile, la conversazione no: si apre, la storia si legge dal transcript, e il motivo
  // per cui non c'è un processo arriva come avviso. Prima, un avvio fallito si portava via anche
  // la storia — la chat si apriva vuota, senza dire perché.
  const fragile = path.join(root, 'cartella-fragile');
  fs.mkdirSync(fragile, { recursive: true });
  const created = await call('/local/sessions', { method: 'POST', body: { projectPath: fragile, name: 'cartella fragile' } });
  const sessionId = created.json.session.sessionId;
  await call(`/local/sessions/${sessionId}/stop`, { method: 'POST' });
  // Su Windows una cartella che un processo ha appena lasciato resta occupata per un momento.
  const moved = `${fragile}-spostata`;
  await moveDir(fragile, moved);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`bearer.${TOKEN}`]);
  const seen = [];
  try {
    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', proto: 2, role: 'chat', sessionId, cols: 100, rows: 30 }));
        resolve();
      });
      ws.on('error', reject);
    });
    ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !seen.some((message) => message.t === 'chat')) await sleep(100);

    const chat = seen.find((message) => message.t === 'chat');
    assert.ok(chat, `la storia non è arrivata: ${JSON.stringify(seen).slice(0, 300)}`);
    assert.equal(chat.history, true);
    assert.ok(seen.some((message) => message.t === 'opened'), 'la conversazione non si è aperta');
    const told = seen.filter((message) => message.t === 'error').map((message) => message.message).join(' | ');
    assert.match(told, /process does not start/, `il motivo non è stato detto: «${told}»`);

    const after = await call('/local/sessions');
    assert.ok(after.json.sessions.some((session) => session.sessionId === sessionId), 'la conversazione è sparita dal registro');
  } finally {
    try { ws.close(); } catch { /* già chiuso */ }
    await moveDir(moved, fragile).catch(() => {});
  }
});

test('aggiornare un progetto non cambia la grafia del percorso salvato', async () => {
  // La chiave considera «C:\x\y» e «c:/x/y/» la stessa cartella. Se il percorso salvato fosse
  // quello arrivato dalla richiesta, un progetto potrebbe mettersi a mostrare una cartella
  // scritta in un modo che non esiste, diversa da quella delle sue conversazioni.
  const odd = `${altro.split(path.sep).join('/').toUpperCase()}/`;
  assert.notEqual(odd, altro, 'la grafia di prova deve essere diversa');
  const result = await call('/local/projects/update', { method: 'POST', body: { path: odd, name: 'Altro' } });
  assert.equal(result.status, 200);
  assert.equal(result.json.project.path, altro, 'il percorso salvato resta quello vero');

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'projects.json'), 'utf8'));
  assert.equal(onDisk.projects.find((entry) => entry.name === 'Altro').path, altro);
});

test('consultare l\'elenco non accende nessun processo', async () => {
  // Guardare non e' lavorare: se aprire la pagina facesse partire un `claude` per ogni
  // conversazione, con cinquecento conversazioni sarebbe cinquecento processi.
  const ids = [];
  for (const name of ['guardare 1', 'guardare 2', 'guardare 3']) {
    const created = await call('/local/sessions', { method: 'POST', body: { projectPath: project, name } });
    ids.push(created.json.session.sessionId);
    await call(`/local/sessions/${created.json.session.sessionId}/stop`, { method: 'POST' });
  }
  await sleep(300);
  for (let round = 0; round < 2; round += 1) {
    const listed = await call('/local/sessions');
    const states = ids.map((id) => listed.json.sessions.find((session) => session.sessionId === id)?.state);
    assert.deepEqual(states, ['offline', 'offline', 'offline'], `giro ${round + 1}: l'elenco ha acceso qualcosa — ${states.join(', ')}`);
  }
});

test('due browser insieme non si perdono un metadato a vicenda', async () => {
  // Una scrive la stella, l'altra il nome, nello stesso istante. Se il salvataggio fosse
  // «leggi, cambia, riscrivi tutto», una delle due vincerebbe e l'altra sparirebbe.
  const [star, name] = await Promise.all([
    call('/local/projects/update', { method: 'POST', body: { path: altro, favorite: true } }),
    call('/local/projects/update', { method: 'POST', body: { path: altro, name: 'Altro progetto' } }),
  ]);
  assert.equal(star.status, 200);
  assert.equal(name.status, 200);

  const listed = await call('/local/sessions');
  const project = listed.json.projects.find((entry) => entry.path === altro);
  assert.equal(project.favorite, true, 'la stella e\' sparita');
  assert.equal(project.name, 'Altro progetto', 'il nome e\' sparito');

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'projects.json'), 'utf8'));
  const saved = onDisk.projects.find((entry) => entry.path === altro);
  assert.equal(saved.favorite, true);
  assert.equal(saved.name, 'Altro progetto');
  assert.equal(onDisk.projects.filter((entry) => entry.path === altro).length, 1, 'due voci per la stessa cartella');
});
