import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Spegnere il server, e **non** spegnere altro.
//
// Il caso pericoloso è il recupero: quando il token è stato ruotato, `rc stop` non può parlare col
// server e deve uccidere un processo di cui conosce solo il pid. I pid si riusano — è la norma — e
// un pid riusato può essere un programma di qualcun altro. Questi test sorvegliano che quel
// processo non venga toccato, e che la strada buona (quella verificata) continui a funzionare.

const repo = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const alive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

/** Un processo vivo e innocente da mettere al posto del server, per vedere se `rc stop` lo tocca. */
function innocent() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return child;
}

const run = (root, port) => new Promise((resolve) => {
  const env = { ...process.env, CR_STATE_FILE: path.join(root, 'sessions.json'), CR_PORT: String(port) };
  for (const key of Object.keys(env)) if (key.startsWith('CR_') && !['CR_STATE_FILE', 'CR_PORT'].includes(key)) delete env[key];
  const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'stop.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.on('close', (code) => resolve({ code, out }));
});

function sandbox(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cc-stop-${name}-`));
  return {
    root,
    serverFile: path.join(root, 'server.json'),
    write: (record) => fs.writeFileSync(path.join(root, 'server.json'), `${JSON.stringify(record, null, 2)}\n`),
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('un pid riusato non si tocca: si verifica l\'identità, non il numero', async () => {
  const b = sandbox('stale');
  const victim = innocent();
  try {
    // Il pid è vivo, ma è stato avviato adesso: non è il server che dicevamo (avviato nel 2020).
    b.write({ pid: victim.pid, host: '127.0.0.1', port: 4711, startedAt: '2020-01-01T00:00:00.000Z' });
    const result = await run(b.root, 4711);

    assert.equal(result.code, 1);
    assert.match(result.out, /belongs to another process/, `non ha riconosciuto il pid riusato: ${result.out}`);
    assert.match(result.out, /not touching it/);
    await sleep(500);
    assert.equal(alive(victim.pid), true, 'ha ucciso un processo che non era il suo');
    assert.equal(fs.existsSync(b.serverFile), false, 'il riferimento vecchio va tolto');
  } finally {
    victim.kill();
    b.close();
  }
});

test('senza poter verificare chi sia, non si uccide niente', async () => {
  const b = sandbox('unverifiable');
  try {
    // Un pid che non esiste: non si può sapere chi sia (o chi fosse), quindi non si tocca nulla.
    b.write({ pid: 999_999, host: '127.0.0.1', port: 4711, startedAt: '2026-01-01T00:00:00.000Z' });
    const result = await run(b.root, 4711);
    assert.equal(result.code, 1);
    assert.match(result.out, /cannot verify/, `non ha detto di non poter verificare: ${result.out}`);
    // Il riferimento resta: un secondo tentativo deve poterlo ancora trovare.
    assert.equal(fs.existsSync(b.serverFile), true);
  } finally {
    b.close();
  }
});

test('con l\'identità verificata, il recupero funziona ancora', async () => {
  const b = sandbox('verified');
  const victim = innocent();
  try {
    // Qui il pid **è** quello giusto: ora di avvio vera, come l'avrebbe scritta il server.
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    b.write({ pid: victim.pid, host: '127.0.0.1', port: 4711, startedAt });
    const result = await run(b.root, 4711);

    assert.equal(result.code, 0, `il recupero non ha funzionato: ${result.out}`);
    assert.match(result.out, /stopped by force/);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && alive(victim.pid)) await sleep(200);
    assert.equal(alive(victim.pid), false, 'il processo verificato doveva essere fermato');
    assert.equal(fs.existsSync(b.serverFile), false);
  } finally {
    try { victim.kill(); } catch { /* già morto */ }
    b.close();
  }
});

test('senza riferimento e senza server, si dice e basta', async () => {
  const b = sandbox('nothing');
  try {
    const result = await run(b.root, 4712);
    assert.equal(result.code, 1);
    assert.match(result.out, /does not answer/);
    assert.ok(!/stopped by force/.test(result.out), 'non deve aver fermato niente');
  } finally {
    b.close();
  }
});

test('lo spegnimento chiesto è pulito: il processo esce da solo e toglie il suo riferimento', async () => {
  // Il difetto che questo test chiude: lo spegnimento passava da `process.kill(process.pid,'SIGTERM')`,
  // che su Windows è `TerminateProcess` — nessuna pulizia, e `server.json` restava lì a indicare un
  // pid che non era più suo. Da lì il recupero di `rc stop` poteva uccidere un processo estraneo.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-stop-clean-'));
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
  const serverFile = path.join(root, 'server.json');
  assert.equal(fs.existsSync(serverFile), true, 'il server acceso deve registrare il suo pid');

  try {
    // Una chat viva: allo spegnimento il suo PTY dev'essere chiuso, non abbandonato.
    await fetch(`http://127.0.0.1:${port}/local/sessions`, {
      method: 'POST',
      headers: { 'x-cc-remote-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: project, name: 'viva' }),
    });
    await sleep(1_000);

    const response = await fetch(`http://127.0.0.1:${port}/local/shutdown`, { method: 'POST', headers: { 'x-cc-remote-token': TOKEN } });
    assert.equal(response.status, 200);

    const closed = new Promise((resolve) => serve.on('close', resolve));
    const code = await Promise.race([closed, sleep(10_000).then(() => 'timeout')]);
    assert.notEqual(code, 'timeout', 'il server non è uscito');
    assert.equal(code, 0, `è uscito con codice ${code}: non è stato uno spegnimento ordinato`);
    assert.equal(fs.existsSync(serverFile), false, 'il riferimento è rimasto: la prossima `rc stop` potrebbe uccidere un estraneo');
  } finally {
    try { serve.kill(); } catch { /* già morto */ }
    await sleep(300);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await sleep(250); }
    }
  }
});
