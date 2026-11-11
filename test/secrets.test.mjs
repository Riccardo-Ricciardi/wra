import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

// Il token non deve uscire da nessuna porta che non sia quella giusta.
//
// Un test così esiste perché il token **è già uscito una volta**: `rc serve` lo stampava
// all'avvio, ed è finito nei log e nei transcript. Qui si guarda ogni risposta — corpo e
// intestazioni — e il file di log, mentre si fanno anche le cose che lo fanno sbagliare:
// chiedere senza token, sbagliarlo, provare a indovinarlo.

const TOKEN = 'token-di-prova-lungo-abbastanza';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('il token non compare in nessuna risposta né nel log', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-secrets-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logFile = path.join(root, 'server.log');

  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'cli', 'serve.mjs')], {
    env: {
      ...process.env,
      CR_TOKEN: TOKEN,
      CR_PORT: String(port),
      CR_ISSUER_URL: origin,
      CR_RESOURCE_URL: `${origin}/mcp`,
      CR_STATE_FILE: path.join(root, 'sessions.json'),
      CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
      CR_PROJECTS_ROOT: path.join(root, 'projects'),
      CR_ALLOWED_ROOTS: root,
      CR_DEFAULT_PROJECT: project,
      CR_LOG_FILE: logFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/WRA on http:\/\//.test(stdout)) await sleep(100);
  assert.match(stdout, /WRA on http:\/\//, `server non partito: ${stdout}`);
  assert.equal(stdout.includes(TOKEN), false, 'e all avvio non lo stampa');

  try {
    const seen = [];
    const record = (label, response, body) => seen.push({ label, headers: JSON.stringify([...response.headers]), body: String(body) });

    // 1. percorsi pubblici, senza credenziali e con credenziali sbagliate
    for (const [label, route, options] of [
      ['/ (interfaccia)', '/', {}],
      ['/app.js', '/app.js', {}],
      ['/local/sessions senza token', '/local/sessions', {}],
      ['/local/sessions token sbagliato', '/local/sessions', { headers: { 'x-cc-remote-token': 'sbagliato-di-lunghezza-simile-000000000000000000' } }],
      ['/healthz senza token', '/healthz', {}],
      ['/mcp senza bearer', '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
      ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server', {}],
      ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource/mcp', {}],
      ['/authorize', '/authorize?response_type=code&client_id=nessuno', {}],
      ['/register rifiutato', '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) }],
      ['/token senza grant', '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code' }],
      ['/local/approvals senza token', '/local/approvals', {}],
    ]) {
      const response = await fetch(`${origin}${route}`, options);
      record(label, response, await response.text().catch(() => ''));
    }

    // 2. login sbagliato: è il posto dove un messaggio d'errore potrebbe dire troppo
    const badLogin = await fetch(`${origin}/authorize/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'tentativo-sbagliato', next: '/authorize' }).toString(),
      redirect: 'manual',
    });
    record('login sbagliato', badLogin, await badLogin.text());

    // 3. websocket: upgrade rifiutato, e token nel sotto-protocollo (che non deve finire in chiaro
    //    da nessuna parte se non nella richiesta)
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`bearer.${TOKEN}sbagliato`]);
      ws.on('error', () => {});
      ws.on('close', resolve);
      setTimeout(resolve, 3_000);
    });

    // 4. e si guarda cosa è finito nel log
    await sleep(500);
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';

    const leaks = [];
    for (const entry of seen) {
      if (entry.body.includes(TOKEN)) leaks.push(`corpo di ${entry.label}`);
      if (entry.headers.includes(TOKEN)) leaks.push(`intestazioni di ${entry.label}`);
    }
    if (log.includes(TOKEN)) leaks.push('file di log');
    if (stdout.includes(TOKEN)) leaks.push('stdout del server');

    assert.deepEqual(leaks, [], `il token è uscito da: ${leaks.join(', ')}`);
    assert.ok(seen.length >= 12, 'e si sono guardate davvero tutte le risposte');
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un token troppo corto non viene accettato come configurazione', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-secrets-short-'));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'cli', 'serve.mjs')], {
    env: { ...process.env, CR_TOKEN: 'corto', CR_PORT: '0', CR_STATE_FILE: path.join(root, 's.json'), CR_LOG_FILE: path.join(root, 'log') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 1, 'un token scelto a mano e corto ferma l avvio: è l unica serratura');
  assert.match(out, /too short/);
  fs.rmSync(root, { recursive: true, force: true });
});
