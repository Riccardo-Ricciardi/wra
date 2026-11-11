// Un hostname solo che serve tutto: la dashboard e la PWA su `/`, ChatGPT su `/mcp`, OAuth sulle
// sue rotte. La separazione fra le due superfici non sparisce — cambia di forma, da «due hostname»
// a «due politiche sullo stesso hostname, decise per percorso» — e questi sono i controlli che
// dicono che è ancora lì.
//
// Si prova con l'intestazione `Host` che manda Cloudflare, come `tools/smoke-public-host.mjs`:
// così quello che si esercita è il guard, non un indirizzo. E si prova anche il **contrario** —
// un server senza `CR_SINGLE_HOST` — perché la modalità nuova non deve cambiare il comporta-
// mento di chi non l'ha chiesta.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'token-single-host-lungo-abbastanza';
const HOST = 'mcp.esempio-di-prova.com';
const BASE = `https://${HOST}`;
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Un server acceso con la configurazione che si vuole provare. `singleHost` è quello che decide
 * la forma: senza, il server si comporta come si è sempre comportato.
 */
async function startServer({ single, admin = false, remote = false, name }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cc-single-${name}-`));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });

  const env = Object.fromEntries(Object.entries(process.env).filter(([chiave]) => !chiave.startsWith('CR_')));
  Object.assign(env, {
    CR_TOKEN: TOKEN,
    CR_PORT: '0',
    CR_HOST: '127.0.0.1',
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_PROJECTS_FILE: path.join(root, 'projects.json'),
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: project,
    CR_LOG_FILE: path.join(root, 'serve.log'),
    CR_SETTINGS_FILE: path.join(root, 'settings.json'),
    CR_ACCESS_FILE: path.join(root, 'access.json'),
    CR_CLAUDE_CMD: process.execPath,
    CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
    // La superficie pubblica, come la configura il proprietario.
    CR_MCP_HOST: HOST,
    CR_ISSUER_URL: BASE,
    CR_RESOURCE_URL: `${BASE}/mcp`,
    ...(single ? { CR_SINGLE_HOST: '1' } : {}),
    ...(admin ? { CR_SINGLE_HOST_ADMIN: '1' } : {}),
    ...(remote ? { CR_REMOTE_PERMISSIONS: '1' } : {}),
  });

  const serve = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  serve.stdout.setEncoding('utf8').on('data', (c) => { log += c; });
  serve.stderr.setEncoding('utf8').on('data', (c) => { log += c; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !/WRA on http/.test(log)) await sleep(120);
  const port = Number(log.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
  if (!port) throw new Error(`il server non si è acceso: ${log.slice(0, 300)}`);

  return {
    root, port,
    /** Una richiesta **come la manderebbe Cloudflare**: parla con 127.0.0.1, dichiara l'host vero. */
    call: (rotta, { method = 'GET', body = null, headers = {}, host = HOST } = {}) => new Promise((resolve, reject) => {
      const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
      const request = http.request({
        host: '127.0.0.1', port, path: rotta, method,
        headers: {
          host,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text, location: response.headers.location ?? null }));
      });
      request.on('error', reject);
      if (payload) request.write(payload);
      request.end();
    }),
    close: async () => {
      try { serve.kill(); } catch { /* già morto */ }
      await sleep(300);
      for (let tentativo = 0; tentativo < 12; tentativo += 1) {
        try { fs.rmSync(root, { recursive: true, force: true }); return; } catch { await sleep(250); }
      }
    },
  };
}

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

const form = (b, rotta, body, headers = {}) => b.call(rotta, {
  method: 'POST',
  body: new URLSearchParams(body).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
});

test('single-host: anonimo, autorizzato, non autorizzato, e il client ChatGPT', async (t) => {
  const b = await startServer({ single: true, name: 'acceso' });
  t.after(() => b.close());

  // ── 1. anonimo ──────────────────────────────────────────────────────────────────────────────
  // La pagina si apre: è un guscio senza niente dentro, e leggerlo non rivela niente. È lo stesso
  // che succede da `127.0.0.1`, dove il gate è una schermata e non un muro.
  const pagina = await b.call('/');
  assert.equal(pagina.status, 200, 'la dashboard non si apre sull\'host pubblico');
  assert.match(pagina.text, /WRA/, 'la pagina non è quella di WRA');

  // La PWA: manifest, icone, service worker. Senza, «aggiungi alla schermata iniziale» su Android
  // non porta da nessuna parte.
  for (const rotta of ['/app.js', '/app.css', '/manifest.webmanifest', '/icon.svg', '/sw.js']) {
    assert.equal((await b.call(rotta)).status, 200, `${rotta} non è servito sull'host pubblico`);
  }

  // I dati no. Mai. Il token è l'unica porta, e questa è chiusa.
  const elenco = await b.call('/local/sessions');
  assert.equal(elenco.status, 401, `l'elenco delle conversazioni risponde ${elenco.status} a chi non ha il token`);
  const socket = await b.call('/local/projects/open', { method: 'POST', body: { path: b.root } });
  assert.equal(socket.status, 401, 'una rotta che agisce sulla macchina risponde a chi non ha il token');

  // La macchina è chiusa come prima: `/mcp` senza token è 401 **del nostro server**, con scritto
  // dove andare a prendere un token.
  const mcpNudo = await b.call('/mcp', { method: 'POST', body: {} });
  assert.equal(mcpNudo.status, 401, `/mcp risponde ${mcpNudo.status} senza autenticazione`);
  assert.match(mcpNudo.headers['www-authenticate'] ?? '', /resource_metadata=/, 'e non dice dove si prende il token');

  // ── 2. il pannello, senza consenso esplicito ────────────────────────────────────────────────
  // 404 e non 403: da qui il pannello non esiste. Un 403 direbbe che c'è e che non puoi.
  // E si prova scritto in tutti i modi in cui si può scrivere: Express **non distingue le
  // maiuscole** nei percorsi, quindi `/LOCAL/ADMIN/status` arriva alla rotta amministrativa come
  // se fosse scritto bene. Con un confronto che le maiuscole le distingue, quella richiesta
  // passava e rispondeva 200 — con dentro tutto lo stato. Qui l'apertura è «tutto passa tranne»,
  // quindi un confronto sbagliato non è un difetto che si nota: è la porta aperta.
  // Col token in mano si riceve **403 con la spiegazione**: chi è il proprietario merita di sapere
  // perché, invece di un «non trovato» che lo manda a cercare un guasto che non c'è. Il codice
  // resta però un rifiuto, quindi una variante scritta male che *passasse* darebbe 200 e il
  // controllo la prende lo stesso.
  for (const rotta of ['/local/admin/status', '/LOCAL/ADMIN/status', '/Local/Admin/Status', '/local/admin/', '/local/admin/status/']) {
    const pannello = await b.call(rotta, { headers: { 'x-cc-remote-token': TOKEN } });
    assert.equal(pannello.status, 403,
      `${rotta} risponde ${pannello.status} sull'host pubblico senza CR_SINGLE_HOST_ADMIN`);
  }
  // E senza token la stessa rotta è indistinguibile da una che non esiste.
  for (const rotta of ['/local/admin/status', '/LOCAL/ADMIN/status', '/Local/Admin/Status']) {
    const cieco = await b.call(rotta);
    assert.equal(cieco.status, 404, `${rotta} risponde ${cieco.status} a chi non ha il token`);
    assert.doesNotMatch(cieco.text, /CR_SINGLE_HOST_ADMIN|CR_REMOTE_PERMISSIONS/, `${rotta} nomina le variabili a un estraneo`);
  }

  // ── 2b. le modalità che non si espongono ────────────────────────────────────────────────────
  // `bypassPermissions` — l'agente che non chiede mai — e l'apertura di una conversazione a un
  // client esterno. Il token dice **chi sei**, non cosa hai deciso di lasciare acceso: da
  // internet, senza il consenso, non si accendono. Una di queste sta nel **corpo** della
  // richiesta, non nel percorso, e per quella il lock sui percorsi non basterebbe.
  const creata = await b.call('/local/sessions', { method: 'POST', body: {}, headers: { 'x-cc-remote-token': TOKEN } });
  assert.equal(creata.status, 200, `non si riesce nemmeno a creare una conversazione: ${creata.status}`);
  const nuova = JSON.parse(creata.text).session.sessionId;

  for (const [rotta, corpo] of [
    [`/local/sessions/${nuova}/permissions`, { mode: 'bypassPermissions' }],
    [`/local/sessions/${nuova}/auto`, { enabled: true }],
    [`/local/sessions/${nuova}/mcp`, { allowed: true }],
  ]) {
    const risposta = await b.call(rotta, { method: 'POST', body: corpo, headers: { 'x-cc-remote-token': TOKEN } });
    assert.equal(risposta.status, 403, `${rotta} risponde ${risposta.status}: una modalità amministrativa da internet`);
  }
  // Creare una conversazione **con** il bypass resta chiuso anche col consenso stretto: quello
  // apre i permessi di una conversazione che hai già, non la possibilità di crearne una che nasce
  // senza chiedere niente.
  const conBypass = await b.call('/local/sessions', {
    method: 'POST', body: { permissionMode: 'bypassPermissions' }, headers: { 'x-cc-remote-token': TOKEN },
  });
  assert.equal(conBypass.status, 404, 'si crea una conversazione con bypassPermissions dall\'host pubblico');

  // E la conversazione che si è riusciti a creare **non** ha il bypass: il rifiuto non è una
  // risposta di facciata mentre qualcosa è passato lo stesso.
  const elenco2 = JSON.parse((await b.call('/local/sessions', { headers: { 'x-cc-remote-token': TOKEN } })).text).sessions;
  assert.equal(elenco2.find((s) => s.sessionId === nuova)?.permissionMode, 'default',
    'la conversazione creata da fuori ha una modalità che non doveva avere');

  // Il rovescio, che è il rischio vero di questa protezione: `cc` crea le sue conversazioni col
  // bypass **da questa macchina**, e deve continuare a poterlo fare. Se il rifiuto guardasse solo
  // il token e non da dove arriva la richiesta, la CLI si romperebbe — e il difetto arriverebbe
  // addosso a chi usa `cc` ogni giorno, non a un attacco.
  const dallaMacchina = await b.call('/local/sessions', {
    method: 'POST',
    body: { permissionMode: 'bypassPermissions' },
    headers: { 'x-cc-remote-token': TOKEN },
    host: `127.0.0.1:${b.port}`,
  });
  assert.equal(dallaMacchina.status, 200,
    `da questa macchina non si crea più una conversazione col bypass: ${dallaMacchina.status}`);

  // ── 3. autorizzato ──────────────────────────────────────────────────────────────────────────
  const dentro = await b.call('/local/sessions', { headers: { 'x-cc-remote-token': TOKEN } });
  assert.equal(dentro.status, 200, `con il token l'elenco risponde ${dentro.status}`);

  // ── 4. non autorizzato ──────────────────────────────────────────────────────────────────────
  const sbagliato = await b.call('/local/sessions', { headers: { 'x-cc-remote-token': 'token-sbagliato-ma-lungo-abbastanza' } });
  assert.equal(sbagliato.status, 401, 'un token sbagliato entra');

  // Un'origine di un altro sito non fa partire un'azione sulla macchina, nemmeno col token buono:
  // è la rotaia contro il browser di qualcun altro, ed è l'unica che regge se il token è nel
  // browser. (Il token non si prova a indovinare: si prova a **usare**.)
  const estraneo = await b.call('/local/projects/open', {
    method: 'POST',
    body: { path: b.root },
    headers: { 'x-cc-remote-token': TOKEN, origin: 'https://un-altro-sito.example' },
  });
  assert.equal(estraneo.status, 403, `un'origine estranea ottiene ${estraneo.status} su un'azione di macchina`);

  // ── 5. il client ChatGPT, per intero ────────────────────────────────────────────────────────
  const as = await b.call('/.well-known/oauth-authorization-server');
  assert.equal(as.status, 200, 'la scoperta non è pubblica');
  assert.equal(String(JSON.parse(as.text).issuer ?? '').replace(/\/$/, ''), BASE, 'l\'issuer non è l\'indirizzo pubblico');

  const reg = await b.call('/register', {
    method: 'POST',
    body: { client_name: 'prova-single-host', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
  });
  assert.equal(reg.status, 201, `la registrazione risponde ${reg.status}`);
  const client = JSON.parse(reg.text);
  assert.ok(client.client_id, 'la registrazione non ha dato un client_id');

  // Il consenso passa dal token della persona: senza, `/authorize` non concede niente.
  const senzaToken = await b.call(`/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}`);
  assert.notEqual(senzaToken.status, 302, '/authorize concede un codice a chi non ha il token');

  const login = await form(b, '/authorize/login', { token: TOKEN, next: '/authorize' });
  const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0];
  assert.match(cookie, /cc_remote_owner=/, 'il token della persona non apre il consenso');

  const { verifier, challenge } = pkce();
  const state = crypto.randomUUID();
  const query = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  const consenso = await b.call(`/authorize?${query}`, { headers: { cookie } });
  assert.equal(consenso.status, 200, `la pagina di consenso risponde ${consenso.status}`);
  const nonce = /name="nonce" value="([^"]+)"/.exec(consenso.text)?.[1] ?? '';
  const next = (/name="next" value="([^"]*)"/.exec(consenso.text)?.[1] ?? '').replace(/&amp;/g, '&');
  await form(b, '/authorize/consent', { nonce, next, decision: 'allow' }, { cookie });

  const rilasciato = await b.call(next, { headers: { cookie } });
  const ritorno = new URL(rilasciato.location ?? 'https://vuoto.invalid/');
  assert.equal(ritorno.origin, 'https://chatgpt.com', `il codice non torna al redirect dichiarato: ${rilasciato.location}`);
  assert.equal(ritorno.searchParams.get('state'), state, 'lo state è cambiato per strada');

  const scambio = await form(b, '/token', {
    grant_type: 'authorization_code', code: ritorno.searchParams.get('code'),
    code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT,
  });
  assert.equal(scambio.status, 200, `lo scambio del codice risponde ${scambio.status}`);
  const tokens = JSON.parse(scambio.text);
  assert.ok(tokens.access_token, 'lo scambio non ha dato un token di accesso');

  const strumenti = await b.call('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
  assert.equal(strumenti.status, 200, `MCP risponde ${strumenti.status} col token buono`);
  const nomi = (JSON.parse(strumenti.text)?.result?.tools ?? []).map((tool) => tool.name);
  assert.equal(nomi.length, 4, `MCP ha risposto con ${nomi.length} strumenti invece di quattro`);

  // E con quel token **non** si entra nella dashboard: le due superfici hanno due chiavi diverse,
  // e questo è il punto di averle tenute distinte dentro lo stesso hostname.
  const tokenMcpSullaDashboard = await b.call('/local/sessions', { headers: { 'x-cc-remote-token': tokens.access_token } });
  assert.equal(tokenMcpSullaDashboard.status, 401, 'il token OAuth di ChatGPT apre la dashboard');

  // E nell'altro verso, che è il più facile da sbagliare quando due superfici convivono sullo
  // stesso hostname: il token della persona **non** è un token OAuth, e non deve valere come tale.
  const tokenDashboardSuMcp = await b.call('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  });
  assert.equal(tokenDashboardSuMcp.status, 401, 'il token di cc-remote vale come bearer MCP');
});

test('single-host: il websocket accetta l\'host pubblico, e solo quello', async (t) => {
  const b = await startServer({ single: true, name: 'socket' });
  t.after(() => b.close());

  // Il token viaggia come **sottoprotocollo** (`bearer.<token>`), non come intestazione: è quello
  // che fa il browser della pagina, ed è quello che il server legge (`tokenFrom`). Un test che
  // usasse un'altra via proverebbe una connessione che non esiste.
  const apri = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws`, [`bearer.${TOKEN}`], {
      headers: { host: HOST, ...(origin ? { origin } : {}) },
    });
    const esito = (value) => { try { ws.terminate(); } catch { /* già chiuso */ } resolve(value); };
    ws.on('open', () => esito('aperto'));
    ws.on('error', () => esito('rifiutato'));
    setTimeout(() => esito('tempo scaduto'), 6_000);
  });

  // L'origine da cui si entra davvero. Senza questa, la pagina si aprirebbe e resterebbe muta:
  // è il difetto che `docs/PHONE.md` descrive come «sembra rotto mentre è solo zittito».
  assert.equal(await apri(BASE), 'aperto', 'il websocket rifiuta l\'origine del proprio host pubblico');
  assert.equal(await apri('https://un-altro-sito.example'), 'rifiutato', 'il websocket accetta un\'origine estranea');
  // E senza `Origin` — uno script, `rc attach` — si passa: è la regola di sempre.
  assert.equal(await apri(undefined), 'aperto', 'un client senza Origin — `rc attach`, uno script — deve poter entrare');
});

test('single-host: col consenso esplicito il pannello funziona da fuori', async (t) => {
  const b = await startServer({ single: true, admin: true, name: 'admin' });
  t.after(() => b.close());

  const conToken = await b.call('/local/admin/status', { headers: { 'x-cc-remote-token': TOKEN } });
  assert.equal(conToken.status, 200, `col consenso il pannello risponde ${conToken.status}`);

  // E le modalità si aprono **perché** c'è il consenso, non perché il lock non le copriva: la
  // stessa rotta che senza consenso risponde 404, con il consenso risponde. Se questo controllo
  // passasse anche senza il flag, il flag non starebbe facendo niente.
  const creata = await b.call('/local/sessions', { method: 'POST', body: {}, headers: { 'x-cc-remote-token': TOKEN } });
  const id = JSON.parse(creata.text).session.sessionId;
  const modi = await b.call(`/local/sessions/${id}/permissions`, {
    method: 'POST', body: { mode: 'default' }, headers: { 'x-cc-remote-token': TOKEN },
  });
  assert.equal(modi.status, 200, `col consenso la modalità dei permessi risponde ${modi.status}`);

  // Ma il consenso non è una chiave in più: senza il token resta chiuso, e con un'origine
  // estranea restano chiusi i gesti che toccano il PC.
  assert.equal((await b.call('/local/admin/status')).status, 401, 'il pannello si apre senza token');
  const estraneo = await b.call('/local/admin/restart', {
    method: 'POST', body: { confirm: 'riavvia' },
    headers: { 'x-cc-remote-token': TOKEN, origin: 'https://un-altro-sito.example' },
  });
  assert.equal(estraneo.status, 403, `un'origine estranea riavvia il server: ${estraneo.status}`);
});

test('single-host senza hostname pubblico non parte, invece di fingere', async () => {
  // La combinazione che non può funzionare si dice all'avvio. Il modo non si accenderebbe — non
  // c'è un hostname su cui accenderlo — e il server partirebbe identico a prima: chi l'ha scritto
  // crederebbe di aver acceso una cosa che non è accesa.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-single-rotto-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([chiave]) => !chiave.startsWith('CR_')));
  Object.assign(env, {
    CR_TOKEN: TOKEN, CR_PORT: '0', CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_SINGLE_HOST: '1', CR_MCP_HOST: '', CR_LOG_FILE: path.join(root, 'log.txt'),
  });
  const serve = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let uscita = '';
  serve.stdout.setEncoding('utf8').on('data', (c) => { uscita += c; });
  serve.stderr.setEncoding('utf8').on('data', (c) => { uscita += c; });
  const esito = await new Promise((resolve) => {
    serve.on('exit', (codice) => resolve(codice));
    setTimeout(() => resolve('vivo'), 15_000);
  });
  try { serve.kill(); } catch { /* già uscito */ }
  fs.rmSync(root, { recursive: true, force: true });

  assert.notEqual(esito, 'vivo', 'il server è partito con una configurazione che non può funzionare');
  assert.notEqual(esito, 0, `il server è uscito con ${esito}`);
  assert.match(uscita, /CR_MCP_HOST/, `l'errore non dice cosa manca: ${uscita.slice(0, 200)}`);
});

test('senza CR_SINGLE_HOST non cambia niente: l\'host pubblico resta la sola macchina', async (t) => {
  // Il controllo che tiene onesta la modalità nuova. Chi non l'ha chiesta deve avere esattamente
  // quello di prima: sull'hostname pubblico si parla solo di OAuth e MCP, e il sito non c'è.
  const b = await startServer({ single: false, name: 'due-superfici' });
  t.after(() => b.close());

  for (const rotta of ['/', '/app.js', '/manifest.webmanifest', '/local/sessions']) {
    const risposta = await b.call(rotta, { headers: { 'x-cc-remote-token': TOKEN } });
    assert.equal(risposta.status, 404, `${rotta} risponde ${risposta.status} sull'host pubblico senza single-host`);
  }
  assert.equal((await b.call('/mcp', { method: 'POST', body: {} })).status, 401, '/mcp deve restare raggiungibile');
  assert.equal((await b.call('/.well-known/oauth-authorization-server')).status, 200, 'la scoperta deve restare pubblica');
});

// ── i permessi delle proprie conversazioni, dal telefono ──────────────────────────────────────
// La scelta **stretta**: `CR_REMOTE_PERMISSIONS` apre il modo di una conversazione e la sua
// esposizione a ChatGPT, e nient'altro. Non è `CR_SINGLE_HOST_ADMIN`, che aprirebbe tutto il
// pannello — ripristini, impostazioni, processi — per il gusto di cambiare una modalità.

const crea = async (b) => JSON.parse((await b.call('/local/sessions', {
  method: 'POST', body: {}, headers: { 'x-cc-remote-token': TOKEN },
})).text).session.sessionId;

test('col consenso stretto: i permessi sì, il pannello no', async (t) => {
  const b = await startServer({ single: true, remote: true, name: 'remoto' });
  t.after(() => b.close());
  const id = await crea(b);
  const conToken = { 'x-cc-remote-token': TOKEN };

  // Il modo di una conversazione propria: si cambia da fuori.
  const modo = await b.call(`/local/sessions/${id}/permissions`, {
    method: 'POST', body: { mode: 'bypassPermissions' }, headers: conToken,
  });
  assert.equal(modo.status, 200, `il modo non si cambia da fuori: ${modo.status} ${modo.text.slice(0, 120)}`);

  // E l'esposizione a ChatGPT di una chat **in bypass**: il consenso rafforzato — la conferma che
  // ripete il nome — si dà da qui, che è il posto da cui il proprietario la vuole dare.
  const elenco = JSON.parse((await b.call('/local/sessions', { headers: conToken })).text).sessions;
  const nome = elenco.find((s) => s.sessionId === id).name;

  const senzaConferma = await b.call(`/local/sessions/${id}/mcp`, {
    method: 'POST', body: { allowed: true }, headers: conToken,
  });
  assert.equal(senzaConferma.status, 400, 'si espone una chat in bypass senza la conferma che ripete il nome');

  const esposta = await b.call(`/local/sessions/${id}/mcp`, {
    method: 'POST', body: { allowed: true, confirm: nome }, headers: conToken,
  });
  assert.equal(esposta.status, 200, `non si riesce a esporre: ${esposta.status} ${esposta.text.slice(0, 160)}`);
  const dopo = JSON.parse((await b.call('/local/sessions', { headers: conToken })).text).sessions
    .find((s) => s.sessionId === id);
  assert.equal(dopo.mcpReachable, true, 'la chat in bypass è esposta ma non risulta raggiungibile');
  assert.ok(dopo.mcpBypassAt, 'il consenso non porta la data: non si può far scadere quello che non è datato');

  // E il pannello **no**: il consenso stretto non è quello largo.
  const pannello = await b.call('/local/admin/status', { headers: conToken });
  assert.equal(pannello.status, 403, `col consenso stretto il pannello risponde ${pannello.status}`);

  // `auto` nemmeno: fa agire l'agente senza chiedere dentro un progetto, e non è la stessa cosa
  // di «questa conversazione salta i permessi».
  const auto = await b.call(`/local/sessions/${id}/auto`, { method: 'POST', body: { enabled: true }, headers: conToken });
  assert.equal(auto.status, 403, `l'auto-approvazione si accende da fuori: ${auto.status}`);
});

test('senza il consenso stretto: spiegazione a chi ha il token, silenzio a chi non ce l\'ha', async (t) => {
  const b = await startServer({ single: true, name: 'spento' });
  t.after(() => b.close());
  const id = await crea(b);
  const conToken = { 'x-cc-remote-token': TOKEN };

  // Chi ha il token è il proprietario: merita di sapere **perché**, e come accenderlo — invece di
  // un «non trovato» che lo manda a cercare un guasto che non c'è.
  const spiegato = await b.call(`/local/sessions/${id}/permissions`, {
    method: 'POST', body: { mode: 'default' }, headers: conToken,
  });
  assert.equal(spiegato.status, 403, `risponde ${spiegato.status} invece di spiegare`);
  assert.match(spiegato.text, /CR_REMOTE_PERMISSIONS/, `la spiegazione non dice come accenderlo: ${spiegato.text.slice(0, 160)}`);

  // Chi non ha il token riceve la stessa risposta di un percorso che non esiste: dire «vietato»
  // sarebbe dire che lì c'è qualcosa.
  const anonimo = await b.call(`/local/sessions/${id}/permissions`, { method: 'POST', body: { mode: 'default' } });
  assert.equal(anonimo.status, 404, `a un estraneo si risponde ${anonimo.status}`);
  assert.doesNotMatch(anonimo.text, /CR_REMOTE_PERMISSIONS|CR_SINGLE_HOST_ADMIN/, 'la risposta a un estraneo nomina le variabili da accendere');
  // E di una rotta che non esiste riceve **lo stesso codice**: fra «c'è ma non puoi» e «non c'è»
  // un estraneo non deve poter distinguere. Il corpo non si confronta — quello di una rotta
  // inesistente è la pagina HTML di Express, e confrontare mele con arance non proverebbe niente:
  // quello che conta è che dalla risposta non si ricavi che lì dentro c'è qualcosa.
  const inesistente = await b.call('/local/percorso-che-non-esiste', { method: 'POST' });
  assert.equal(inesistente.status, anonimo.status, `rotta inesistente ${inesistente.status}, rotta bloccata ${anonimo.status}`);
  assert.doesNotMatch(anonimo.text, /permission|sessions\//i, `la risposta a un estraneo nomina la rotta: ${anonimo.text.slice(0, 120)}`);
});

test('le intestazioni di Cloudflare non autorizzano niente', async (t) => {
  // Un'intestazione la scrive chi la manda. Il tunnel parla con `127.0.0.1`, ma su quella porta
  // ci si arriva anche da qui, e dalla tailnet: chi passa di lì può inventarsi un utente
  // autenticato. Quello che autorizza è il token di cc-remote, e nient'altro.
  const b = await startServer({ single: true, name: 'intestazioni' });
  t.after(() => b.close());
  const id = await crea(b);

  const finte = {
    'cf-access-authenticated-user-email': 'owner@example.com',
    'cf-access-jwt-assertion': 'finta.ma.con.la.forma.giusta',
    'cf-connecting-ip': '203.0.113.7',
    'x-forwarded-for': '203.0.113.7',
    'x-forwarded-proto': 'https',
  };
  const tentata = await b.call(`/local/sessions/${id}/permissions`, { method: 'POST', body: { mode: 'default' }, headers: finte });
  assert.equal(tentata.status, 404, `con le sole intestazioni di Cloudflare si ottiene ${tentata.status}`);
  const pannello = await b.call('/local/admin/status', { headers: finte });
  assert.equal(pannello.status, 404, `le intestazioni aprono il pannello: ${pannello.status}`);
  const dati = await b.call('/local/sessions', { headers: finte });
  assert.equal(dati.status, 401, `le intestazioni danno i dati: ${dati.status}`);
});

test('un permesso da fuori passa per la rotaia dell\'origine', async (t) => {
  const b = await startServer({ single: true, remote: true, name: 'origine' });
  t.after(() => b.close());
  const id = await crea(b);
  const estranea = await b.call(`/local/sessions/${id}/permissions`, {
    method: 'POST', body: { mode: 'default' },
    headers: { 'x-cc-remote-token': TOKEN, origin: 'https://un-altro-sito.example' },
  });
  assert.equal(estranea.status, 403, `un'origine estranea cambia un permesso: ${estranea.status}`);
  // E l'origine dichiarata passa: è la dashboard, dal telefono.
  const sua = await b.call(`/local/sessions/${id}/permissions`, {
    method: 'POST', body: { mode: 'default' },
    headers: { 'x-cc-remote-token': TOKEN, origin: BASE },
  });
  assert.equal(sua.status, 200, `l'origine della dashboard viene rifiutata: ${sua.status}`);
});

// ── le difese che una revisione di sicurezza ha trovato bucabili ──────────────────────────────
// Tre modi di scrivere la stessa cosa, e il lock ne riconosceva uno solo.

test('il percorso non si aggira scrivendolo in percentuale', async (t) => {
  // Express decodifica i `:param` **prima** di eseguire la rotta: `/local/sessions/x/%61uto` arriva
  // al gestore con `action = 'auto'`, cioè esegue l'azione vera. Il lock confrontava il percorso
  // grezzo con la parola scritta per esteso, quindi su `%61uto` non riconosceva niente e lasciava
  // passare — e con la stessa mossa si arrivava a `%6dcp`, che espone a ChatGPT una chat che salta
  // i permessi. Trovato da una revisione di sicurezza, provato: rispondeva **200**.
  const b = await startServer({ single: true, name: 'percentuale' });
  t.after(() => b.close());
  const id = await crea(b);
  const conToken = { 'x-cc-remote-token': TOKEN };

  const varianti = ['perm%%6f', '%%70ermissions', 'm%63p', 'au%74o', '%61uto', '%61%75%74%6f'];
  for (const azione of varianti) {
    const risposta = await b.call(`/local/sessions/${id}/${azione}`, {
      method: 'POST', body: { mode: 'bypassPermissions', enabled: true, allowed: true, confirm: 'x' },
      headers: conToken,
    });
    assert.notEqual(risposta.status, 200,
      `/${azione} è passato (${risposta.status}): il lock non decodifica il percorso`);
  }

  // E il verso giusto resta aperto: l'azione scritta bene, senza consenso, si rifiuta spiegando.
  const dritta = await b.call(`/local/sessions/${id}/permissions`, { method: 'POST', body: { mode: 'default' }, headers: conToken });
  assert.equal(dritta.status, 403, `la rotta scritta bene risponde ${dritta.status}`);
});

test('sull\'host pubblico non basta scrivere un Origin di loopback', async (t) => {
  // L'`Origin` lo scrive il client, e il socket è `127.0.0.1` comunque perché davanti c'è il
  // tunnel: su quell'hostname non c'è niente che distingua il tuo browser da quello di un altro.
  // Quindi lì l'esposizione di una chat in bypass la autorizza solo il consenso esplicito.
  const b = await startServer({ single: true, name: 'origin-finto' });
  t.after(() => b.close());
  const id = await crea(b);
  const conToken = { 'x-cc-remote-token': TOKEN };

  await b.call(`/local/sessions/${id}/permissions`, { method: 'POST', body: { mode: 'bypassPermissions' }, headers: { ...conToken, origin: BASE } });
  const elenco = JSON.parse((await b.call('/local/sessions', { headers: conToken })).text).sessions;
  const nome = elenco.find((s) => s.sessionId === id).name;

  for (const origin of [undefined, 'http://127.0.0.1:4310', 'http://localhost:4310']) {
    const risposta = await b.call(`/local/sessions/${id}/mcp`, {
      method: 'POST', body: { allowed: true, confirm: nome },
      headers: { ...conToken, ...(origin ? { origin } : {}) },
    });
    assert.equal(risposta.status, 403,
      `esporre una chat in bypass con Origin «${origin ?? '(nessuno)'}» risponde ${risposta.status}`);
  }
});

test('spegnere il server non si fa da fuori', async (t) => {
  // `/local/shutdown` chiude tutti i PTY: è un'operazione sulla macchina, e il lock la copre.
  // (Se non la coprisse, questo controllo non fallirebbe: il server di prova morirebbe, e la
  // prova dopo non troverebbe nessuno con cui parlare.)
  const b = await startServer({ single: true, name: 'shutdown' });
  t.after(() => b.close());
  const conToken = { 'x-cc-remote-token': TOKEN };
  const spento = await b.call('/local/shutdown', { method: 'POST', headers: conToken });
  assert.equal(spento.status, 403, `lo spegnimento risponde ${spento.status} dall'host pubblico`);
  // Il controllo di vita: se il lock non avesse coperto lo spegnimento, il server di prova non
  // ci sarebbe più e questa riga fallirebbe per il motivo giusto.
  assert.equal((await b.call('/healthz', { headers: conToken })).status, 200, 'il server è stato spento da fuori');
});
