import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeStore, redirectAllowed } from '../src/mcp/auth/store.mjs';
import { BridgeOAuthProvider } from '../src/mcp/auth/provider.mjs';
import { createConsentGate, createOwner, sameToken } from '../src/net/ui-auth.mjs';

const HOSTS = ['chatgpt.com', 'openai.com'];
const CLIENT = { client_id: 'client-1', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] };

function newStore(overrides = {}) {
  return new BridgeStore({
    allowedRedirectHosts: HOSTS,
    codeTtlMs: 60_000,
    accessTokenTtlS: 3600,
    refreshTokenTtlS: 86_400,
    scope: 'talk',
    resourceUrl: 'https://mcp.example.com/mcp',
    ...overrides,
  });
}

function newProvider(store = newStore()) {
  return { store, provider: new BridgeOAuthProvider({ store, scope: 'talk' }) };
}

function fakeRes(identity = { sub: 'user-1', email: 'me@example.com' }) {
  const captured = {};
  return {
    captured,
    req: { accessIdentity: identity },
    redirect(status, url) {
      captured.status = status;
      captured.url = url;
    },
  };
}

test('redirectAllowed: l host si confronta esatto, non per suffisso', () => {
  const hosts = ['chatgpt.com', 'openai.com'];
  assert.equal(redirectAllowed('https://chatgpt.com/cb', hosts), true);
  assert.equal(redirectAllowed('https://chatgpt.com.evil.example/cb', hosts), false, 'suffisso finto');
  assert.equal(redirectAllowed('https://qualcosa.openai.com/cb', hosts), false, 'sottodominio non dichiarato');
  assert.equal(redirectAllowed('https://x.openai.com/cb', ['*.openai.com']), true, 'col jolly esplicito si');
  assert.equal(redirectAllowed('https://openai.com/cb', ['*.openai.com']), false, 'il dominio nudo no');
  assert.equal(redirectAllowed('http://chatgpt.com/cb', hosts), false, 'solo https');
});

test('redirectAllowed accetta solo https su host in allowlist', () => {
  assert.equal(redirectAllowed('https://chatgpt.com/cb', HOSTS), true);
  // il sottodominio non dichiarato non passa più: era la porta per farsi consegnare il codice
  // da un redirect aperto o da un XSS su un sottodominio qualsiasi
  assert.equal(redirectAllowed('https://sub.chatgpt.com/cb', HOSTS), false);
  assert.equal(redirectAllowed('http://chatgpt.com/cb', HOSTS), false);
  assert.equal(redirectAllowed('https://evil.com/cb', HOSTS), false);
  assert.equal(redirectAllowed('https://chatgpt.com.evil.com/cb', HOSTS), false);
  assert.equal(redirectAllowed('non-un-url', HOSTS), false);
});

test('la registrazione rifiuta un redirect_uri fuori allowlist', () => {
  const store = newStore();
  assert.throws(() => store.registerClient({ client_id: 'c1', redirect_uris: ['https://evil.com/cb'] }), /not allowed/);
  assert.throws(() => store.registerClient({ client_id: 'c1', redirect_uris: [] }), /redirect_uri/);
  const registered = store.registerClient(CLIENT);
  assert.equal(registered.client_id, 'client-1');
  assert.equal(store.getClient('client-1').redirect_uris.length, 1);
});

test('i token non si salvano in chiaro e scadono', async () => {
  const store = newStore({ accessTokenTtlS: 0 });
  const tokens = store.issueTokens({ subject: 'u1', email: 'a@b.c', clientId: 'client-1' });
  assert.ok(tokens.access_token.length > 20);
  assert.ok(tokens.refresh_token.length > 20);
  assert.equal(store.getAccess(tokens.access_token), undefined, 'TTL 0 = già scaduto');
  assert.equal(store.getAccess('token-inventato'), undefined);

  const live = newStore();
  const real = live.issueTokens({ subject: 'u1', email: 'a@b.c', clientId: 'client-1' });
  assert.ok(live.getAccess(real.access_token));
  assert.equal(live.getAccess('altro-token'), undefined);
});

test('il refresh token è monouso, e il secondo uso si riconosce come riuso', () => {
  const store = newStore();
  const tokens = store.issueTokens({ subject: 'u1', email: 'a@b.c', clientId: 'client-1' });
  const first = store.takeRefresh(tokens.refresh_token);
  assert.ok(first);

  // Non torna `undefined`: torna un record marcato `reused`. La differenza è tutto — con
  // `undefined` un riuso sarebbe indistinguibile da un token inventato, e non ci sarebbe niente
  // da revocare.
  const again = store.takeRefresh(tokens.refresh_token);
  assert.equal(again?.reused, true, 'il riuso si riconosce');
  assert.equal(again.family, first.family, 'e dice di che famiglia è');
});

test('la rotazione continua nella stessa famiglia, e il riuso la fa cadere tutta', async () => {
  const { store, provider } = newProvider();
  const first = store.issueTokens({ subject: 'u1', email: 'a@b.c', clientId: CLIENT.client_id });

  const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token);
  assert.notEqual(second.refresh_token, first.refresh_token, 'il refresh ruota');
  assert.ok(await provider.verifyAccessToken(second.access_token), 'e il nuovo access funziona');

  // Qualcuno rigioca il refresh vecchio: è il segnale che una copia è in giro.
  await assert.rejects(provider.exchangeRefreshToken(CLIENT, first.refresh_token), /already used|revoked/);

  // Da qui in giù non vale più niente: né il refresh nuovo né l'access emesso adesso.
  await assert.rejects(provider.verifyAccessToken(second.access_token), /invalid/);
  await assert.rejects(provider.exchangeRefreshToken(CLIENT, second.refresh_token), /invalid/);
});

test('un client non può revocare i token di un altro', async () => {
  const { store, provider } = newProvider();
  const tokens = store.issueTokens({ subject: 'u1', email: 'a@b.c', clientId: 'client-1' });
  await provider.revokeToken({ client_id: 'client-2' }, { token: tokens.access_token });
  assert.ok(await provider.verifyAccessToken(tokens.access_token), 'il token di un altro resta vivo');

  await provider.revokeToken(CLIENT, { token: tokens.access_token });
  await assert.rejects(provider.verifyAccessToken(tokens.access_token), /invalid/, 'col suo client sì');
});

test('il token porta scritta la risorsa per cui è stato emesso', async () => {
  const { store, provider } = newProvider();
  const tokens = store.issueTokens({ subject: 'u1', email: 'a@b.c', clientId: 'client-1' });
  const info = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.resource.href, 'https://mcp.example.com/mcp',
    'così il controllo del middleware ha qualcosa di vero da confrontare');
});

test('revokeToken invalida il token presentato, non l altro', async () => {
  const { store, provider } = newProvider();
  const tokens = store.issueTokens({ subject: 'u1', email: 'a@b.c', clientId: 'client-1' });
  await provider.revokeToken(CLIENT, { token: tokens.access_token });
  await assert.rejects(provider.verifyAccessToken(tokens.access_token), /invalid/);
  assert.ok(store.getRefresh(tokens.refresh_token), 'il refresh resta vivo finché non lo si revoca');

  await provider.revokeToken(CLIENT, { token: tokens.refresh_token });
  assert.equal(store.getRefresh(tokens.refresh_token), undefined);
});

test('authorize emette code e redirect, e senza identità Access non fa nulla', async () => {
  const { provider } = newProvider();
  const params = {
    state: 'stato-1',
    codeChallenge: 'challenge-abc',
    redirectUri: CLIENT.redirect_uris[0],
  };

  await assert.rejects(
    provider.authorize(CLIENT, params, fakeRes(null)),
    /Cloudflare Access identity missing/,
  );

  const res = fakeRes();
  await provider.authorize(CLIENT, params, res);
  assert.equal(res.captured.status, 302);
  const url = new URL(res.captured.url);
  assert.equal(url.origin, 'https://chatgpt.com');
  assert.equal(url.searchParams.get('state'), 'stato-1');
  const code = url.searchParams.get('code');
  assert.ok(code);
  assert.equal(await provider.challengeForAuthorizationCode(CLIENT, code), 'challenge-abc');
});

test('lo scambio del code è monouso e legato a client e redirect', async () => {
  const { provider, store } = newProvider();
  const params = { codeChallenge: 'challenge-abc', redirectUri: CLIENT.redirect_uris[0] };
  const res = fakeRes();
  await provider.authorize(CLIENT, params, res);
  const code = new URL(res.captured.url).searchParams.get('code');

  await assert.rejects(provider.exchangeAuthorizationCode({ client_id: 'altro' }, code), /client mismatch/);
  await assert.rejects(
    provider.exchangeAuthorizationCode(CLIENT, code, undefined, 'https://chatgpt.com/altro'),
    /redirect_uri mismatch/,
  );

  const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, undefined, CLIENT.redirect_uris[0]);
  assert.ok(tokens.access_token);
  await assert.rejects(provider.exchangeAuthorizationCode(CLIENT, code), /already used/);
  assert.equal(store.getCode(code), undefined);
});

test('verifyAccessToken riporta resource, clientId e scopes', async () => {
  const { store, provider } = newProvider();
  const tokens = store.issueTokens({ subject: 'u1', email: 'a@b.c', clientId: 'client-1' });
  const info = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.clientId, 'client-1');
  assert.deepEqual(info.scopes, ['talk']);
  assert.equal(info.resource.href, 'https://mcp.example.com/mcp');
  assert.ok(info.expiresAt > Math.floor(Date.now() / 1000));
});

test('exchangeRefreshToken rifiuta un token di un altro client', async () => {
  const { store, provider } = newProvider();
  const tokens = store.issueTokens({ subject: 'u1', email: 'a@b.c', clientId: 'client-1' });
  await assert.rejects(provider.exchangeRefreshToken({ client_id: 'altro' }, tokens.refresh_token), /invalid/);
  const fresh = await provider.exchangeRefreshToken(CLIENT, tokens.refresh_token);
  assert.ok(fresh.access_token);
});

// --- il gate umano, e il consenso -------------------------------------------

const fakeResponse = () => {
  const seen = [];
  const response = {
    seen,
    status(code) { seen.push(['status', code]); return response; },
    type(value) { seen.push(['type', value]); return response; },
    json(body) { seen.push(['json', body]); return response; },
    send(body) { seen.push(['send', String(body)]); return response; },
    setHeader(name, value) { seen.push(['header', name, value]); return response; },
    redirect(to) { seen.push(['redirect', to]); return response; },
  };
  return response;
};

const fakeRequest = ({ method = 'GET', headers = {}, query = {}, body = null, url = '/' } = {}) => ({
  method,
  headers,
  query,
  body,
  originalUrl: url,
  secure: false,
  get(name) { return headers[name.toLowerCase()]; },
});

test("il gate: col token si passa, e si porta dietro l'identita' che il provider aspetta", () => {
  const owner = createOwner({ token: 'segretissimo' });
  const request = fakeRequest({ headers: { 'x-cc-remote-token': 'segretissimo' } });
  let passed = false;
  owner.gate(request, fakeResponse(), () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(request.accessIdentity.sub, 'owner');
});

test('il gate: un browser senza token riceve la paginetta, una chiamata riceve 401', () => {
  const owner = createOwner({ token: 'segretissimo' });

  const browser = fakeResponse();
  owner.gate(fakeRequest({ headers: { accept: 'text/html' }, url: '/authorize?x=1' }), browser, () => {
    browser.seen.push(['next', true]);
  });
  assert.equal(browser.seen.some(([what]) => what === 'send'), true, 'deve mostrare la pagina');
  assert.equal(browser.seen.some(([what, value]) => what === 'send' && value.includes('/authorize/login')), true);

  const api = fakeResponse();
  owner.gate(fakeRequest({ method: 'POST' }), api, () => api.seen.push(['next', true]));
  assert.equal(api.seen.some(([what]) => what === 'json'), true, 'a una chiamata si risponde 401');
});

test('il login: cookie opaco (non il token), Secure solo in HTTPS, e nessun open redirect', () => {
  const owner = createOwner({ token: 'segretissimo' });

  const wrong = fakeResponse();
  owner.login(fakeRequest({ method: 'POST', body: { token: 'no', next: '/authorize?a=1' } }), wrong);
  assert.equal(wrong.seen.some(([what, value]) => what === 'status' && value === 401), true);
  assert.equal(wrong.seen.some(([what]) => what === 'header'), false, 'senza token giusto non si lascia il cookie');

  const right = fakeResponse();
  owner.login(fakeRequest({ method: 'POST', body: { token: 'segretissimo', next: '/authorize?a=1' } }), right);
  const cookie = right.seen.find(([what, name]) => what === 'header' && name === 'Set-Cookie')?.[2] ?? '';
  assert.match(cookie, /cc_remote_owner=[0-9a-f]{48}/, 'il cookie e\' un identificativo, non il token');
  assert.equal(cookie.includes('segretissimo'), false, 'il token non deve finire nel cookie');
  assert.equal(/Secure/.test(cookie), false, 'su http il cookie Secure non verrebbe rispedito');
  assert.equal(right.seen.some(([what, value]) => what === 'redirect' && value === '/authorize?a=1'), true);

  const id = cookie.match(/cc_remote_owner=([0-9a-f]{48})/)[1];
  let passed = false;
  owner.gate(fakeRequest({ headers: { cookie: `cc_remote_owner=${id}` } }), fakeResponse(), () => { passed = true; });
  assert.equal(passed, true, 'il cookie deve valere come il token');

  for (const evil of ['https://evil.example', '//evil.example', '/\\evil.example']) {
    const response = fakeResponse();
    owner.login(fakeRequest({ method: 'POST', body: { token: 'segretissimo', next: evil } }), response);
    assert.equal(response.seen.some(([what, value]) => what === 'redirect' && value === '/'), true, `${evil} non deve passare`);
  }

  const secure = fakeResponse();
  owner.login(fakeRequest({ method: 'POST', headers: { 'x-forwarded-proto': 'https' }, body: { token: 'segretissimo', next: '/' } }), secure);
  const secureCookie = secure.seen.find(([what, name]) => what === 'header' && name === 'Set-Cookie')?.[2] ?? '';
  assert.match(secureCookie, /Secure/);
});

test('un cookie malformato non fa esplodere la richiesta, e non autentica', () => {
  const owner = createOwner({ token: 'segretissimo' });
  const response = fakeResponse();
  let passed = false;
  owner.gate(fakeRequest({ headers: { cookie: 'cc_remote_owner=%' } }), response, () => { passed = true; });
  assert.equal(passed, false, 'un cookie rotto non e\' una sessione');
  assert.equal(response.seen.some(([what]) => what === 'json'), true);
});

test("il consenso: senza approvazione il codice non nasce, e vale una volta sola", () => {
  const consent = createConsentGate();
  const query = { client_id: 'chatgpt', redirect_uri: 'https://chatgpt.com/cb', code_challenge: 'abc', state: 's' };

  const first = fakeResponse();
  let proceeded = false;
  consent.handleGet(fakeRequest({ query, url: '/authorize?client_id=chatgpt' }), first, () => { proceeded = true; });
  assert.equal(proceeded, false, 'la prima volta si chiede');
  const page = first.seen.find(([what]) => what === 'send')?.[1] ?? '';
  assert.match(page, /chatgpt/, 'la pagina deve dire a chi si sta dando l\'accesso');
  assert.match(page, /chatgpt\.com\/cb/, 'e dove tornera\' il codice');
  const nonce = page.match(/name="nonce" value="([0-9a-f]+)"/)?.[1];
  assert.ok(nonce, 'la pagina deve portare un nonce');

  const denied = fakeResponse();
  consent.handlePost(fakeRequest({ method: 'POST', body: { nonce, next: '/authorize?client_id=chatgpt', decision: 'deny' } }), denied);
  assert.equal(denied.seen.some(([what]) => what === 'redirect'), false, 'rifiutando non si torna al flusso');

  const fresh = fakeResponse();
  consent.handleGet(fakeRequest({ query, url: '/authorize?client_id=chatgpt' }), fresh, () => {});
  const freshPage = fresh.seen.find(([what]) => what === 'send')?.[1] ?? '';
  const freshNonce = freshPage.match(/name="nonce" value="([0-9a-f]+)"/)?.[1];

  const allowed = fakeResponse();
  consent.handlePost(fakeRequest({ method: 'POST', body: { nonce: freshNonce, next: '/authorize?client_id=chatgpt', decision: 'allow' } }), allowed);
  assert.equal(allowed.seen.some(([what]) => what === 'redirect'), true, 'approvando si torna al flusso');

  let nowProceeds = false;
  consent.handleGet(fakeRequest({ query, url: '/authorize?client_id=chatgpt' }), fakeResponse(), () => { nowProceeds = true; });
  assert.equal(nowProceeds, true, 'col consenso dato, la richiesta prosegue');

  let again = false;
  consent.handleGet(fakeRequest({ query, url: '/authorize?client_id=chatgpt' }), fakeResponse(), () => { again = true; });
  assert.equal(again, false, 'il consenso vale per una richiesta sola');
});

test('sameToken non accetta token di lunghezza diversa ne vuoti', () => {
  assert.equal(sameToken('abc', 'abc'), true);
  assert.equal(sameToken('abc', 'abcd'), false);
  assert.equal(sameToken('', ''), false);
  assert.equal(sameToken('abc', undefined), false);
});
