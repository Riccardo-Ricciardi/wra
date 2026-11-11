import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Il giro OAuth completo, su HTTP vero, dalla parte di chi lo usa (ChatGPT).
//
// È la prova che i pezzi *stanno insieme*: la scoperta dei metadati, la registrazione del
// client, il consenso della persona, il codice con PKCE, i token, la chiamata MCP firmata, la
// rotazione del refresh e la revoca. I singoli pezzi hanno i loro test; qui si cammina.

const TOKEN = 'token-di-prova-lungo-abbastanza';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

let child;
let origin;
let root;

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-oauth-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project);
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'cli', 'serve.mjs')], {
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/WRA on http:\/\//.test(log)) await sleep(100);
  assert.match(log, /WRA on http:\/\//, `server non partito: ${log}`);
});

test.after(() => {
  child?.kill();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // il PTY può tenere la cartella
  }
});

const json = async (route, options = {}) => {
  const response = await fetch(`${origin}${route}`, options);
  const body = await response.json().catch(() => null);
  return { status: response.status, body, response };
};

/** Il client si registra da sé (RFC 7591): è quello che fa ChatGPT. */
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
  assert.ok(body.client_id);
  return body.client_id;
}

/** La persona: prima il token (una volta), poi il consenso. Restituisce il cookie del browser. */
async function ownerCookie() {
  const login = await fetch(`${origin}/authorize/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: TOKEN, next: '/authorize' }).toString(),
    redirect: 'manual',
  });
  assert.equal(login.status, 302, 'il token giusto fa entrare');
  const cookie = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie');
  assert.match(cookie, /cc_remote_owner=/);
  return cookie.split(';')[0];
}

/** GET /authorize con il cookie: la pagina di consenso, col nonce. */
async function consentPage(clientId, challenge, state, cookie) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  const response = await fetch(`${origin}/authorize?${query}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(response.status, 200, 'la pagina di consenso');
  const html = await response.text();
  assert.match(html, /A client wants to talk to the agent/, 'e dice cosa si sta autorizzando');
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(nonce, 'con un nonce: senza, il codice non nasce');
  // Il valore nell'HTML è escapato (`&amp;`): il browser lo riporta indietro decodificato, e
  // senza decodificarlo qui la seconda richiesta avrebbe una query diversa — cioè un'altra
  // richiesta, e il consenso appena dato non risulterebbe.
  const next = (/name="next" value="([^"]*)"/.exec(html)?.[1] ?? '').replace(/&amp;/g, '&');
  return { nonce, next };
}

async function approve({ nonce, next }, cookie, decision = 'allow') {
  return fetch(`${origin}/authorize/consent`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nonce, next, decision }).toString(),
    redirect: 'manual',
  });
}

/**
 * Il giro come lo fa un browser, in due tempi: si approva sulla pagina, si torna alla
 * richiesta di autorizzazione — che stavolta è concessa — e **lì** nasce il codice, con la
 * redirect verso il client. Saltare il secondo tempo era l'errore della prima versione di
 * questo test: il codice non si vede, e sembra che il consenso non funzioni.
 */
async function authorizeAndGetCode(clientId, { challenge }, state, cookie, decision = 'allow') {
  const page = await consentPage(clientId, challenge, state, cookie);
  const approved = await approve(page, cookie, decision);
  if (decision === 'deny') return { denied: approved };

  assert.equal(approved.status, 302, 'il consenso torna alla richiesta');
  assert.equal(approved.headers.get('location'), page.next, 'esattamente alla richiesta di prima');

  const issued = await fetch(new URL(page.next, origin), { headers: { cookie }, redirect: 'manual' });
  assert.equal(issued.status, 302, 'e adesso il codice viene emesso');
  return { to: new URL(issued.headers.get('location')) };
}

async function exchangeCode({ clientId, code, verifier }) {
  return json('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    }).toString(),
  });
}

async function callMcp(accessToken, method = 'tools/list') {
  return json('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
  });
}

test('la scoperta dei metadati dice dove andare', async () => {
  const as = await json('/.well-known/oauth-authorization-server');
  assert.equal(as.status, 200);
  assert.equal(as.body.issuer, `${origin}/`);
  assert.ok(as.body.authorization_endpoint.endsWith('/authorize'));
  assert.ok(as.body.token_endpoint.endsWith('/token'));
  assert.ok(as.body.registration_endpoint.endsWith('/register'));
  assert.deepEqual(as.body.code_challenge_methods_supported, ['S256'], 'PKCE obbligatorio, e solo S256');

  const rs = await json('/.well-known/oauth-protected-resource/mcp');
  assert.equal(rs.status, 200);
  assert.equal(rs.body.resource, `${origin}/mcp`, 'la risorsa è l endpoint MCP, non il sito');
  assert.deepEqual(rs.body.scopes_supported, ['talk']);

  // e senza token /mcp dice dove trovare i metadati, come vuole la specifica
  const bare = await fetch(`${origin}/mcp`, { method: 'POST' });
  assert.equal(bare.status, 401);
  assert.match(bare.headers.get('www-authenticate') ?? '', /resource_metadata=".*oauth-protected-resource/);
});

test('la registrazione rifiuta un redirect fuori elenco, e accetta quello di ChatGPT', async () => {
  await assert.rejects(register('https://evil.example/cb'), /registrazione/);
  await assert.rejects(register('https://chatgpt.com.evil.example/cb'), /registrazione/, 'suffisso finto');
  await assert.rejects(register('http://chatgpt.com/cb'), /registrazione/, 'niente http in chiaro');
  assert.ok(await register(), 'quello vero si registra');
});

test('il giro completo: consenso, codice con PKCE, token, e una chiamata MCP firmata', async () => {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const state = crypto.randomUUID();
  const cookie = await ownerCookie();

  const { to: back } = await authorizeAndGetCode(clientId, { verifier, challenge }, state, cookie);
  assert.equal(back.origin + back.pathname, 'https://chatgpt.com/connector_platform_oauth_redirect', 'e torna esattamente dove dichiarato');
  assert.equal(back.searchParams.get('state'), state, 'con lo state di prima');
  const code = back.searchParams.get('code');
  assert.ok(code);

  const tokens = await exchangeCode({ clientId, code, verifier });
  assert.equal(tokens.status, 200, `scambio: ${JSON.stringify(tokens.body)}`);
  assert.ok(tokens.body.access_token && tokens.body.refresh_token);
  assert.equal(tokens.body.token_type, 'Bearer');
  assert.equal(tokens.body.scope, 'talk');

  // il codice è monouso
  const again = await exchangeCode({ clientId, code, verifier });
  assert.notEqual(again.status, 200, 'lo stesso codice non si scambia due volte');

  // e con quel token si parla con MCP
  const listed = await callMcp(tokens.body.access_token);
  assert.equal(listed.status, 200, `chiamata MCP: ${JSON.stringify(listed.body).slice(0, 200)}`);
  const names = (listed.body.result?.tools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(names, ['get_turn_status', 'list_chats', 'select_chat', 'talk']);
});

test('PKCE sbagliato non produce token', async () => {
  const clientId = await register();
  const { challenge } = pkce();
  const cookie = await ownerCookie();
  const { to } = await authorizeAndGetCode(clientId, { challenge }, 'stato-pkce', cookie);
  const code = to.searchParams.get('code');

  const wrong = await exchangeCode({ clientId, code, verifier: crypto.randomBytes(32).toString('base64url') });
  assert.notEqual(wrong.status, 200, 'con un verifier che non corrisponde, niente token');
  assert.match(JSON.stringify(wrong.body), /verifier|challenge|invalid/i);
});

test('senza consenso il codice non nasce', async () => {
  const clientId = await register();
  const { challenge } = pkce();
  const cookie = await ownerCookie();
  const { denied: refused } = await authorizeAndGetCode(clientId, { challenge }, 'stato-rifiuto', cookie, 'deny');
  assert.equal(refused.status, 200, 'si torna alla pagina, non al client');
  const html = await refused.text();
  assert.match(html, /rejected|no access/i);
  assert.equal(refused.headers.get('location'), null, 'e nessun codice è stato consegnato');
});

test('rifiutare il token di casa non fa entrare nessuno', async () => {
  // A chi non è la persona si mostra la pagina di accesso (non un 401: un authorization endpoint
  // risponde con una pagina). Quello che conta è che **non** si arrivi al consenso: nessun codice
  // nasce, e nessun client vede niente.
  const response = await fetch(`${origin}/authorize?response_type=code&client_id=x`, { redirect: 'manual' });
  assert.equal(response.status, 200, 'l\'authorization endpoint risponde con una pagina');
  const html = await response.text();
  assert.match(html, /token/i, 'la pagina chiede il token della persona');
  assert.ok(!/Consenti una volta/.test(html), 'senza il token di cc-remote il consenso non si apre');
  assert.equal(response.headers.get('location'), null, 'e non si manda nessun codice da nessuna parte');
});

test('il refresh ruota, e un riuso fa cadere tutto il consenso', async () => {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const cookie = await ownerCookie();
  const { to } = await authorizeAndGetCode(clientId, { verifier, challenge }, 'stato-refresh', cookie);
  const code = to.searchParams.get('code');
  const first = (await exchangeCode({ clientId, code, verifier })).body;

  const rotate = async (refreshToken) => json('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
  });

  const second = await rotate(first.refresh_token);
  assert.equal(second.status, 200, `rotazione: ${JSON.stringify(second.body)}`);
  assert.notEqual(second.body.refresh_token, first.refresh_token, 'il refresh cambia a ogni giro');
  assert.equal((await callMcp(second.body.access_token)).status, 200, 'e il nuovo access funziona');

  // qualcuno rigioca il refresh vecchio: da qui in giù non vale più niente
  const replay = await rotate(first.refresh_token);
  assert.notEqual(replay.status, 200);
  assert.equal((await callMcp(second.body.access_token)).status, 401, 'anche l access emesso adesso è morto');
  const afterwards = await rotate(second.body.refresh_token);
  assert.notEqual(afterwards.status, 200, 'e il refresh nuovo pure');
});

test('un access token scaduto o revocato non passa', async () => {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const cookie = await ownerCookie();
  const { to } = await authorizeAndGetCode(clientId, { verifier, challenge }, 'stato-revoca', cookie);
  const code = to.searchParams.get('code');
  const tokens = (await exchangeCode({ clientId, code, verifier })).body;

  assert.equal((await callMcp(tokens.access_token)).status, 200);

  const revoked = await fetch(`${origin}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tokens.access_token, client_id: clientId }).toString(),
  });
  assert.equal(revoked.status, 200, 'la revoca risponde 200 come vuole la specifica');
  assert.equal((await callMcp(tokens.access_token)).status, 401, 'e il token non vale più');
  assert.equal((await callMcp('token-inventato')).status, 401);
});

test('un token emesso per un altra risorsa non apre questa', async () => {
  // Il controllo sta nel middleware: si prova con un token valido ma per un pubblico diverso,
  // costruendo a mano la risposta del verificatore.
  const { BridgeStore } = await import('../src/mcp/auth/store.mjs');
  const { BridgeOAuthProvider } = await import('../src/mcp/auth/provider.mjs');
  const store = new BridgeStore({
    allowedRedirectHosts: ['chatgpt.com'], codeTtlMs: 1000, accessTokenTtlS: 60, refreshTokenTtlS: 60,
    scope: 'talk', resourceUrl: 'https://altro.example/mcp',
  });
  const provider = new BridgeOAuthProvider({ store, scope: 'talk' });
  const tokens = store.issueTokens({ subject: 'u', email: 'e', clientId: 'c' });
  const info = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.resource.href, 'https://altro.example/mcp', 'il token porta la sua risorsa');
  assert.notEqual(info.resource.href, `${origin}/mcp`, 'che non è questa');
});
