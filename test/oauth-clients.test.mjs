import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BridgeStore, authorizePreflight } from '../src/mcp/auth/store.mjs';
import { serverEnv } from '../tools/server-env.mjs';

// La registrazione di un client (RFC 7591) è l'unica cosa di OAuth che **deve** sopravvivere a un
// riavvio — ed è quella che non ci sopravviveva.
//
// Un `client_id` non è un token: il client se lo tiene da parte e lo ripresenta, non lo rigenera.
// Se il server lo dimentica, il client continua a presentare quello vecchio e prende
// `invalid_client` **per sempre**, senza che niente, da sola parte, lo riporti a registrarsi. È
// quello che è successo davvero: `POST /register` 201 il 3/11, riavvio, e dal 6/11 solo
// `POST /token` 400 da `openai-connectors-oauth/1.0` — la registrazione non veniva più ritentata.
//
// Il resto (codici, access token, refresh) resta in memoria, e c'è una prova anche di quello:
// persistenza e credenziali sono due cose diverse, e confonderle vorrebbe dire token che non
// scadono più.

const TOKEN = 'token-di-prova-lungo-abbastanza';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const HOSTS = ['chatgpt.com', 'openai.com'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const storeOptions = (clientsFile) => ({
  allowedRedirectHosts: HOSTS,
  codeTtlMs: 60_000,
  accessTokenTtlS: 3600,
  refreshTokenTtlS: 86_400,
  scope: 'cc-remote',
  resourceUrl: 'https://macchina.esempio/mcp',
  clientsFile,
});

const clientInfo = (id) => ({
  client_id: id,
  client_name: 'ChatGPT',
  redirect_uris: [REDIRECT],
  token_endpoint_auth_method: 'none',
});

/** Una cartella usa e getta: le prove non toccano lo stato di chi usa la macchina. */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-oauth-clients-'));
}

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

// ── il negozio: cosa sopravvive e cosa no ──────────────────────────────────────────────────────

test('un client registrato si ritrova dopo il riavvio', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'oauth-clients.json');
    const first = new BridgeStore(storeOptions(file));
    first.registerClient(clientInfo('client-uno'));

    // Il riavvio: un negozio nuovo, lo stesso file, e nessuna memoria in comune.
    const second = new BridgeStore(storeOptions(file));
    assert.equal(second.getClient('client-uno')?.client_id, 'client-uno');
    assert.deepEqual(second.getClient('client-uno').redirect_uris, [REDIRECT], 'e con i suoi redirect');
    assert.equal(second.count.clients, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codici e token non finiscono nel file, e non sopravvivono', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'oauth-clients.json');
    const first = new BridgeStore(storeOptions(file));
    first.registerClient(clientInfo('client-uno'));
    first.putCode('codice-in-chiaro', { clientId: 'client-uno', expiresAt: Date.now() + 60_000 });
    const tokens = first.issueTokens({ subject: 'owner', email: 'owner', clientId: 'client-uno' });

    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('codice-in-chiaro'), 'il codice non è sul disco');
    assert.ok(!text.includes(tokens.access_token), 'l access token non è sul disco');
    assert.ok(!text.includes(tokens.refresh_token), 'il refresh token non è sul disco');

    const second = new BridgeStore(storeOptions(file));
    assert.equal(second.getCode('codice-in-chiaro'), undefined, 'il codice non è sopravvissuto');
    assert.equal(second.getAccess(tokens.access_token), undefined, 'l access token non è sopravvissuto');
    assert.equal(second.getRefresh(tokens.refresh_token), undefined, 'il refresh token non è sopravvissuto');
    assert.deepEqual(
      { codes: second.count.codes, access: second.count.access, refresh: second.count.refresh },
      { codes: 0, access: 0, refresh: 0 },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('la persistenza non rida token revocati, e i file restano leggibili solo da chi li scrive', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'oauth-clients.json');
    const first = new BridgeStore(storeOptions(file));
    first.registerClient(clientInfo('client-uno'));
    first.registerClient(clientInfo('client-due')); // una seconda scrittura: così esiste anche il .bak
    const tokens = first.issueTokens({ subject: 'owner', email: 'owner', clientId: 'client-uno' });
    assert.ok(first.getAccess(tokens.access_token));
    first.deleteToken(tokens.access_token);
    first.deleteToken(tokens.refresh_token);
    assert.equal(first.getAccess(tokens.access_token), undefined, 'revocato');

    // Rileggere il file non è un modo per tornare indietro: la revoca sta in memoria, e i token
    // non sono mai stati sul disco.
    const second = new BridgeStore(storeOptions(file));
    assert.equal(second.getAccess(tokens.access_token), undefined, 'la revoca non si annulla rileggendo');
    assert.equal(second.getRefresh(tokens.refresh_token), undefined);
    assert.equal(second.getClient('client-uno')?.client_id, 'client-uno', 'il client invece c\'è');
    assert.equal(second.getClient('client-due')?.client_id, 'client-due');

    assert.ok(fs.existsSync(`${file}.bak`), 'il backup c\'è');
    if (process.platform !== 'win32') {
      // Il file contiene i `client_secret` di chi ne ha uno: leggibile solo da chi lo scrive, e
      // vale anche per il `.bak`, che ne contiene una copia.
      for (const target of [file, `${file}.bak`]) {
        assert.equal(fs.statSync(target).mode & 0o777, 0o600, `${target} è leggibile da altri`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('un file corrotto si mette da parte e non impedisce di registrarsi di nuovo', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'oauth-clients.json');
    fs.writeFileSync(file, '{ questo non è JSON');

    const store = new BridgeStore(storeOptions(file));
    assert.equal(store.count.clients, 0, 'si riparte da zero');
    const damaged = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    assert.equal(damaged.length, 1, 'l originale rotto resta come prova, non si butta');

    // E il negozio resta usabile: il client che non trova più il suo id si registra di nuovo.
    store.registerClient(clientInfo('client-nuovo'));
    assert.equal(new BridgeStore(storeOptions(file)).getClient('client-nuovo')?.client_id, 'client-nuovo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('col primario rotto si recupera il backup, invece di perdere tutti i client', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'oauth-clients.json');
    const first = new BridgeStore(storeOptions(file));
    first.registerClient(clientInfo('client-uno')); // primario: 1 client, nessun backup
    first.registerClient(clientInfo('client-due')); // backup: 1 client, primario: 2

    fs.writeFileSync(file, 'troncato a metà');
    const second = new BridgeStore(storeOptions(file));
    assert.equal(second.getClient('client-uno')?.client_id, 'client-uno', 'il backup si è usato');
    assert.equal(second.count.clients, 1);
    assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-')).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('una voce scritta a mano con un redirect fuori elenco non si carica', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'oauth-clients.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      clients: [
        clientInfo('buono'),
        { client_id: 'cattivo', redirect_uris: ['https://evil.example/rubato'] },
        { client_id: 'senza-redirect', redirect_uris: [] },
        { redirect_uris: [REDIRECT] },
      ],
    }));

    const store = new BridgeStore(storeOptions(file));
    assert.equal(store.count.clients, 1);
    assert.equal(store.getClient('buono')?.client_id, 'buono');
    assert.equal(store.getClient('cattivo'), undefined, 'il file è uno stato di cui non ci si fida');
    assert.equal(store.getClient('senza-redirect'), undefined);
    // E quel che resta è stato riscritto senza le voci scartate.
    const salvato = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(salvato.clients.map((entry) => entry.client_id), ['buono']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('la registrazione continua a rifiutare un redirect fuori elenco', () => {
  const store = new BridgeStore(storeOptions(null));
  assert.throws(
    () => store.registerClient({ client_id: 'x', redirect_uris: ['https://evil.example/rubato'] }),
    /redirect_uri not allowed/,
  );
  assert.throws(() => store.registerClient({ client_id: 'x', redirect_uris: [] }), /at least one redirect_uri/);
  assert.equal(store.count.clients, 0);
});

// ── la domanda che si fa prima di chiedere il consenso ─────────────────────────────────────────

test('authorizePreflight: client ignoto e redirect non registrato si fermano prima del consenso', () => {
  const client = clientInfo('client-uno');
  const base = { client_id: 'client-uno', redirect_uri: REDIRECT };

  assert.equal(authorizePreflight(client, base), null, 'il caso buono passa');
  assert.deepEqual(
    authorizePreflight(undefined, base),
    { error: 'invalid_client', error_description: 'Invalid client_id' },
    'un client_id che non esiste non arriva alla pagina di consenso',
  );
  assert.deepEqual(
    authorizePreflight(client, { ...base, redirect_uri: 'https://chatgpt.com/altro' }),
    { error: 'invalid_request', error_description: 'Unregistered redirect_uri' },
  );
  // Col solo redirect registrato si può anche omettere: il router lo prende da sé.
  assert.equal(authorizePreflight(client, { client_id: 'client-uno' }), null);
  const due = { ...client, redirect_uris: [REDIRECT, 'https://openai.com/cb'] };
  assert.deepEqual(
    authorizePreflight(due, { client_id: 'client-uno' }),
    { error: 'invalid_request', error_description: 'redirect_uri must be specified when client has multiple registered URIs' },
    'con più redirect registrati la scelta va detta',
  );
  assert.equal(authorizePreflight(due, { client_id: 'client-uno', redirect_uri: 'https://openai.com/cb' }), null);
  assert.deepEqual(
    authorizePreflight(client, { ...base, redirect_uri: [REDIRECT, REDIRECT] }),
    { error: 'invalid_request', error_description: 'Unregistered redirect_uri' },
    'un parametro ripetuto non è un redirect registrato',
  );
});

// ── il giro vivo, con un riavvio in mezzo ──────────────────────────────────────────────────────

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

let root;
let origin;
let child;

/** Accende il server vero su una porta libera, con lo stato in `root`. */
async function startServer() {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  const spawned = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'cli', 'serve.mjs')], {
    env: serverEnv({
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
      // Le prove su `/authorize` sono molte e la prova non sta misurando il limitatore: i valori
      // veri (60 in 5 minuti) sono bassi quanto basta per far fallire questa prova per il motivo
      // sbagliato.
      CR_RATE_AUTHORIZE_MAX: '500',
      CR_RATE_LOGIN_MAX: '500',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  spawned.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  spawned.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/WRA on http:\/\//.test(log)) await sleep(100);
  assert.match(log, /WRA on http:\/\//, `server non partito: ${log}`);
  child = spawned;
  return spawned;
}

async function stopServer() {
  if (!child) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([gone, sleep(5_000)]);
  child = null;
}

const json = async (route, options = {}) => {
  const response = await fetch(`${origin}${route}`, options);
  return { status: response.status, body: await response.json().catch(() => null), response };
};

async function register(redirectUri = REDIRECT) {
  const { status, body } = await json('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(status, 201, `registrazione: ${JSON.stringify(body)}`);
  return body.client_id;
}

async function ownerCookie() {
  const login = await fetch(`${origin}/authorize/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TOKEN, next: '/authorize' }).toString(),
    redirect: 'manual',
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie');
  return cookie.split(';')[0];
}

const authorizeQuery = (clientId, challenge, redirectUri = REDIRECT) => new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: redirectUri,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'stato',
});

/** GET /authorize col cookie: la pagina di consenso, col suo nonce. */
async function consentPage(clientId, challenge, cookie, redirectUri = REDIRECT) {
  const response = await fetch(`${origin}/authorize?${authorizeQuery(clientId, challenge, redirectUri)}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  assert.equal(response.status, 200, 'la pagina di consenso');
  const html = await response.text();
  assert.match(html, /A client wants to talk to the agent/);
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(nonce, 'senza nonce il codice non nasce');
  // Il valore nell'HTML è escapato (`&amp;`): il browser lo riporta indietro decodificato, e
  // senza decodificarlo qui la seconda richiesta sarebbe un'altra richiesta, senza consenso.
  const next = (/name="next" value="([^"]*)"/.exec(html)?.[1] ?? '').replace(/&amp;/g, '&');
  return { nonce, next };
}

const approve = (page, cookie, decision = 'allow') => fetch(`${origin}/authorize/consent`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ nonce: page.nonce ?? '', next: page.next, decision }).toString(),
  redirect: 'manual',
});

test.before(async () => {
  root = tempDir();
  await startServer();
});

test.after(async () => {
  await stopServer();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // il PTY può tenere la cartella
  }
});

test('un client sconosciuto prende 400, e **non** la pagina di consenso', async () => {
  const cookie = await ownerCookie();
  const { challenge } = pkce();
  const response = await fetch(`${origin}/authorize?${authorizeQuery('client-mai-visto', challenge)}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const body = await response.text();
  assert.equal(response.status, 400, 'lo stesso 400 che darebbe il router OAuth, ma prima del consenso');
  assert.match(body, /invalid_client/);
  assert.ok(!/A client wants to talk to the agent/.test(body), 'e nessuna pagina da approvare: niente ciclo');
});

test('un redirect non registrato prende 400, e **non** la pagina di consenso', async () => {
  const clientId = await register();
  const cookie = await ownerCookie();
  const { challenge } = pkce();
  const response = await fetch(
    `${origin}/authorize?${authorizeQuery(clientId, challenge, 'https://chatgpt.com/altro')}`,
    { headers: { cookie }, redirect: 'manual' },
  );
  const body = await response.text();
  assert.equal(response.status, 400);
  assert.match(body, /Unregistered redirect_uri/);
  assert.ok(!/A client wants to talk to the agent/.test(body));
});

test('nessun metodo e nessuna variante di percorso conia un codice senza consenso', async () => {
  // Il consenso vive nel gate, che sta sul GET. Ogni altra strada che arrivi al router OAuth — un
  // metodo diverso, una scrittura diversa dello stesso percorso, un `POST` sul consenso senza il
  // nonce della pagina — conierebbe un codice che nessuno ha approvato. Qui si prova che non ce
  // n'è nessuna: la prova è **non vacua**, perché in fondo lo stesso giro, fatto bene, il codice
  // lo produce davvero.
  const clientId = await register();
  const cookie = await ownerCookie();
  const { challenge } = pkce();
  const query = authorizeQuery(clientId, challenge).toString();

  const vie = [
    ['POST', '/authorize'],
    ['PUT', '/authorize'],
    ['PATCH', '/authorize'],
    ['DELETE', '/authorize'],
    ['OPTIONS', '/authorize'],
    ['POST', '/AUTHORIZE'], // l'instradamento di Express non distingue le maiuscole
    ['POST', '/authorize/'],
    ['POST', '/authorize/./'],
    ['POST', '/authorize/../authorize'],
    ['POST', '/%61uthorize'],
    ['POST', '//authorize'],
    ['POST', '/authorize/consent'],
    ['POST', '/authorize/consent/'],
  ];
  for (const [method, route] of vie) {
    const response = await fetch(`${origin}${route}`, {
      method,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: query,
      redirect: 'manual',
    });
    const location = response.headers.get('location') ?? '';
    await response.text();
    assert.ok(!/[?&]code=/.test(location), `${method} ${route} ha coniato un codice: ${location}`);
    assert.ok(!location.startsWith(REDIRECT), `${method} ${route} è tornato al client: ${location}`);
  }

  // Sull'authorization endpoint il rifiuto si **dice** (`405` + `Allow`), invece di lasciar
  // credere a un client di aver fatto il giro e di essere tornato a mani vuote.
  const rifiutata = await fetch(`${origin}/authorize`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: query,
    redirect: 'manual',
  });
  assert.equal(rifiutata.status, 405);
  assert.equal(rifiutata.headers.get('allow'), 'GET');
  await rifiutata.text();

  // Il nonce è l'unica cosa che distingue un POST partito dalla pagina da uno scritto a mano:
  // senza (o con uno inventato) non si concede niente, e non si torna al client.
  for (const nonce of ['f'.repeat(32), '', 'non-un-nonce']) {
    const response = await approve({ nonce, next: `/authorize?${query}` }, cookie);
    assert.equal(response.status, 200, 'si resta sulla pagina');
    assert.equal(response.headers.get('location'), null, `col nonce «${nonce}» non si concede niente`);
    await response.text();
  }

  // Il controllo che rende la prova non vacua: **con** il consenso il codice nasce davvero.
  const page = await consentPage(clientId, challenge, cookie);
  assert.equal((await approve(page, cookie)).status, 302);
  const issued = await fetch(new URL(page.next, origin), { headers: { cookie }, redirect: 'manual' });
  assert.equal(issued.status, 302, 'col consenso il codice nasce');
  assert.match(new URL(issued.headers.get('location')).searchParams.get('code') ?? '', /^[\w-]{20,}$/);
});

test('dopo il riavvio il client di prima completa il giro: consenso, codice, token, revoca', async () => {
  const clientId = await register();
  await stopServer();
  await startServer();

  assert.equal((await json('/.well-known/oauth-authorization-server')).status, 200, 'il server è di nuovo su');

  // Il client è lo stesso di prima del riavvio — e il server lo conosce ancora.
  const cookie = await ownerCookie();
  const { verifier, challenge } = pkce();
  const page = await consentPage(clientId, challenge, cookie);
  assert.equal((await approve(page, cookie)).status, 302);

  const issued = await fetch(new URL(page.next, origin), { headers: { cookie }, redirect: 'manual' });
  assert.equal(issued.status, 302, 'il codice nasce: era il 400 di prima');
  const code = new URL(issued.headers.get('location')).searchParams.get('code');
  assert.ok(code);

  const exchanged = await json('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }).toString(),
  });
  assert.equal(exchanged.status, 200, `scambio: ${JSON.stringify(exchanged.body)}`);
  assert.ok(exchanged.body.access_token);

  const revoked = await json('/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: exchanged.body.access_token, client_id: clientId }).toString(),
  });
  assert.equal(revoked.status, 200, `revoca: ${JSON.stringify(revoked.body)}`);
  const after = await json('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${exchanged.body.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(after.status, 401, 'revocato vuol dire revocato');
});
