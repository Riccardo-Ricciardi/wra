import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureServer, ping } from '../src/cli/daemon.mjs';

// Un server solo. Due server sulla stessa macchina non si vedono fra loro: chi apre una chat
// dal terminale non la trova dal telefono, e sembra un guasto invece che un doppio avvio.
// Qui si prova che il secondo non parte, e che `cc` ne accende uno solo.

const repo = path.resolve(import.meta.dirname, '..');
const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Una porta libera, chiesta al sistema e subito restituita. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function serveEnv(root, port, token) {
  return {
    ...process.env,
    CR_TOKEN: token,
    CR_PORT: String(port),
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: root,
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_LOG_FILE: path.join(root, 'daemon.log'),
  };
}

function startServe(root, port, token) {
  const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
    env: serveEnv(root, port, token),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  return { child, log: () => out };
}

async function waitForServe(child, log) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (/WRA on http:\/\//.test(log())) return true;
    if (child.exitCode !== null) return false;
    await SLEEP(100);
  }
  return false;
}

test('con un server acceso, il secondo non accende niente e lo dice', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-daemon-'));
  const port = await freePort();
  const token = 'token-di-prova-lungo-abbastanza';
  const first = startServe(root, port, token);
  const second = { child: null, log: () => '' };

  try {
    assert.equal(await waitForServe(first.child, first.log), true, `il primo non è partito: ${first.log()}`);

    // il secondo `rc serve`, con il primo già acceso: è la cosa che si fa davvero per sbaglio
    Object.assign(second, startServe(root, port, token));
    const code = await new Promise((resolve) => {
      if (second.child.exitCode !== null) return resolve(second.child.exitCode);
      second.child.on('close', resolve);
      setTimeout(() => resolve(null), 15_000).unref();
    });

    assert.equal(code, 0, `il secondo è rimasto acceso: ${second.log()}`);
    assert.match(second.log(), /already running/, second.log());
    assert.equal(/WRA on http/.test(second.log()), false, 'il secondo non deve mettersi in ascolto');

    // e il primo è ancora vivo e risponde
    const alive = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { 'x-cc-remote-token': token } });
    assert.equal(alive.status, 200);
  } finally {
    first.child.kill();
    second.child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureServer: se c è già, non ne accende un altro; se non c è, ne accende uno', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-daemon2-'));
  const port = await freePort();
  const token = 'token-di-prova-lungo-abbastanza';
  // `ensureServer` parte con l'ambiente di questo processo: glielo si prepara come se questi
  // fosse un `cc` lanciato in una cartella di prova.
  const wanted = serveEnv(root, port, token);
  const saved = new Map(Object.keys(wanted).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(wanted)) process.env[key] = value;

  try {
    assert.equal(await ping({ timeoutMs: 500 }), null, 'non deve esserci niente acceso qui');

    // 1. niente acceso: ne parte uno, staccato da questo processo
    const started = await ensureServer({ waitMs: 25_000 });
    assert.equal(started.started, true);
    assert.ok(started.health, 'il server doveva rispondere');

    // 2. acceso: si usa quello, e non se ne accende un secondo
    const again = await ensureServer({ waitMs: 10_000 });
    assert.equal(again.started, false);
    assert.ok(again.health.sessions.length >= 0);

    // 3. e si spegne da qui, come farebbe `rc stop`
    const stopped = await fetch(`http://127.0.0.1:${port}/local/shutdown`, {
      method: 'POST',
      headers: { 'x-cc-remote-token': token },
    });
    assert.equal(stopped.status, 200);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && await ping({ timeoutMs: 500 })) await SLEEP(200);
    assert.equal(await ping({ timeoutMs: 500 }), null, 'dopo lo spegnimento non deve rispondere più');
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Il file che descrive il server acceso sta accanto al **suo** registro. Prima era inchiodato a
// ~/.cc-remote/server.json, quindi una prova che accende un server vero su una porta effimera
// scriveva nel file dell'utente: il pid che ci lasciava era di un server già morto, e `rc stop`
// (che legge lì per il caso del token ruotato) poteva trovare il pid di qualcun altro.
test('un server usa e getta non scrive nel file del server dell\'utente', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-daemon3-'));
  const home = path.join(os.homedir(), '.cc-remote', 'server.json');
  const before = fs.existsSync(home) ? fs.readFileSync(home, 'utf8') : null;
  const port = await freePort();
  const token = 'token-di-prova-lungo-abbastanza';
  const env = serveEnv(root, port, token);
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  let child = null;
  try {
    Object.assign(process.env, env);
    const childProc = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env, stdio: 'ignore' });
    child = childProc;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !fs.existsSync(path.join(root, 'server.json'))) await SLEEP(150);

    const mine = path.join(root, 'server.json');
    assert.ok(fs.existsSync(mine), 'il server non ha scritto il suo file accanto al registro');
    const record = JSON.parse(fs.readFileSync(mine, 'utf8'));
    assert.equal(record.port, port, 'il file del server di prova deve dire la sua porta');

    const now = fs.existsSync(home) ? fs.readFileSync(home, 'utf8') : null;
    assert.equal(now, before, 'il file del server dell\'utente e\' stato toccato');
  } finally {
    try { child?.kill(); } catch { /* già morto */ }
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
