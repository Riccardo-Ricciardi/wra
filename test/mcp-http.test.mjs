import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

// L'aggancio HTTP del bridge: cosa risponde, e cosa rifiuta. La logica OAuth è provata in
// auth.test.mjs; qui si controlla che i pezzi siano montati al posto giusto — un refuso nel
// montaggio non si vedrebbe finché ChatGPT non prova a connettersi.

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'token-di-prova-lungo-abbastanza';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server = null;
let port = null;

test.before(async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-http-'));

  // Una porta libera scelta prima di partire: l'issuer e la resource devono essere l'indirizzo
  // vero del server, altrimenti i metadati OAuth puntano altrove (e il test mente).
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const chosen = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${chosen}`;

  const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
    env: {
      ...process.env,
      CR_TOKEN: TOKEN,
      CR_PORT: String(chosen),
      CR_ISSUER_URL: origin,
      CR_RESOURCE_URL: `${origin}/mcp`,
      CR_CLAUDE_CMD: process.execPath,
      CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
      CR_DEFAULT_PROJECT: project,
      CR_ALLOWED_ROOTS: path.dirname(project),
      // il registro e i transcript di questo test stanno nella cartella temporanea: un test non
      // deve leggere (né scrivere) le chat vere di chi sta lavorando
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
    const match = out.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) port = Number(match[1]);
    else await sleep(100);
  }
  if (!port) throw new Error(`server non partito: ${out}`);
  server = { child, project };
});

test.after(() => {
  server?.child.kill();
  try {
    fs.rmSync(server?.project, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // pulizia tollerante: il PTY può tenere la cartella
  }
});

const url = (route) => `http://127.0.0.1:${port}${route}`;
const authHeaders = { 'x-cc-remote-token': TOKEN };

test('healthz non è pubblico: senza token è 401, col token dice cosa c entra', async () => {
  const anonymous = await fetch(url('/healthz'));
  assert.equal(anonymous.status, 401, 'le chat e i loro percorsi non si regalano a chi passa');

  const response = await fetch(url('/healthz'), { headers: authHeaders });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.mcp, true, 'con issuer e resource configurati il bridge deve essere acceso');
});

test('i metadati OAuth si scoprono dall 401 di /mcp, e si leggono', async () => {
  const withoutToken = await fetch(url('/mcp'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  assert.equal(withoutToken.status, 401, 'senza bearer non si entra');

  // Il client non indovina l'indirizzo dei metadati: lo legge da qui.
  const challenge = String(withoutToken.headers.get('www-authenticate') ?? '');
  assert.match(challenge, /resource_metadata=/, `l'401 deve dire dove stanno i metadati: ${challenge}`);
  const metadataUrl = challenge.match(/resource_metadata="?([^",]+)"?/)?.[1];
  const metadata = await fetch(metadataUrl);
  assert.equal(metadata.status, 200, 'i metadati li deve poter leggere un client');
  const body = await metadata.json();
  assert.ok(body.authorization_servers?.length, 'e devono indicare il nostro authorization server');

  const wrongToken = await fetch(url('/mcp'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer inventato' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  assert.equal(wrongToken.status, 401, 'con un bearer falso nemmeno');
});

test('GET e DELETE su /mcp rispondono 405 in JSON, non con un corpo vuoto', async () => {
  const response = await fetch(url('/mcp'), { headers: { authorization: 'Bearer inventato' } });
  assert.equal(response.status, 401, 'prima si passa dal bearer');
});

test('la pagina di autorizzazione chiede il token, e il token giusto lascia il cookie', async () => {
  const page = await fetch(url('/authorize?client_id=x&redirect_uri=y'), {
    headers: { accept: 'text/html' },
  });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Authorize an MCP client/);
  assert.match(html, /\/authorize\/login/, 'il modulo deve puntare al nostro login');

  const wrong = await fetch(url('/authorize/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'sbagliato', next: '/authorize' }),
    redirect: 'manual',
  });
  assert.equal(wrong.status, 401);

  const right = await fetch(url('/authorize/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TOKEN, next: '/authorize?client_id=x' }),
    redirect: 'manual',
  });
  assert.equal(right.status, 302);
  assert.match(String(right.headers.get('set-cookie')), /cc_remote_owner=/);
  assert.equal(right.headers.get('location'), '/authorize?client_id=x');
});

test('l\'authorization endpoint risponde con una pagina, anche a una chiamata macchina', async () => {
  // Prima si rispondeva 401 con un JSON a chi non mandava `Accept: text/html`. Era la risposta
  // sbagliata per un authorization endpoint: un client OAuth non può leggerci altro che «il server
  // mi ha negato l'accesso» — ed è il messaggio con cui ChatGPT si fermava prima di qualunque
  // pagina. Ora risponde sempre la pagina di accesso; quello che **non** cambia è che senza il
  // token non si concede niente.
  const response = await fetch(url('/authorize'), { headers: { accept: 'application/json' } });
  assert.equal(response.status, 200, 'l\'authorization endpoint risponde con una pagina');
  assert.match(String(response.headers.get('content-type')), /text\/html/);
  const html = await response.text();
  assert.match(html, /token/i, 'è la pagina che chiede il token');
  assert.ok(!/Consenti una volta/.test(html), 'non è la pagina di consenso: senza token non si consente niente');
});