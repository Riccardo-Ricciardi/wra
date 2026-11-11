// Prova dal vivo (manuale) del giro *da fuori*: lo stesso percorso che fa il telefono, cioè
// HTTPS + websocket + approvazione di un permesso attraverso il proxy. Serve a rispondere a
// «l'indirizzo pubblico funziona davvero?» senza dover prendere in mano il telefono ogni volta.
//
//   node tools/smoke-remote.mjs https://<il-tuo-indirizzo-https>
//
// Il token lo prende da CR_TOKEN o da ~/.cc-remote/token. La cartella di lavoro è la home.
// Controlla anche le due cose che devono restare chiuse: senza token si entra? e un'origine
// estranea viene rifiutata? (se una delle due passa, la prova fallisce).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const base = (process.argv[2] ?? process.env.CR_SMOKE_BASE ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('uso: node tools/smoke-remote.mjs https://il-tuo-indirizzo');
  process.exit(1);
}

const token = process.env.CR_TOKEN
  || (() => {
    try {
      return fs.readFileSync(path.join(os.homedir(), '.cc-remote', 'token'), 'utf8').trim();
    } catch {
      return '';
    }
  })();
if (!token) {
  console.error('nessun token: avvia il server con `rc start`');
  process.exit(1);
}

const home = os.homedir();
const COMMAND = 'curl -sS https://example.com';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? ' ok ' : 'NO  '} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const api = async (route, { method = 'GET', body = null, withToken = true } = {}) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(withToken ? { 'x-cc-remote-token': token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};

function connect(origin) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, [`bearer.${token}`], origin ? { origin } : {});
  const seen = [];
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  // Un rifiuto (403) è un esito che qui si *aspetta*: senza questo, `ws` lo tratta come errore
  // non gestito e porta giù lo script invece di far fallire un controllo.
  const opened = new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
  });
  ws.on('error', () => {});
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  return {
    ws,
    seen,
    closed,
    opened,
    until: async (predicate, { timeoutMs = 240_000, what = 'condizione' } = {}) => {
      const stop = Date.now() + timeoutMs;
      while (Date.now() < stop) {
        const found = seen.find(predicate);
        if (found) return found;
        await sleep(250);
      }
      throw new Error(`tempo scaduto aspettando ${what}`);
    },
  };
}

let session = null;
try {
  console.log(`indirizzo: ${base}\n`);

  // 1. quello che deve restare chiuso
  const noToken = await api('/local/sessions', { withToken: false });
  check('senza token non si vede niente', noToken.status === 401, `http ${noToken.status}`);

  const foreign = connect('https://evil.example');
  const foreignCode = await Promise.race([foreign.closed, sleep(8_000).then(() => 'aperto')]);
  check("un'origine estranea viene rifiutata (DNS rebinding)", foreignCode !== 'aperto', `esito: ${foreignCode}`);
  foreign.ws.terminate();

  // 2. il giro vero, come dal telefono
  session = (await api('/local/sessions', { method: 'POST', body: { projectPath: home, name: 'prova-da-fuori' } })).json?.session;
  check('si apre una chat da fuori', Boolean(session?.sessionId), session?.sessionId?.slice(0, 8));

  const phone = connect(base);
  await phone.opened;
  phone.ws.send(JSON.stringify({ t: 'hello', proto: 2, role: 'chat', sessionId: session.sessionId, cols: 120, rows: 40 }));
  await phone.until((m) => m.t === 'opened', { timeoutMs: 20_000, what: 'la chat aperta' });
  check('il websocket si apre da quell origine e la chat si aggancia', true);

  console.log(`\n⏳ l'agente sta partendo; poi chiederà il permesso per: ${COMMAND}\n`);
  // Con una `requestId` e un giro di attesa: un turno che passa da un'approvazione dura più di
  // una chiamata sola, e la prima versione di questa prova lo dava per fallito mentre stava
  // ancora lavorando (era il difetto della prova, non del sistema).
  const REQUEST_ID = `smoke-remote-${Date.now()}`;
  const ask = () => api('/local/talk', {
    method: 'POST',
    body: { sessionId: session.sessionId, requestId: REQUEST_ID, message: `Esegui esattamente questo comando shell, senza alternative: ${COMMAND}` },
  });
  let turn = ask();

  // Se la richiesta non arriva, la prova deve dire *perché* invece di scadere e basta: senza
  // questa riga un fallimento intermittente resta un mistero, ed è quello che è successo.
  const asked = await phone.until((m) => m.t === 'approval', { what: 'la richiesta di permesso' }).catch(async (error) => {
    const turnNow = (await api(`/local/sessions/${session.sessionId}/chat`).catch(() => null));
    const state = (await api('/local/sessions').catch(() => null))?.sessions?.find((s) => s.sessionId === session.sessionId);
    console.error('\n— la richiesta non è arrivata. Cosa si sapeva:');
    console.error(`  chat: ${state?.state ?? '?'} · occupata: ${state?.busy ?? '?'} · pid ${state?.pid ?? '-'}`);
    console.error(`  messaggi nel transcript: ${turnNow?.messages?.length ?? '?'} (${turnNow?.messages?.map((m) => m.role).join(',') ?? '-'})`);
    console.error(`  il prompt è nel transcript? ${JSON.stringify(turnNow?.messages ?? []).includes(COMMAND) ? 'sì' : 'NO'}`);
    const health = await api('/healthz').catch(() => null);
    console.error(`  turni: ${JSON.stringify(health?.turns ?? {})}`);
    console.error(`  permessi in attesa: ${health?.approvals ?? '?'}`);
    throw error;
  });
  check('la richiesta di permesso attraversa il proxy e arriva al client',
    JSON.stringify(asked.approval.input).includes(COMMAND), asked.approval.toolName);

  phone.ws.send(JSON.stringify({ t: 'approve', id: asked.approval.id, behavior: 'allow' }));

  // Si aspetta la fine vera del turno, non la prima risposta dell'API.
  const deadline = Date.now() + 180_000;
  let finished = await turn;
  while (!['done', 'error', 'timeout'].includes(finished.json?.turn?.state) && Date.now() < deadline) {
    await sleep(2_000);
    finished = await ask();
  }
  const state = finished.json?.turn?.state;
  check('il turno finisce: il permesso è stato concesso davvero', state === 'done', `${state}${finished.json?.turn?.error ? ` — ${finished.json.turn.error}` : ''}`);
  check('e il comando ha girato', /Example Domain|example\.com/i.test(String(finished.json?.turn?.reply)));

  phone.ws.close();
} catch (error) {
  check('giro da fuori', false, error.message);
} finally {
  if (session?.sessionId) await api(`/local/sessions/${session.sessionId}/forget`, { method: 'POST' }).catch(() => {});
}

console.log(`\n${failures === 0 ? 'REMOTE PASS' : `REMOTE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
