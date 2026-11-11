// Il giro OAuth completo **attraverso l'hostname pubblico**, con l'header `Host` che manda
// Cloudflare. Serve a una cosa sola, e vera: dimostrare che il guard dell'host non rompe ciò
// per cui il bridge esiste — la scoperta, la registrazione, il consenso nel browser, il codice
// con PKCE, i token, e una chiamata MCP firmata — mentre tutto il resto è chiuso.
//
//   node tools/smoke-public-host.mjs <porta-locale> <host-pubblico>
//   node tools/smoke-public-host.mjs 0 <host-pubblico>     ← si accende un banco da solo
//
// È una prova locale: parla con 127.0.0.1 e finge l'host. La prova attraverso il tunnel vero è
// `node tools/smoke-oauth.mjs https://<il-tuo-endpoint-mcp>`.
//
// Con la porta a `0` il banco si costruisce il proprio mondo — registro suo, token suo, `%TEMP%`
// suo — e lo porta via alla fine. È il modo di rifare questa prova a ogni modifica senza toccare
// il server vero e senza avere il tunnel su: quello che si sta provando è il **guard dell'host**,
// e il guard non sa se il tunnel c'è.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startBench } from './bench.mjs';

const portaArg = Number(process.argv[2] ?? NaN);
const PUB = process.argv[3] ?? '';
if (!Number.isFinite(portaArg) || !PUB) {
  console.error('uso: node tools/smoke-public-host.mjs <porta-locale|0> <host-pubblico>');
  console.error("  <host-pubblico> è l'hostname del tuo endpoint MCP, senza https:// (es. mcp.tuodominio.com)");
  process.exit(1);
}

const banco = portaArg === 0 ? await startBench({ name: 'host pubblico', publicHost: PUB }) : null;
const port = banco ? banco.port : portaArg;

// Il token del proprietario: quello del banco se c'è un banco, altrimenti `CR_TOKEN`, altrimenti
// quello vero. In nessun caso lo stampa.
const owner = banco?.token
  || process.env.CR_TOKEN
  || (() => {
    try {
      return fs.readFileSync(path.join(os.homedir(), '.cc-remote', 'token'), 'utf8').trim();
    } catch {
      return '';
    }
  })();

const BASE = `https://${PUB}`;
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? ' ok ' : 'NO  '} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

// `Host` è fra le intestazioni che `fetch` riscrive da sé: qui la richiesta si scrive a mano,
// come la scriverebbe Cloudflare.
const call = (route, { method = 'GET', headers = {}, body = null, host = PUB } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method,
      headers: {
        host,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode, headers: response.headers, text, location: response.headers.location,
      }));
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
const form = (route, body, headers = {}) => call(route, {
  method: 'POST',
  body: new URLSearchParams(body).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
});

try {
  // 1. la scoperta, dall'host pubblico
  const as = await call('/.well-known/oauth-authorization-server');
  const asBody = JSON.parse(as.text || '{}');
  check('i metadati di autorizzazione sono pubblici', as.status === 200, `http ${as.status}`);
  check("l'issuer è l'indirizzo pubblico", String(asBody.issuer ?? '').replace(/\/$/, '') === BASE, asBody.issuer);

  const rs = await call('/.well-known/oauth-protected-resource/mcp');
  const rsBody = JSON.parse(rs.text || '{}');
  check('la risorsa dichiarata è questo MCP', rsBody.resource === `${BASE}/mcp`, rsBody.resource);

  // 2. /mcp chiuso, e dice dove andare a prendere il token
  const bare = await call('/mcp', { method: 'POST', body: '{}' });
  check('/mcp senza token è 401 del nostro server', bare.status === 401, `http ${bare.status}`);
  check('e indica i metadati della risorsa', /resource_metadata=/.test(bare.headers['www-authenticate'] ?? ''));

  // 3. la registrazione
  const registered = await call('/register', {
    method: 'POST',
    body: { client_name: 'prova-host-pubblico', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
  });
  const client = JSON.parse(registered.text || '{}');
  check('un client si registra da fuori', registered.status === 201 && Boolean(client.client_id), `http ${registered.status}`);

  const bad = await call('/register', { method: 'POST', body: { redirect_uris: ['https://evil.example/cb'] } });
  check('e uno con redirect fuori elenco viene rifiutato', bad.status >= 400, `http ${bad.status}`);

  // 4. il gate della persona, sull'host pubblico
  const gate = await call(`/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}`);
  check('senza il token di cc-remote, /authorize non concede niente',
    gate.status !== 302 && !String(gate.location ?? '').includes('code'), `http ${gate.status}`);

  const login = await call('/authorize/login', {
    method: 'POST',
    body: new URLSearchParams({ token: owner, next: '/authorize' }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const cookieHeader = login.headers['set-cookie']?.[0] ?? '';
  check('il token personale fa entrare, e il cookie è Secure', login.status === 302 && /cc_remote_owner=/.test(cookieHeader),
    `http ${login.status}, Secure: ${/;\s*Secure/i.test(cookieHeader)}`);
  const cookie = cookieHeader.split(';')[0];

  // 5. consenso, codice, token
  const { verifier, challenge } = pkce();
  const state = crypto.randomUUID();
  const query = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  const page = await call(`/authorize?${query}`, { headers: { cookie } });
  check('la pagina di consenso si apre sull\'host pubblico',
    page.status === 200 && /chiede di poter parlare/.test(page.text), `http ${page.status}`);

  const nonce = /name="nonce" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
  const next = (/name="next" value="([^"]*)"/.exec(page.text)?.[1] ?? '').replace(/&amp;/g, '&');
  await call('/authorize/consent', {
    method: 'POST',
    body: new URLSearchParams({ nonce, next, decision: 'allow' }).toString(),
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const issued = await call(next, { headers: { cookie } });
  const back = new URL(issued.location ?? 'https://vuoto.invalid/');
  check('il codice torna al redirect dichiarato',
    back.origin === 'https://chatgpt.com' && back.searchParams.get('state') === state,
    issued.location ?? `http ${issued.status}`);
  const code = back.searchParams.get('code') ?? '';

  const tokenResponse = await form('/token', {
    grant_type: 'authorization_code', code, code_verifier: verifier,
    client_id: client.client_id, redirect_uri: REDIRECT,
  });
  const tokens = JSON.parse(tokenResponse.text || '{}');
  check('il codice si scambia con un token', tokenResponse.status === 200 && Boolean(tokens.access_token), `http ${tokenResponse.status}`);

  // 6. e con quel token si parla con MCP, dall'host pubblico
  const listed = await call('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
  const names = (JSON.parse(listed.text || '{}')?.result?.tools ?? []).map((tool) => tool.name).sort();
  check('e MCP risponde con i quattro strumenti', listed.status === 200 && names.length === 4,
    `http ${listed.status} — ${names.join(', ') || listed.text.slice(0, 80)}`);

  // 7. la revoca, di tutti e due i token: non si lasciano consensi aperti dietro
  const revoke = (token) => form('/revoke', { token: token ?? '', client_id: client.client_id });
  const revoked = await revoke(tokens.access_token);
  await revoke(tokens.refresh_token);
  const after = await call('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.access_token}` },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  });
  check('la revoca chiude subito', revoked.status === 200 && after.status === 401, `revoca ${revoked.status}, dopo ${after.status}`);

  // 8. e il resto della casa resta chiuso, con lo stesso Host
  const closed = ['/', '/app.js', '/local/sessions', '/healthz'];
  const open = [];
  for (const route of closed) {
    const response = await call(route);
    if (response.status !== 404) open.push(`${route}=${response.status}`);
  }
  check('l\'interfaccia amministrativa non è raggiungibile dall\'host pubblico', open.length === 0,
    open.length ? open.join(', ') : closed.join(', '));
} catch (error) {
  check('giro OAuth sull\'host pubblico', false, error.message);
}

console.log(`\n${failures === 0 ? 'HOST PUBBLICO PASS' : `HOST PUBBLICO FAIL (${failures})`}`);
await banco?.stop();
process.exit(failures === 0 ? 0 : 1);
