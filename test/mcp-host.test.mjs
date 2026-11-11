import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { serverEnv } from '../tools/server-env.mjs';

// L'hostname pubblico serve ChatGPT, non le persone. Con `CR_MCP_HOST` dichiarato, sull'host
// pubblico si risponde **solo** sulla superficie OAuth: il sito, le API locali e il websocket
// restano sull'indirizzo di casa. È la garanzia che l'interfaccia amministrativa non finisca su
// internet anche se qualcuno riconfigura Cloudflare Access per sbaglio.

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'token-di-prova-lungo-abbastanza';
const PUBLIC = 'ccmcp.example.test';
const DASH = 'ccdash.example.test';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child = null;
let port = null;

test.before(async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-host-'));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const chosen = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
    env: {
      ...serverEnv(),
      CR_TOKEN: TOKEN,
      CR_PORT: String(chosen),
      CR_ISSUER_URL: `https://${PUBLIC}`,
      CR_RESOURCE_URL: `https://${PUBLIC}/mcp`,
      CR_MCP_HOST: PUBLIC,
      CR_DASHBOARD_HOST: DASH,
      CR_CLAUDE_CMD: process.execPath,
      CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
      CR_DEFAULT_PROJECT: project,
      CR_ALLOWED_ROOTS: path.dirname(project),
      CR_STATE_FILE: path.join(path.dirname(project), 'sessions.json'),
      CR_TURN_JOURNAL_FILE: path.join(path.dirname(project), 'turns.json'),
      CR_PROJECTS_ROOT: path.join(path.dirname(project), 'projects'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !port) {
    const line = /WRA on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    if (line) port = Number(line[1]);
    else await sleep(100);
  }
  assert.ok(port, `il server non è partito:\n${out}`);
});

test.after(() => {
  child?.kill();
});

// `Host` è l'unica cosa che distingue una richiesta arrivata dal tunnel: dietro il proxy sono
// tutte da 127.0.0.1. Quindi si prova proprio quello che manda Cloudflare — e `fetch` non
// serve: `Host` è fra le intestazioni che riscrive da sé, quindi la richiesta si scrive a mano.
const ask = (route, { host = null, method = 'GET', headers = {}, targetPort = null } = {}) =>
  new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: targetPort ?? port,
      path: route,
      method,
      headers: { ...(host ? { host } : {}), ...headers },
    });
    request.on('response', (response) => {
      response.resume();
      resolve({ status: response.statusCode, headers: response.headers });
    });
    request.on('error', reject);
    request.end();
  });

// Il websocket si prova con una richiesta d'upgrade vera: `fetch` non la sa fare.
const upgrade = (route, { host, token = null, targetPort = null } = {}) => new Promise((resolve, reject) => {
  const request = http.request({
    host: '127.0.0.1',
    port: targetPort ?? port,
    path: route,
    headers: {
      host,
      origin: `https://${host}`,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      // Col token giusto: altrimenti l'upgrade si ferma al 401 dell'autenticazione, e un buco
      // nel lock di superficie resterebbe invisibile — passerebbe per il motivo sbagliato.
      ...(token ? { 'sec-websocket-protocol': `bearer.${token}` } : {}),
    },
  });
  request.on('upgrade', (response) => {
    request.destroy();
    resolve(response.statusCode);
  });
  request.on('response', (response) => {
    response.resume();
    resolve(response.statusCode);
  });
  request.on('error', reject);
  request.end();
});

test('sull\'host pubblico passano i metadati OAuth', async () => {
  const as = await ask('/.well-known/oauth-authorization-server', { host: PUBLIC });
  assert.equal(as.status, 200);
  const resource = await ask('/.well-known/oauth-protected-resource/mcp', { host: PUBLIC });
  assert.equal(resource.status, 200);
});

test('sull\'host pubblico /mcp risponde del server (401, non 404)', async () => {
  const response = await ask('/mcp', { host: PUBLIC, method: 'POST' });
  assert.equal(response.status, 401);
  assert.match(response.headers['www-authenticate'] ?? '', /resource_metadata=/);
});

test('sull\'host della dashboard le rotte della macchina non esistono, comunque siano scritte', async () => {
  // Express non distingue maiuscole né barra finale: `/TOKEN` e `/token/` arrivano alla stessa
  // rotta di `/token`. Il lock le confrontava come stringhe, quindi `/TOKEN` passava il lock e
  // finiva sull'endpoint OAuth servito dall'host sbagliato.
  for (const route of [
    '/token', '/TOKEN', '/token/', '/Token/',
    '/register', '/revoke', '/mcp',
    '/.well-known/oauth-authorization-server',
    '/.WELL-KNOWN/oauth-authorization-server',
  ]) {
    const response = await ask(route, { host: DASH, method: 'POST' });
    assert.equal(response.status, 404, `${route} è raggiungibile dall'host della dashboard`);
  }
  const home = await ask('/', { host: DASH });
  assert.equal(home.status, 200, 'la dashboard resta la dashboard');
});

test('sull\'host pubblico il sito non esiste', async () => {
  for (const route of ['/', '/index.html', '/app.js', '/manifest.webmanifest']) {
    const response = await ask(route, { host: PUBLIC });
    assert.equal(response.status, 404, `${route} è raggiungibile dall'host pubblico`);
  }
});

test('sull\'host pubblico le API della persona e la diagnostica non esistono', async () => {
  for (const route of ['/local/sessions', '/healthz']) {
    const response = await ask(route, { host: PUBLIC, headers: { 'x-cc-remote-token': TOKEN } });
    assert.equal(response.status, 404, `${route} è raggiungibile dall'host pubblico`);
  }
});

test('sull\'host pubblico il websocket non si apre', async () => {
  // Senza token: qualunque cosa risponda, non è un 101.
  assert.notEqual(await upgrade('/ws', { host: PUBLIC }), 101);
  // **Col token giusto**: l'upgrade non passa da Express, quindi il lock di superficie va
  // applicato anche qui. Con `?token=` valido, dall'host pubblico non si entra comunque.
  assert.notEqual(await upgrade(`/ws?token=${TOKEN}`, { host: PUBLIC, token: TOKEN }), 101);
});

test('sull\'indirizzo di casa il websocket continua a rispondere del server', async () => {
  // Senza token l'upgrade viene rifiutato con 401: è il server che parla, non un 404 del guard.
  assert.equal(await upgrade('/ws', { host: '127.0.0.1' }), 401);
  // Col token giusto si entra: il lock vale per l'host pubblico, non per casa.
  assert.equal(await upgrade(`/ws?token=${TOKEN}`, { host: '127.0.0.1', token: TOKEN }), 101);
});

test('sull\'host pubblico restano il consenso e il login (servono al browser di ChatGPT)', async () => {
  // `/authorize` è l'authorization_endpoint pubblico: senza, il flusso non parte. Non concede
  // niente da solo — a chi non è la persona si mostra la pagina di accesso (una pagina, non un
  // 401: un endpoint di autorizzazione risponde sempre con una pagina, ed è quello che un client
  // si aspetta di trovare).
  const authorize = await ask('/authorize?response_type=code&client_id=x', { host: PUBLIC });
  assert.notEqual(authorize.status, 404, `l'authorization endpoint non esiste sull'host pubblico: ${authorize.status}`);
  assert.ok([200, 302].includes(authorize.status), `risposta inattesa: ${authorize.status}`);
  assert.equal(authorize.headers['www-authenticate'], undefined, 'non è una risposta da risorsa protetta');
  assert.ok(!String(authorize.headers.location ?? '').includes('code'), 'non si concede niente senza il token della persona');

  const login = await ask('/authorize/login', { host: PUBLIC, method: 'POST' });
  assert.notEqual(login.status, 404);
});

test('sull\'indirizzo di casa non cambia niente', async () => {
  // Il gate è legato all'host dichiarato: chi arriva da 127.0.0.1 (browser locale, `rc`, il
  // telefono via tailnet) trova tutto come prima.
  const home = await ask('/');
  assert.equal(home.status, 200);

  const health = await ask('/healthz', { headers: { 'x-cc-remote-token': TOKEN } });
  assert.equal(health.status, 200);

  // e con un host diverso ma non dichiarato (il tailnet, un futuro `cc.…`) si passa lo stesso
  const other = await ask('/', { host: 'pc-example.tail0000.ts.net' });
  assert.equal(other.status, 200);
});

test('senza CR_MCP_HOST non si chiude niente (il bridge locale dei test resta usabile)', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-nohost-'));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const chosen = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const bare = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
    env: {
      ...serverEnv(),
      CR_TOKEN: TOKEN,
      CR_PORT: String(chosen),
      CR_ISSUER_URL: `http://127.0.0.1:${chosen}`,
      CR_RESOURCE_URL: `http://127.0.0.1:${chosen}/mcp`,
      CR_CLAUDE_CMD: process.execPath,
      CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
      CR_DEFAULT_PROJECT: project,
      CR_ALLOWED_ROOTS: path.dirname(project),
      CR_STATE_FILE: path.join(path.dirname(project), 'sessions.json'),
      CR_TURN_JOURNAL_FILE: path.join(path.dirname(project), 'turns.json'),
      CR_PROJECTS_ROOT: path.join(path.dirname(project), 'projects'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  bare.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  bare.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  try {
    let up = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !up) {
      const line = /WRA on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (line) up = Number(line[1]);
      else await sleep(100);
    }
    assert.ok(up, `il server non è partito:\n${out}`);
    const response = await fetch(`http://127.0.0.1:${up}/`, { redirect: 'manual' });
    assert.equal(response.status, 200);
    const mcp = await fetch(`http://127.0.0.1:${up}/mcp`, { method: 'POST', redirect: 'manual' });
    assert.equal(mcp.status, 401);
  } finally {
    bare.kill();
  }
});
