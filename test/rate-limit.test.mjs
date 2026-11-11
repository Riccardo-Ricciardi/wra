import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createRateLimiter } from '../src/net/rate-limit.mjs';

// Due cose diverse, stesso meccanismo: non farsi indovinare il token, e non farsi riempire la
// memoria. Qui si prova il contatore, e poi che sia davvero montato sul percorso pubblico.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('il contatore chiude la porta quando si insiste, e la riapre dopo la finestra', () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ max: 3, windowMs: 1_000, now: () => clock });

  for (let i = 0; i < 3; i += 1) assert.equal(limiter.check('a').ok, true, `tentativo ${i + 1}`);
  const blocked = limiter.check('a');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1_000, 'e dice fra quanto riprovare');

  // un'altra origine non paga per questa
  assert.equal(limiter.check('b').ok, true);

  clock += 1_001;
  assert.equal(limiter.check('a').ok, true, 'passata la finestra, si riparte');
});

test('le chiavi vecchie non si accumulano: la memoria non cresce senza fine', () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ max: 5, windowMs: 100, now: () => clock, maxKeys: 10 });
  for (let i = 0; i < 50; i += 1) limiter.check(`origine-${i}`);
  assert.ok(limiter.size() <= 12, `chiavi tenute: ${limiter.size()}`);

  clock += 200; // tutte scadute
  limiter.check('nuova');
  assert.ok(limiter.size() <= 3, `dopo la pulizia: ${limiter.size()}`);
});

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('il percorso pubblico è limitato davvero (MCP, token, registrazione)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rate-'));
  const project = path.join(root, 'p');
  fs.mkdirSync(project);
  const port = await freePort();
  const TOKEN = 'token-di-prova-lungo-abbastanza';
  const origin = `http://127.0.0.1:${port}`;

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
      CR_LOG_FILE: path.join(root, 'log'),
      CR_MAX_SESSIONS: '2',
      // limiti bassi apposta: si prova che *ci sono*, non quanto sono grandi
      CR_RATE_MCP_MAX: '3',
      CR_RATE_TOKEN_MAX: '2',
      CR_RATE_AUTHORIZE_MAX: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/WRA on http:\/\//.test(log)) await sleep(100);
  assert.match(log, /WRA on http:\/\//, `server non partito: ${log}`);

  try {
    // /mcp senza bearer: 401 le prime volte, poi 429 — la porta si chiude
    const codes = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      codes.push(response.status);
      if (response.status === 429) assert.ok(response.headers.get('retry-after'), 'e dice quando riprovare');
    }
    assert.deepEqual(codes, [401, 401, 401, 429], `successione: ${codes.join(',')}`);

    // /token: due tentativi, il terzo lo ferma il limitatore (non il router OAuth)
    const tokenCodes = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`${origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code' });
      tokenCodes.push(response.status);
    }
    assert.equal(tokenCodes.at(-1), 429, `successione: ${tokenCodes.join(',')}`);

    // e l'interfaccia locale non è limitata da questi: il browser deve poter lavorare
    for (let i = 0; i < 6; i += 1) {
      const response = await fetch(`${origin}/local/sessions`, { headers: { 'x-cc-remote-token': TOKEN } });
      assert.equal(response.status, 200, 'le API della persona non c entrano con i limiti pubblici');
    }
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('i valori dei limiti si possono cambiare da ambiente', () => {
  const config = loadConfig({ CR_RATE_MCP_MAX: '7', CR_RATE_MCP_WINDOW_S: '30' });
  assert.equal(config.rateLimits.mcp.max, 7);
  assert.equal(config.rateLimits.mcp.windowMs, 30_000);
  assert.equal(loadConfig({}).rateLimits.mcp.max, 300, 'e il default resta largo');
});
