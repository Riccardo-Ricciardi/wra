// Il pannello amministrativo, su un server vero. Qui si prova la parte che conta: che le quattro
// regole delle rotte `/local/admin/*` tengano **attraverso la rete** — token, origine, conferma
// esplicita, e nessun comando che arrivi dal browser — e che un ripristino, fatto dalla stessa
// pagina che lo ha chiesto, ricarichi il registro invece di lasciare in memoria quello di prima.
//
// Quello che **non** si prova qui, di proposito: eseguire `tailscale serve`. Girerebbe sulla
// macchina di chi lancia le prove, cambiando la configurazione vera. Si provano i due guardiani
// che stanno davanti (conferma e origine), che è la parte che deve essere cieca.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serverEnv } from '../tools/server-env.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'token-amministrativo-di-prova';
const FAKE = path.join(repo, 'tools', 'fake-claude.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-admin-'));
const project = path.join(root, 'progetto');
const fuori = path.join(root, 'fuori');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(fuori, { recursive: true });

let server;
let port;

test.before(async () => {
  const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
    env: {
      ...serverEnv(),
      CR_TOKEN: TOKEN,
      CR_PORT: '0',
      CR_CLAUDE_CMD: process.execPath,
      CR_CLAUDE_ARGS: JSON.stringify([FAKE]),
      CR_DEFAULT_PROJECT: project,
      CR_ALLOWED_ROOTS: root,
      CR_STATE_FILE: path.join(root, 'sessions.json'),
      CR_PROJECTS_FILE: path.join(root, 'projects.json'),
      CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
      CR_ACCESS_FILE: path.join(root, 'access.json'),
      CR_SETTINGS_FILE: path.join(root, 'settings.json'),
      CR_PROJECTS_ROOT: path.join(root, 'projects'),
      CR_LOG_FILE: path.join(root, 'test.log'),
      // Niente bridge MCP (questo file prova le rotte della persona), ma l'hostname della
      // macchina **dichiarato**: è quello che accende il lock fra le due superfici, e va provato
      // anche per le rotte nuove — sono quelle che cambiano qualcosa sulla macchina.
      CR_ISSUER_URL: '',
      CR_RESOURCE_URL: '',
      CR_MCP_HOST: 'mcp.esempio.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = out.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      port = Number(match[1]);
      return;
    }
    if (child.exitCode !== null) throw new Error(`il server è uscito: ${out}`);
    await sleep(100);
  }
  throw new Error(`il server non si è annunciato: ${out}`);
});

test.after(async () => {
  const closed = new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    server.on('close', resolve);
    setTimeout(resolve, 5_000).unref();
  });
  server?.kill();
  await closed;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const call = async (route, { method = 'GET', body = null, headers = {}, token = TOKEN } = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      ...(token ? { 'x-cc-remote-token': token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, json, text };
};

test('lo stato del pannello si legge, e non contiene il token', async () => {
  const response = await call('/local/admin/status');
  assert.equal(response.status, 200);
  for (const key of ['version', 'status', 'checks', 'paths', 'backups', 'settings', 'effective', 'setup']) {
    assert.ok(key in response.json, `manca «${key}» nella risposta`);
  }
  assert.equal(response.json.status.sessions.total, 0);
  assert.ok(response.json.checks.find((check) => check.name === 'registry'));
  assert.ok(response.json.paths.stateFile.endsWith('sessions.json'));
  assert.ok(response.json.setup.steps.length >= 5, 'il primo avvio ha i suoi passi');
  // Il token non esce da qui: né in chiaro, né dentro un dettaglio.
  assert.doesNotMatch(response.text, new RegExp(TOKEN));
});

test('senza token non si passa da nessuna rotta amministrativa', async () => {
  for (const [route, options] of [
    ['/local/admin/status', {}],
    ['/local/admin/processes', {}],
    ['/local/admin/backups', {}],
    ['/local/admin/settings', {}],
    ['/local/admin/export', {}],
    ['/local/admin/access', {}],
    ['/local/admin/backups', { method: 'POST' }],
    ['/local/admin/settings', { method: 'POST', body: {} }],
    ['/local/admin/conversations/plan', { method: 'POST', body: {} }],
    ['/local/admin/conversations/import', { method: 'POST', body: { ids: ['x'], confirm: 'importa' } }],
  ]) {
    const response = await call(route, { ...options, token: '' });
    assert.equal(response.status, 401, `${options.method ?? 'GET'} ${route} doveva chiedere il token`);
  }
});

test('un\'azione che cambia la configurazione richiede la conferma, e la conferma la controlla il server', async () => {
  const senza = await call('/local/admin/settings', { method: 'POST', body: { defaultProject: fuori } });
  assert.equal(senza.status, 400);
  assert.match(senza.json.error, /confirmation/);

  const sbagliata = await call('/local/admin/settings', { method: 'POST', body: { confirm: 'sì', defaultProject: fuori } });
  assert.equal(sbagliata.status, 400);

  const giusta = await call('/local/admin/settings', { method: 'POST', body: { confirm: 'impostazioni', defaultProject: fuori } });
  assert.equal(giusta.status, 200);
  assert.equal(giusta.json.restartNeeded, true, 'si applicano al prossimo avvio, e lo dice');
  assert.equal(giusta.json.saved.defaultProject, fuori);
  const scritto = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  assert.equal(scritto.defaultProject, fuori);
});

test('le azioni di sistema non si accettano dal browser di un altro sito', async () => {
  const estraneo = { origin: 'https://un-altro-sito.example' };
  const settings = await call('/local/admin/settings', { method: 'POST', body: { confirm: 'impostazioni' }, headers: estraneo });
  assert.equal(settings.status, 403);
  assert.match(settings.json.error, /this machine/);

  const riavvio = await call('/local/admin/restart', { method: 'POST', body: { confirm: 'riavvia' }, headers: estraneo });
  assert.equal(riavvio.status, 403);

  // E dal browser di questa macchina il riavvio, senza la conferma giusta, non parte comunque.
  const senzaConferma = await call('/local/admin/restart', { method: 'POST', body: {}, headers: { origin: 'http://127.0.0.1' } });
  assert.equal(senzaConferma.status, 400);
});

test('una cartella che non esiste o è un collegamento non diventa una radice consentita', async (t) => {
  const inventata = await call('/local/admin/settings', {
    method: 'POST', body: { confirm: 'impostazioni', allowedRoots: [path.join(root, 'inventata')] },
  });
  assert.equal(inventata.status, 400);
  assert.match(inventata.json.error, /does not exist/);

  if (process.platform !== 'win32') {
    t.diagnostic('il collegamento come radice si prova su Windows (junction)');
    return;
  }
  const link = path.join(root, 'scorciatoia');
  fs.symlinkSync(fuori, link, 'junction');
  const collegamento = await call('/local/admin/settings', {
    method: 'POST', body: { confirm: 'impostazioni', allowedRoots: [link] },
  });
  assert.equal(collegamento.status, 400);
  assert.match(collegamento.json.error, /is a link/);
});

test('le copie si creano, si verificano, si pianificano — e il ripristino ricarica il registro', async () => {
  const creata = await call('/local/admin/backups', { method: 'POST' });
  assert.equal(creata.status, 200);
  const nome = path.basename(creata.json.folder);
  // Senza registro non c'è un numero di conversazioni da dichiarare: `null`, non uno zero
  // inventato. E la copia si fa lo stesso — è il caso per cui si ripristina.
  assert.equal(creata.json.manifest.chats, null);
  assert.match(creata.json.manifest.note, /transcript/);

  const elenco = await call('/local/admin/backups');
  assert.ok(elenco.json.backups.some((row) => row.name === nome));

  const verifica = await call('/local/admin/backups/verify', { method: 'POST', body: { name: nome } });
  assert.equal(verifica.json.ok, true);

  // Una conversazione in più, poi il ripristino: quella in più deve uscire dal registro **in
  // memoria**, non solo dal file — altrimenti la pagina continuerebbe a mostrarla.
  const primaCopia = await call('/local/sessions', { method: 'POST', body: { projectPath: project, name: 'prima' } });
  assert.equal(primaCopia.status, 200);
  const dopoTutto = await call('/local/admin/backups', { method: 'POST' });
  const dopo = path.basename(dopoTutto.json.folder);
  await call('/local/sessions', { method: 'POST', body: { projectPath: project, name: 'dopo' } });
  assert.equal((await call('/local/sessions')).json.sessions.length, 2);

  const piano = await call('/local/admin/backups/plan', { method: 'POST', body: { name: dopo } });
  assert.equal(piano.json.ok, true);
  assert.deepEqual(piano.json.removed, ['dopo']);
  assert.ok(piano.json.safety, 'e dice dove metterà da parte lo stato attuale');

  const senzaConferma = await call('/local/admin/backups/restore', { method: 'POST', body: { name: dopo } });
  assert.equal(senzaConferma.status, 400);
  const nomeSbagliato = await call('/local/admin/backups/restore', { method: 'POST', body: { name: dopo, confirm: '../altro' } });
  assert.equal(nomeSbagliato.status, 400, 'la conferma deve ripetere **quel** nome');

  const ripristino = await call('/local/admin/backups/restore', {
    method: 'POST', body: { name: dopo, confirm: dopo }, headers: { origin: 'http://127.0.0.1' },
  });
  assert.equal(ripristino.status, 200);
  assert.equal(ripristino.json.sessions, 1, 'il registro in memoria è stato riletto');
  assert.equal(ripristino.json.reloadError, null);
  const adesso = (await call('/local/sessions')).json.sessions.map((session) => session.name);
  assert.deepEqual(adesso, ['prima'], 'la conversazione aggiunta dopo la copia non c\'è più');
  assert.ok(fs.existsSync(path.join(ripristino.json.safety, 'MANIFEST.json')), 'e lo stato di prima è al sicuro, verificabile');
});

test('una copia si scarica, e solo i file che sono dentro il suo manifesto', async () => {
  const elenco = await call('/local/admin/backups');
  const nome = elenco.json.backups[0].name;
  const uno = await call(`/local/admin/backups/download?name=${encodeURIComponent(nome)}&file=sessions.json`);
  assert.equal(uno.status, 200);
  assert.match(uno.text, /"sessions"/);

  const fuoriManifesto = await call(`/local/admin/backups/download?name=${encodeURIComponent(nome)}&file=..%2F..%2Fsecret`);
  assert.equal(fuoriManifesto.status, 404);
  const fuoriCartella = await call('/local/admin/backups/download?name=..%2F..%2Fsessions.json');
  assert.equal(fuoriCartella.status, 404);

  // Un manifesto lo può scrivere chiunque abbia accesso a quella cartella: un nome con un percorso
  // dentro non deve trasformare lo scaricamento in un lettore di file altrui. La lista chiusa
  // (i file che conosciamo) è il confine, e vale sia per il file singolo sia per il pacchetto.
  const cartella = path.join(root, 'backups', nome);
  const manifesto = JSON.parse(fs.readFileSync(path.join(cartella, 'MANIFEST.json'), 'utf8'));
  manifesto.files.push({ name: '../../token', bytes: 1, sha256: 'x' });
  fs.writeFileSync(path.join(cartella, 'MANIFEST.json'), JSON.stringify(manifesto));
  const piantato = await call(`/local/admin/backups/download?name=${encodeURIComponent(nome)}&file=..%2F..%2Ftoken`);
  assert.equal(piantato.status, 404, 'un nome nel manifesto non è un permesso');
  const pacchetto = await call(`/local/admin/backups/download?name=${encodeURIComponent(nome)}`);
  assert.equal(pacchetto.status, 200);
  assert.ok(!Object.hasOwn(pacchetto.json.files, '../../token'), 'il pacchetto non deve contenere un file fuori dalla lista');

  const tutto = await call(`/local/admin/backups/download?name=${encodeURIComponent(nome)}`);
  assert.equal(tutto.status, 200);
  assert.ok(tutto.json.manifest && tutto.json.files);
  assert.ok(Object.hasOwn(tutto.json.files, 'sessions.json'), 'e i file veri ci sono');
});

test('i processi si guardano, ma il pid di un altro non si tocca', async () => {
  const vista = await call('/local/admin/processes');
  assert.equal(vista.status, 200);
  for (const key of ['managed', 'orphans', 'windows', 'gone', 'foreign']) assert.ok(Array.isArray(vista.json[key]), `manca «${key}»`);

  // Il processo che sta lanciando questa prova è vivo, ma non è una `claude` di una nostra
  // conversazione: la chiusura deve rifiutarsi. (Se questa asserzione fallisse, la prova stessa
  // verrebbe uccisa — che è il modo più diretto di accorgersi che la verifica non c'è.)
  const rifiuto = await call('/local/admin/processes/kill', {
    method: 'POST', body: { pid: process.pid, confirm: String(process.pid) }, headers: { origin: 'http://127.0.0.1' },
  });
  assert.equal(rifiuto.status, 400);
  assert.match(rifiuto.json.error, /the id of a conversation/);

  // E l'id deve essere **di questo registro**: senza, una richiesta con `sessionId: ''`
  // scavalcherebbe il confronto e chiuderebbe un `claude` qualsiasi che porta un id — cioè anche
  // la conversazione aperta in un'altra finestra, che il pannello chiama «lavoro in corso».
  const inventato = await call('/local/admin/processes/kill', {
    method: 'POST', headers: { origin: 'http://127.0.0.1' },
    body: { pid: process.pid, sessionId: 'non-esiste-questa-conversazione', confirm: String(process.pid) },
  });
  assert.equal(inventato.status, 400);
  assert.match(inventato.json.error, /in this registry/);

  const senzaConferma = await call('/local/admin/processes/kill', { method: 'POST', body: { pid: 1 }, headers: { origin: 'http://127.0.0.1' } });
  assert.equal(senzaConferma.status, 400);
  const daFuori = await call('/local/admin/processes/kill', {
    method: 'POST', body: { pid: 1, confirm: '1' }, headers: { origin: 'https://altrove.example' },
  });
  assert.equal(daFuori.status, 403);
});

test('la diagnosi profonda e l\'esportazione non portano segreti', async () => {
  const check = await call('/local/admin/check', { method: 'POST', body: { lines: 5 } });
  assert.equal(check.status, 200);
  assert.ok(check.json.deep.some((row) => row.name === 'claude'), 'la versione di claude è fra i controlli');
  assert.ok(check.json.log.lines.length <= 5);

  const exportFile = await call('/local/admin/export');
  assert.equal(exportFile.status, 200);
  assert.doesNotMatch(exportFile.text, new RegExp(TOKEN));
  assert.match(exportFile.json.note, /contains no tokens/);
});

test('la scelta dell\'accesso si scrive e si toglie, e non tocca nient\'altro', async () => {
  const stato = await call('/local/admin/access');
  assert.equal(stato.status, 200);
  assert.ok(Array.isArray(stato.json.review));
  assert.equal(stato.json.saved.tailscale, null);
  const prima = (await call('/local/sessions')).json.sessions;

  const piano = await call('/local/admin/access/plan', { method: 'POST', body: { mode: 'tailscale', tailscaleHost: 'pc-di-prova.tail1234.ts.net' } });
  assert.equal(piano.json.ok, true);
  assert.equal(piano.json.env.CR_PUBLIC_ORIGIN, 'https://pc-di-prova.tail1234.ts.net');
  assert.ok(piano.json.needs.length >= 2, 'e dice cosa va fatto a mano');

  const hostSbagliato = await call('/local/admin/access/apply', {
    method: 'POST', body: { mode: 'tailscale', tailscaleHost: 'https://pc.tail1234.ts.net/', confirm: 'applica tailscale' },
  });
  assert.equal(hostSbagliato.status, 400);
  assert.match(hostSbagliato.json.error, /hostname/);

  const senzaConferma = await call('/local/admin/access/apply', { method: 'POST', body: { mode: 'tailscale', tailscaleHost: 'pc.tail1234.ts.net' } });
  assert.equal(senzaConferma.status, 400);

  const applicata = await call('/local/admin/access/apply', {
    method: 'POST', headers: { origin: 'http://127.0.0.1' },
    body: { mode: 'tailscale', tailscaleHost: 'pc.tail1234.ts.net', confirm: 'applica tailscale' },
  });
  assert.equal(applicata.status, 200);
  assert.equal(applicata.json.restartNeeded, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'access.json'), 'utf8')).tailscale.host, 'pc.tail1234.ts.net');
  // Il registro **non** è stato toccato: la scelta dell'accesso riguarda solo il file suo.
  assert.equal((await call('/local/sessions')).json.sessions.length, prima.length);

  const rimossa = await call('/local/admin/access/remove', {
    method: 'POST', headers: { origin: 'http://127.0.0.1' }, body: { mode: 'tailscale', confirm: 'rimuovi tailscale' },
  });
  assert.equal(rimossa.status, 200);
  assert.equal(rimossa.json.saved.tailscale, null);
  assert.match(rimossa.json.note, /conversations/);
});

/** Con `fetch` non si può scrivere l'intestazione `Host`: serve `http.request` in persona. */
const withHost = (host, route, { method = 'GET', body = null } = {}) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : null;
  const request = http.request({
    host: '127.0.0.1',
    port,
    path: route,
    method,
    headers: {
      host, 'x-cc-remote-token': TOKEN,
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
    },
  }, (response) => {
    response.resume();
    response.on('end', () => resolve({ status: response.statusCode }));
  });
  request.on('error', reject);
  if (payload) request.write(payload);
  request.end();
});

test('le due superfici restano separate: sull\'host MCP il pannello non esiste', async () => {
  // Il lock di superficie si monta sempre, anche col bridge spento: qui si prova che valga anche
  // per le rotte nuove, che sono quelle che cambiano qualcosa sulla macchina.
  assert.equal((await call('/local/admin/status')).status, 200, 'dall\'indirizzo di casa il pannello risponde');

  for (const [route, options] of [
    ['/local/admin/status', {}],
    ['/local/admin/settings', { method: 'POST', body: { confirm: 'impostazioni' } }],
    ['/local/admin/restart', { method: 'POST', body: { confirm: 'riavvia' } }],
    ['/local/admin/backups', { method: 'POST' }],
  ]) {
    const risposta = await withHost('mcp.esempio.com', route, options);
    assert.equal(risposta.status, 404, `sull'hostname della macchina ${route} non deve rispondere`);
  }
  // E il lock va nelle due direzioni: sull'hostname della macchina non risponde nemmeno il resto
  // della persona — il registro, l'elenco, il websocket.
  for (const route of ['/local/sessions', '/healthz', '/']) {
    assert.equal((await withHost('mcp.esempio.com', route)).status, 404, `${route} non deve rispondere lì`);
  }
  assert.equal((await call('/local/sessions')).status, 200, 'e dall\'indirizzo di casa sì');
});

// ── La riconciliazione: importare un transcript che il registro non conosce ────────────────────
// Il caso dell'audit, in piccolo: un transcript autentico su disco che cc-remote non ha mai visto.
const ID_ORFANO = '11111111-2222-4333-8444-555555555555';

test('la riconciliazione trova un transcript che il registro non conosce, e non scrive niente', async () => {
  const cartella = path.join(root, 'projects', 'slug-di-prova');
  fs.mkdirSync(cartella, { recursive: true });
  const righe = [
    { type: 'user', sessionId: ID_ORFANO, cwd: project, version: '2.0.0', message: { content: 'una conversazione che cc-remote non ha mai visto' } },
    ...Array.from({ length: 8 }, (_unused, index) => ({ type: 'assistant', sessionId: ID_ORFANO, message: { content: [{ type: 'text', text: `risposta numero ${index}, abbastanza lunga da superare il limite di duecento byte del seme`.repeat(2) }] } })),
    { type: 'ai-title', sessionId: ID_ORFANO, aiTitle: 'la conversazione orfana' },
  ];
  const file = path.join(cartella, `${ID_ORFANO}.jsonl`);
  fs.writeFileSync(file, `${righe.map((riga) => JSON.stringify(riga)).join('\n')}\n`);
  const prima = fs.readFileSync(file, 'utf8');

  const primaDelRegistro = (await call('/local/sessions')).json.sessions.length;
  const piano = await call('/local/admin/conversations/plan', { method: 'POST', body: {} });
  assert.equal(piano.status, 200);
  const voce = piano.json.importabili.find((entry) => entry.sessionId === ID_ORFANO);
  assert.ok(voce, `il transcript orfano non è stato trovato: ${JSON.stringify(piano.json.counts)}`);
  assert.equal(voce.name, 'la conversazione orfana', 'il nome viene dal transcript, non inventato');
  assert.equal(voce.projectPath, project);
  // L'anteprima non ha scritto niente.
  assert.equal((await call('/local/sessions')).json.sessions.length, primaDelRegistro, 'l\'anteprima ha cambiato il registro');
  assert.equal(fs.readFileSync(file, 'utf8'), prima, 'l\'anteprima ha toccato il transcript');
});

test('importare richiede la conferma, e importa solo quello che il server ha trovato', async () => {
  // Quante ce ne sono **prima**: l'orfana non è ancora nel registro, quindi questo è il numero su
  // cui misurare la crescita.
  const primaDelRegistro = (await call('/local/sessions')).json.sessions.length;
  const senza = await call('/local/admin/conversations/import', { method: 'POST', body: { ids: [ID_ORFANO] } });
  assert.equal(senza.status, 400);
  assert.match(senza.json.error, /confirmation/);

  // Un id che il piano non conosce non entra, nemmeno con la conferma giusta.
  const inventato = await call('/local/admin/conversations/import', {
    method: 'POST',
    body: { ids: ['99999999-9999-4999-8999-999999999999'], confirm: 'importa' },
  });
  assert.equal(inventato.status, 400);
  assert.deepEqual(inventato.json.rifiutati, ['99999999-9999-4999-8999-999999999999']);

  const esito = await call('/local/admin/conversations/import', { method: 'POST', body: { ids: [ID_ORFANO], confirm: 'importa' } });
  assert.equal(esito.status, 200);
  assert.deepEqual(esito.json.imported.map((row) => row.sessionId), [ID_ORFANO]);
  // Prima di scrivere, una copia: il nome resta nell'elenco delle copie.
  assert.ok(esito.json.backup, 'nessuna copia di sicurezza prima di importare');
  assert.ok(fs.existsSync(path.join(esito.json.backup.startsWith(root) ? esito.json.backup : path.join(root, 'backups', esito.json.backup), 'MANIFEST.json')), 'la copia non è verificabile');

  const dopo = (await call('/local/sessions')).json.sessions;
  const importata = dopo.find((session) => session.sessionId === ID_ORFANO);
  assert.ok(importata, 'la conversazione non è nel registro');
  assert.equal(importata.imported, true, 'dev\'essere importata: si riprende con `--resume`, non si riparte da zero');
  assert.notEqual(importata.state, 'busy', 'importare non deve avviare nessun processo');

  // E la seconda volta non c'è più niente da importare: è nel registro.
  const ancora = await call('/local/admin/conversations/plan', { method: 'POST', body: {} });
  assert.ok(
    !ancora.json.importabili.some((entry) => entry.sessionId === ID_ORFANO),
    'la stessa conversazione si può importare due volte',
  );

  // «Senza duplicati» non è la stessa cosa di «il piano non la ripropone»: si guarda il registro.
  // Una voce per id, e il registro è cresciuto di **una**.
  assert.equal(dopo.filter((session) => session.sessionId === ID_ORFANO).length, 1, 'la stessa conversazione è nel registro due volte');
  const ids = dopo.map((session) => session.sessionId);
  assert.equal(new Set(ids).size, ids.length, `il registro ha id ripetuti: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
  assert.equal(ids.length, primaDelRegistro + 1, `il registro è cresciuto di ${ids.length - primaDelRegistro} voci invece di una`);

  // E importarla di nuovo non aggiunge niente: `create` con lo stesso id restituisce quella che
  // c'è. È la garanzia che rende innocuo premere «importa» due volte.
  const bis = await call('/local/admin/conversations/import', { method: 'POST', body: { ids: [ID_ORFANO], confirm: 'importa' } });
  assert.equal(bis.status, 400, 'non è più importabile: il server non deve riaccettarla');
  const terzo = (await call('/local/sessions')).json.sessions;
  assert.equal(terzo.length, ids.length, 'la seconda importazione ha cambiato il registro');

  // Il conto dei posti viaggia con l'anteprima: è quello che permette di dirlo **prima** di
  // scrivere, invece di riempire il registro fino al tetto e fermarsi a metà.
  const spazio = ancora.json.capienza;
  assert.ok(spazio, 'l\'anteprima non dice quanti posti restano');
  assert.equal(spazio.posti, spazio.max - ancora.json.counts.registro, 'i posti non sono il tetto meno quello che c\'è');
  assert.equal(spazio.posti, spazio.max - terzo.length, 'i posti non corrispondono al registro vero');
  assert.equal(spazio.mancano, Math.max(0, ancora.json.counts.importabili - spazio.posti), 'i mancanti non tornano');
  assert.equal(spazio.ok, spazio.mancano === 0, '«ci sta» e «non manca niente» devono dire la stessa cosa');
});
