import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// `rc status` legge /healthz: `turns` è un oggetto {sessions, stuck}, non un elenco di turni.
// Se lo si tratta da elenco, `find` non esiste e il comando muore con uno stack trace — proprio
// quando serve di più, cioè per capire cosa sta girando.

const repo = path.resolve(import.meta.dirname, '..');
const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

test('rc status: legge i turni da /healthz senza inciampare, e stampa le chat', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-status-'));
  const port = await freePort();
  const token = 'token-di-prova-lungo-abbastanza';
  const env = {
    ...process.env,
    CR_TOKEN: token,
    CR_PORT: String(port),
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: root,
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_LOG_FILE: path.join(root, 'serve.log'),
  };

  const server = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.setEncoding('utf8').on('data', (chunk) => { serverLog += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { serverLog += chunk; });

  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !/WRA on http:\/\//.test(serverLog)) {
      if (server.exitCode !== null) break;
      await SLEEP(100);
    }
    assert.match(serverLog, /WRA on http:\/\//, `il server non è partito: ${serverLog}`);

    // Una chat che aspetta in coda: è la riga che leggeva `turns` nel modo sbagliato.
    await fetch(`http://127.0.0.1:${port}/local/sessions`, {
      method: 'POST',
      headers: { 'x-cc-remote-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const status = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'status.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
      child.on('close', (code) => resolve({ code, out }));
    });

    assert.equal(status.code, 0, `rc status è uscito con ${status.code}: ${status.out}`);
    assert.doesNotMatch(status.out, /is not a function/, status.out);
    assert.match(status.out, /server: .* — up/, status.out);
    assert.match(status.out, /MCP bridge: (up|down)/, status.out);
    assert.match(status.out, /chats: \d+ \(\d+ busy\)/, status.out);
  } finally {
    const closed = new Promise((resolve) => {
      if (server.exitCode !== null) return resolve();
      server.on('close', resolve);
      setTimeout(resolve, 5_000).unref();
    });
    server.kill();
    await closed;
    // Su Windows il file di stato resta bloccato per un attimo dopo la chiusura.
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 10) throw error;
        await SLEEP(200);
      }
    }
  }
});

// ── la versione ───────────────────────────────────────────────────────────────────────────────
// Una versione scritta in due posti è una versione che prima o poi dice due cose diverse, e la
// volta che succede il numero che si legge è quello sbagliato. Qui si controlla che `rc --version`
// e `package.json` dicano la stessa cosa, perché è l'unica che il rilascio deve cambiare.

test('`rc --version` dice la versione di package.json, e non una sua copia', async () => {
  const attesa = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  const uscita = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'index.mjs'), '--version'], { encoding: 'utf8' });
    let testo = '';
    child.stdout.on('data', (chunk) => { testo += chunk; });
    child.on('close', () => resolve(testo.trim()));
  });
  assert.equal(uscita, `WRA ${attesa}`);
  assert.match(attesa, /^\d+\.\d+\.\d+$/, `la versione non ha la forma di una versione: ${attesa}`);
});
