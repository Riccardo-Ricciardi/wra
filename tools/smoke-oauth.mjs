// Il giro OAuth completo **attraverso un indirizzo HTTPS vero**, con un proxy in mezzo.
//
// È diverso dal test automatico (`test/oauth-flow.test.mjs`), che gira su 127.0.0.1: qui passa
// dal proxy (Tailscale adesso, Cloudflare per ChatGPT), quindi si vedono le cose che solo lì
// si rompono — intestazioni inoltrate, cookie `Secure`, indirizzi costruiti dall'issuer, la
// scoperta raggiunta da fuori.
//
//   node tools/smoke-oauth.mjs https://il-tuo-indirizzo
//
// Il token della persona si legge da ~/.cc-remote/token. Non lo stampa e non lo scrive.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('uso: node tools/smoke-oauth.mjs https://il-tuo-indirizzo');
  process.exit(1);
}

const owner = process.env.CR_TOKEN
  || (() => {
    try {
      return fs.readFileSync(path.join(os.homedir(), '.cc-remote', 'token'), 'utf8').trim();
    } catch {
      return '';
    }
  })();
if (!owner) {
  console.error('nessun token: avvia il server con `rc start`');
  process.exit(1);
}

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? ' ok ' : 'NO  '} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

const get = async (route, options = {}) => {
  const response = await fetch(`${base}${route}`, { redirect: 'manual', ...options });
  const text = await response.text().catch(() => '');
  return { status: response.status, headers: response.headers, text, location: response.headers.get('location') };
};

try {
  // 1. la scoperta, da fuori
  const as = await get('/.well-known/oauth-authorization-server');
  check('i metadati di autorizzazione sono pubblici', as.status === 200, `http ${as.status}`);
  const asBody = JSON.parse(as.text || '{}');
  check("l'issuer è l'indirizzo pubblico", String(asBody.issuer ?? '').replace(/\/$/, '') === base, asBody.issuer);
  check("l'endpoint di autorizzazione è pubblico", String(asBody.authorization_endpoint ?? '').startsWith(base));

  const rs = await get('/.well-known/oauth-protected-resource/mcp');
  const rsBody = JSON.parse(rs.text || '{}');
  check('la risorsa dichiarata è questo MCP', rsBody.resource === `${base}/mcp`, rsBody.resource);

  // 2. /mcp chiuso, e dice dove andare a prendere il token
  const bare = await fetch(`${base}/mcp`, { method: 'POST', redirect: 'manual' });
  check('/mcp senza token è 401 (del nostro server, non del proxy)', bare.status === 401,
    `http ${bare.status}${bare.status === 302 ? ' → è il proxy: la regola di bypass non è di tipo Bypass' : ''}`);
  check('e indica i metadati della risorsa', /resource_metadata=/.test(bare.headers.get('www-authenticate') ?? ''));

  // 3. la registrazione
  const registered = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'prova-da-fuori', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  const client = await registered.json().catch(() => null);
  check('un client si registra da fuori', registered.status === 201 && Boolean(client?.client_id), `http ${registered.status}`);

  const badRedirect = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }),
  });
  check("e uno con redirect fuori elenco viene rifiutato", badRedirect.status >= 400, `http ${badRedirect.status}`);

  // 4. il gate della persona
  const gate = await get(`/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}`);
  check('senza il token di cc-remote, /authorize non concede niente',
    gate.status !== 302 || !String(gate.location ?? '').includes('code'), `http ${gate.status}`);

  const login = await fetch(`${base}/authorize/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: owner, next: '/authorize' }).toString(),
    redirect: 'manual',
  });
  const cookieHeader = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie') ?? '';
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
  const page = await get(`/authorize?${query}`, { headers: { cookie } });
  check('la pagina di consenso si apre', page.status === 200 && /chiede di poter parlare/.test(page.text), `http ${page.status}`);

  const nonce = /name="nonce" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
  const next = (/name="next" value="([^"]*)"/.exec(page.text)?.[1] ?? '').replace(/&amp;/g, '&');
  const approved = await fetch(`${base}/authorize/consent`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nonce, next, decision: 'allow' }).toString(),
    redirect: 'manual',
  });
  const issued = await get(next, { headers: { cookie } });
  const back = new URL(issued.location ?? 'https://vuoto.invalid/');
  check('il codice torna al redirect dichiarato', back.origin === 'https://chatgpt.com' && back.searchParams.get('state') === state,
    issued.location ?? `http ${issued.status}`);
  const code = back.searchParams.get('code') ?? '';

  const tokenResponse = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      client_id: client.client_id, redirect_uri: REDIRECT,
    }).toString(),
  });
  const tokens = await tokenResponse.json().catch(() => null);
  check('il codice si scambia con un token', tokenResponse.status === 200 && Boolean(tokens?.access_token), `http ${tokenResponse.status}`);

  // 6. e con quel token si parla con MCP, da fuori
  const listed = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens?.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const body = await listed.json().catch(() => null);
  const names = (body?.result?.tools ?? []).map((tool) => tool.name).sort();
  check('e MCP risponde con i quattro strumenti', listed.status === 200 && names.length === 4,
    `http ${listed.status} — ${names.join(', ') || JSON.stringify(body).slice(0, 80)}`);

  // 7. e si revoca — **tutti e due** i token. Revocare solo l'access lascerebbe vivo un refresh
  // per trenta giorni: è la prova che gira sulla macchina vera, e non deve lasciare consensi
  // aperti dietro di sé.
  const revoke = (token) => fetch(`${base}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: token ?? '', client_id: client.client_id }).toString(),
  });
  const revoked = await revoke(tokens?.access_token);
  await revoke(tokens?.refresh_token);
  const after = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens?.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  check('la revoca chiude subito', revoked.status === 200 && after.status === 401, `revoca ${revoked.status}, dopo ${after.status}`);
} catch (error) {
  check('giro OAuth da fuori', false, error.message);
}

console.log(`\n${failures === 0 ? 'OAUTH HTTPS PASS' : `OAUTH HTTPS FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
