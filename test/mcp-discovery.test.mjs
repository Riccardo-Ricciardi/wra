import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serverEnv } from '../tools/server-env.mjs';

// La **scoperta**: tutto quello che un client legge prima di aprire una pagina di login, e che
// quindi non si può sbagliare senza che il collegamento si fermi prima di qualunque consenso.
//
// Serve perché è successo: il documento della risorsa (RFC 9728) era servito **solo** nella forma
// con il percorso (`/.well-known/oauth-protected-resource/mcp`), mentre la documentazione di
// ChatGPT dice di chiamare la **radice** (`/.well-known/oauth-protected-resource`). Là c'era un
// 404 con la pagina «Cannot GET» di Express, e il client si limitava a dire che il server aveva
// negato l'accesso. Nessuna pagina di login, nessun consenso, nessuna traccia: solo un rifiuto.
//
// Le prove qui sotto sono due, e la seconda è quella che conta: la prima guarda i documenti, la
// seconda fa camminare un **client MCP vero** (quello dell'SDK, lo stesso di `mcp-remote`) fino
// alla pagina di autorizzazione, e pretende che ci arrivi.

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'token-di-prova-lungo-abbastanza';
const HOST = '127.0.0.1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let child = null;
let port = null;
let origin = null;
let logFile = null;

test.before(async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-discovery-'));
  const project = path.join(rootDir, 'progetto');
  fs.mkdirSync(project);
  logFile = path.join(rootDir, 'log');
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const chosen = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  port = chosen;
  origin = `http://127.0.0.1:${chosen}`;

  child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
    env: {
      ...serverEnv(),
      CR_TOKEN: TOKEN,
      CR_PORT: String(chosen),
      CR_ISSUER_URL: origin,
      CR_RESOURCE_URL: `${origin}/mcp`,
      // L'host dichiarato è questo, così valgono anche i lock di superficie: la scoperta deve
      // funzionare **sul** host della macchina, che è l'unico su cui ChatGPT parla.
      CR_MCP_HOST: HOST,
      CR_CLAUDE_CMD: process.execPath,
      CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
      CR_DEFAULT_PROJECT: project,
      CR_ALLOWED_ROOTS: rootDir,
      CR_STATE_FILE: path.join(rootDir, 'sessions.json'),
      CR_TURN_JOURNAL_FILE: path.join(rootDir, 'turns.json'),
      CR_PROJECTS_ROOT: path.join(rootDir, 'projects'),
      CR_LOG_FILE: logFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  const deadline = Date.now() + 20_000;
  let up = null;
  while (Date.now() < deadline && !up) {
    const line = /WRA on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    if (line) up = Number(line[1]);
    else await sleep(100);
  }
  assert.ok(up, `il server non è partito:\n${out}`);
});

test.after(() => {
  child?.kill();
});

// `Host` è l'unica cosa che distingue una richiesta arrivata dal tunnel, e `fetch` non lascia
// scriverla: le richieste si fanno a mano, come fa il banco dei lock di superficie.
const ask = (route, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const request = http.request({
    host: '127.0.0.1', port, path: route, method,
    headers: { host: HOST, ...headers },
  }, (response) => {
    let text = '';
    response.on('data', (chunk) => { text += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
  });
  request.on('error', reject);
  if (body) request.write(body);
  request.end();
});

const json = (text) => { try { return JSON.parse(text); } catch { return null; } };

test('il documento della risorsa risponde sia alla radice sia col percorso, e sono lo stesso', async () => {
  const radice = await ask('/.well-known/oauth-protected-resource');
  const percorso = await ask('/.well-known/oauth-protected-resource/mcp');
  assert.equal(radice.status, 200, `la radice risponde ${radice.status}: è il percorso che la documentazione di ChatGPT chiama`);
  assert.equal(percorso.status, 200);

  const a = json(radice.text);
  const b = json(percorso.text);
  assert.deepEqual(a, b, 'i due percorsi servono due documenti diversi');
  assert.equal(a.resource, `${origin}/mcp`, 'la risorsa è l\'indirizzo pubblico dell\'MCP');
  assert.deepEqual(a.authorization_servers, [`${origin}/`], 'e dichiara dove sta il server di autorizzazione');
  assert.deepEqual(a.scopes_supported, ['talk'], 'con lo scope che serve');
});

test('l\'issuer dei metadati è **esattamente** quello che il documento della risorsa dichiara', async () => {
  // Il confronto lo fa il client, ed è una stringa: uno slash di differenza e il collegamento non
  // parte più. Qui si guarda che i due documenti dicano la stessa cosa, carattere per carattere.
  const as = json((await ask('/.well-known/oauth-authorization-server')).text);
  const prm = json((await ask('/.well-known/oauth-protected-resource')).text);
  assert.equal(as.issuer, prm.authorization_servers[0], `issuer «${as.issuer}» ≠ authorization_servers[0] «${prm.authorization_servers[0]}»`);
});

test('i metadati del server di autorizzazione rispondono anche nella posizione OIDC', async () => {
  // La piattaforma di OpenAI ha chiesto **nove volte** `/.well-known/openid-configuration` prendendo
  // 404, e poi si è arresa senza registrare nessun client. Non si inventa un OpenID Provider: si
  // serve lo stesso documento dell'altra posizione. Che è la cosa che dice anche la documentazione
  // di OpenAI («publish discovery metadata at either the OAuth 2.0 or OIDC well-known location»).
  const oauth = await ask('/.well-known/oauth-authorization-server');
  const oidc = await ask('/.well-known/openid-configuration');
  assert.equal(oidc.status, 200, `openid-configuration risponde ${oidc.status}: era il primo fallimento determinante`);
  assert.deepEqual(json(oidc.text), json(oauth.text), 'i due percorsi servono due documenti diversi');
});

test('nella posizione OIDC non si dichiara niente che non si sia', async () => {
  // «Non aggiungere un endpoint OIDC fittizio»: quello che si serve è il documento OAuth 2.0 del
  // server di autorizzazione, che non è un OpenID Provider e non lo dice di essere. Se un giorno
  // qualcuno aggiungesse `userinfo_endpoint` o `id_token_signing_alg_values_supported` senza
  // implementarli, un client ci crederebbe e il collegamento si romperebbe più avanti, in un punto
  // più difficile da capire.
  const documento = json((await ask('/.well-known/openid-configuration')).text);
  for (const campo of ['userinfo_endpoint', 'id_token_signing_alg_values_supported', 'jwks_uri', 'end_session_endpoint', 'claims_supported']) {
    assert.equal(documento[campo], undefined, `«${campo}» dichiarato senza esistere`);
  }
  assert.ok(!(documento.scopes_supported ?? []).includes('openid'), 'lo scope `openid` non si dichiara se non si emette un id_token');
  // E quello che invece serve al giro c'è tutto.
  assert.ok(documento.authorization_endpoint && documento.token_endpoint && documento.registration_endpoint);
});

test('la sequenza che ha fatto la piattaforma di OpenAI arriva in fondo', async () => {
  // La cronologia vera, ricostruita dal log: un POST /mcp, poi la scoperta, e si fermava sulla
  // terza tappa. Questo caso la cammina tutta, e pretende che nessuna tappa sia un 404.
  const primo = await ask('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(primo.status, 401, '1. il primo passo è un 401 col challenge');
  const dove = /resource_metadata="([^"]+)"/.exec(String(primo.headers['www-authenticate'] ?? ''))?.[1];
  assert.ok(dove, '2. il challenge dice dove sta il documento della risorsa');
  assert.equal((await ask(new URL(dove).pathname)).status, 200, '2. la resource metadata risponde');
  assert.equal((await ask('/.well-known/oauth-protected-resource')).status, 200, '2b. e anche alla radice');
  assert.equal((await ask('/.well-known/oauth-authorization-server')).status, 200, '3. i metadati del server di autorizzazione rispondono');
  assert.equal((await ask('/.well-known/openid-configuration')).status, 200, '4. e anche nella posizione OIDC — qui si fermava');
});

test('i metadati dichiarano tutto quello che serve al giro (e niente di più)', async () => {
  const as = json((await ask('/.well-known/oauth-authorization-server')).text);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256'], 'PKCE S256 è obbligatorio');
  assert.deepEqual(as.response_types_supported, ['code']);
  assert.match(String(as.authorization_endpoint), /\/authorize$/);
  assert.match(String(as.token_endpoint), /\/token$/);
  assert.match(String(as.registration_endpoint), /\/register$/, 'senza registrazione dinamica ChatGPT non può registrarsi da sé');
  assert.ok(as.grant_types_supported.includes('authorization_code') && as.grant_types_supported.includes('refresh_token'));
  assert.ok(as.token_endpoint_auth_methods_supported.includes('none'), 'un client pubblico deve potersi autenticare con `none`');
  assert.deepEqual(as.scopes_supported, ['talk']);
  // Quello che NON si dichiara: se un giorno si aggiunge `authorization_response_iss_parameter_supported`
  // bisogna restituire `iss` in ogni risposta; dichiararlo senza farlo è peggio che tacerlo.
  assert.equal(as.authorization_response_iss_parameter_supported, undefined);
});

test('un /mcp senza token manda il client al documento, e quell\'indirizzo risponde', async () => {
  const risposta = await ask('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(risposta.status, 401, 'il primo passo di ogni client: 401, non 404');
  const challenge = String(risposta.headers['www-authenticate'] ?? '');
  assert.match(challenge, /Bearer/);
  assert.match(challenge, /scope="talk"/, `il challenge dice quali scope servono: ${challenge}`);
  const dove = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  assert.ok(dove, `il challenge indica dove sta il documento: ${challenge}`);
  const documento = await ask(new URL(dove).pathname);
  assert.equal(documento.status, 200, `l'indirizzo indicato nel challenge risponde ${documento.status}: ${dove}`);
  assert.equal(json(documento.text).resource, `${origin}/mcp`);
  // E anche la radice, che è quella che ChatGPT chiama per conto suo.
  assert.equal((await ask('/.well-known/oauth-protected-resource')).status, 200);
});

test('sull\'host della macchina il sito resta chiuso (la scoperta non ha aperto niente)', async () => {
  for (const route of ['/', '/app.js', '/local/sessions', '/healthz']) {
    assert.equal((await ask(route)).status, 404, `${route} è raggiungibile sull'host pubblico`);
  }
});

test('un client MCP vero arriva alla pagina di autorizzazione partendo da zero', async () => {
  // La prova che conta: non si simulano le richieste una per una, si lascia fare al client. Se
  // una sola cosa della scoperta o della registrazione non va, questo non arriva in fondo.
  const stato = { client: undefined, verifier: '', authorizationUrl: null };
  const chiamate = [];
  const loggingFetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const response = await fetch(request);
    chiamate.push(`${request.method} ${new URL(request.url).pathname} → ${response.status}`);
    return response;
  };
  const provider = {
    get redirectUrl() { return 'https://chatgpt.com/connector_platform_oauth_redirect'; },
    get clientMetadata() {
      return {
        client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: 'none', scope: 'talk',
      };
    },
    clientInformation: () => stato.client,
    saveClientInformation: (info) => { stato.client = info; },
    tokens: () => undefined,
    saveTokens: () => {},
    redirectToAuthorization: (authorizationUrl) => { stato.authorizationUrl = authorizationUrl; },
    saveCodeVerifier: (verifier) => { stato.verifier = verifier; },
    codeVerifier: () => stato.verifier,
  };

  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider, fetch: loggingFetch });
  const client = new Client({ name: 'chatgpt-di-prova', version: '1.0.0' });

  await assert.rejects(() => client.connect(transport), /Unauthorized/, `il client doveva fermarsi sul 401, non su altro:\n${chiamate.join('\n')}`);
  assert.ok(stato.client?.client_id, `il client non si è registrato:\n${chiamate.join('\n')}`);
  assert.equal(stato.client.scope, 'talk');
  assert.ok(stato.authorizationUrl, `il client non è arrivato alla pagina di autorizzazione:\n${chiamate.join('\n')}`);

  const url = new URL(stato.authorizationUrl);
  assert.equal(url.pathname, '/authorize');
  assert.equal(url.searchParams.get('client_id'), stato.client.client_id);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.get('scope'), 'talk');
  assert.equal(url.searchParams.get('resource'), `${origin}/mcp`, 'la risorsa richiesta è quella che il documento dichiara');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://chatgpt.com/connector_platform_oauth_redirect');
  // Nessuna delle chiamate della scoperta è finita in un errore.
  assert.deepEqual(chiamate.filter((riga) => !/→ (200|201|401)$/.test(riga)), [], chiamate.join(' | '));
});

test('la superficie OAuth lascia una traccia leggibile, e solo quando serve', async () => {
  // Il client di ChatGPT dice «il server ha negato l'accesso» e non lascia nient'altro: senza
  // questa traccia, la volta dopo si torna a indovinare. Si pretende che ci siano le righe che
  // servono (un 401 e una registrazione) e che **non** ci sia il resto.
  const prima = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').length : 0;
  await ask('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  // La scoperta riuscita si dice **una volta sola per percorso**: due richieste, una riga al
  // massimo — un endpoint pubblico non deve poter riempire il log ripetendo la stessa cosa.
  await ask('/.well-known/oauth-protected-resource');
  await ask('/.well-known/oauth-protected-resource');
  const registrato = await ask('/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(registrato.status, 201);
  await sleep(300); // il log si scrive alla fine della risposta, non al ritorno della richiesta

  const dopo = fs.readFileSync(logFile, 'utf8').slice(prima);
  assert.match(dopo, /"method":"POST","path":"\/mcp","status":401/, `manca la riga del 401: «${dopo}»`);
  assert.match(dopo, /"method":"POST","path":"\/register","status":201/, `manca la riga della registrazione: «${dopo}»`);
  const scoperte = (dopo.match(/oauth-protected-resource/g) ?? []).length;
  assert.ok(scoperte <= 1, `la scoperta riuscita dev'essere al massimo una riga, sono ${scoperte}: «${dopo}»`);
  assert.ok(dopo.includes('"chi":') || dopo.includes('"chi"'), 'la traccia non dice chi ha chiesto');
  assert.ok(!dopo.includes(TOKEN), 'il log non deve contenere il token');
  // Il percorso scritto è quello **chiesto**, non quello in cui l'abbiamo trasformato: se il
  // log dicesse `oauth-authorization-server` per una richiesta a `openid-configuration`, la
  // cronologia non direbbe più cosa ha chiesto il client — che è l'unica cosa che serve.
  const tutto = fs.readFileSync(logFile, 'utf8');
  assert.match(tutto, /"path":"\/\.well-known\/openid-configuration","status":200/,
    'la traccia non riporta il percorso chiesto (openid-configuration)');

  // E `/authorize` si scrive **anche quando risponde 200**: è il passo che la persona deve vedere,
  // e una risposta 200 lo farebbe sparire dal log proprio quando serve sapere se è arrivato.
  await ask('/authorize?response_type=code&client_id=x', { headers: { accept: 'text/html' } });
  await sleep(300);
  const conAuthorize = fs.readFileSync(logFile, 'utf8');
  assert.match(conAuthorize, /"method":"GET","path":"\/authorize","status":200/,
    'una richiesta ad /authorize andata bene non compare nella traccia');
});