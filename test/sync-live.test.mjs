import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

// Una conversazione, due finestre: il terminale (`rc attach`) e il sito. Devono essere la
// stessa chat, lo stesso processo, e quello che succede in una deve vedersi nell'altra —
// nelle due direzioni. Qui i due client sono quelli veri (proto 2, gli stessi ruoli che usa
// `rc attach` e il sito): cambia solo che il terminale è pilotato a mano invece che dai tasti.

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'token-di-prova-lungo-abbastanza';
const FAKE = path.join(repo, 'tools', 'fake-claude.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function open(port, { role }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`bearer.${TOKEN}`]);
  const state = { messages: [], output: '', chat: [], opened: null, ws };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', proto: 2, role, cols: 100, rows: 30 })));
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    state.messages.push(message);
    if (message.t === 'opened') state.opened = message.session;
    if (message.t === 'output') state.output += message.data;
    if (message.t === 'chat') state.chat = message.messages;
  });
  state.send = (message) => ws.send(JSON.stringify(message));

  const subscriber = { sessionId: null };
  state.subscribe = (sessionId) => {
    subscriber.sessionId = sessionId;
    ws.send(JSON.stringify({ t: 'open', sessionId }));
  };

  // `until` guarda solo i messaggi arrivati **dopo** la sottoscrizione, così un messaggio
  // vecchio non fa passare una prova che non è mai successa.
  state.until = async (predicate, what, { timeoutMs = 20_000, from = null } = {}) => {
    const deadline = Date.now() + timeoutMs;
    // Di norma guarda solo i messaggi arrivati **dopo** la chiamata, così uno vecchio non fa
    // passare una prova che non è mai successa. Con `from: 0` guarda anche l'arretrato.
    const start = from ?? state.messages.length;
    while (Date.now() < deadline) {
      for (let index = start; index < state.messages.length; index += 1) {
        if (predicate(state.messages[index])) return state.messages[index];
      }
      await sleep(100);
    }
    throw new Error(`tempo scaduto aspettando ${what}: ${JSON.stringify(state.messages.slice(start)).slice(0, 500)}`);
  };
  return state;
}

// Il testo di un messaggio utente sta in `parts` (è quello che rende il sito), non in un
// campo `text`: leggerlo da lì è l'unico modo di provare quello che si vede davvero.
const textOf = (chat) => chat
  .filter((m) => m.role === 'user')
  .flatMap((m) => (m.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text))
  .join(' ');

test('terminale e sito: stessa chat, stesso processo, e i messaggi si vedono da tutte e due le parti', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-sync-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  const port = 26_000 + Math.floor(Math.random() * 1_000);
  const env = {
    ...process.env,
    CR_TOKEN: TOKEN,
    CR_PORT: String(port),
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: project,
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_LOG_FILE: path.join(root, 'serve.log'),
    CR_CLAUDE_CMD: process.execPath,
    CR_CLAUDE_ARGS: JSON.stringify([FAKE]),
    CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
  };

  const server = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.setEncoding('utf8').on('data', (chunk) => { serverLog += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { serverLog += chunk; });

  let terminal;
  let site;
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !/WRA on http:\/\//.test(serverLog)) {
      if (server.exitCode !== null) break;
      await sleep(100);
    }
    assert.match(serverLog, /WRA on http:\/\//, `il server non è partito: ${serverLog}`);

    // Il terminale apre la chat e si aggancia (è quello che fa `rc attach`).
    terminal = open(port, { role: 'terminal' });
    await terminal.until((m) => m.t === 'welcome', 'il benvenuto al terminale');
    terminal.send({ t: 'create', projectPath: project, name: 'sync' });
    const created = await terminal.until((m) => m.t === 'opened', 'la chat aperta dal terminale');
    const sessionId = created.session.sessionId;
    await terminal.until((m) => m.t === "output" && m.data.includes("FAKE-CLAUDE pronto"), "la TUI avviata", { from: 0 });

    // Il sito si aggancia **alla stessa chat**.
    site = open(port, { role: 'chat' });
    await site.until((m) => m.t === 'welcome', 'il benvenuto al sito');
    site.subscribe(sessionId);
    const siteOpened = await site.until((m) => m.t === 'opened', 'la chat aperta nel sito');
    assert.equal(siteOpened.session.sessionId, sessionId, 'il sito si è agganciato a un\'altra chat');

    // 1) Un messaggio scritto nel terminale compare nel sito.
    //    I segnalini si prendono *prima* di far partire il giro: la risposta può arrivare
    //    mentre si aspetta l'altra finestra, e allora sarebbe già passata.
    const siteMark = site.messages.length;
    const terminalMark = terminal.messages.length;
    terminal.send({ t: 'input', data: 'dal-terminale\r' });
    await site.until((m) => m.t === 'chat' && textOf(m.messages).includes('dal-terminale'), 'il messaggio del terminale nel sito', { from: siteMark });
    // ...e la risposta dell'agente compare nel terminale, in diretta.
    await terminal.until((m) => m.t === 'output' && m.data.includes('ECHO'), 'la risposta nel terminale', { from: terminalMark });

    // 2) Un messaggio inviato dal sito compare nel terminale.
    const talkMark = terminal.messages.length;
    const sent = await fetch(`http://127.0.0.1:${port}/local/talk`, {
      method: 'POST',
      headers: { 'x-cc-remote-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'dal-sito' }),
    });
    assert.equal(sent.status, 200, `il sito non è riuscito a parlare: ${sent.status}`);
    await terminal.until((m) => m.t === 'output' && m.data.includes('dal-sito'), 'il messaggio del sito nel terminale', { from: talkMark });

    // 3) Una sola chat, un solo processo: il sito non ne ha aperto un altro.
    const health = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { 'x-cc-remote-token': TOKEN } }).then((r) => r.json());
    const mine = health.sessions.filter((s) => path.resolve(s.projectPath) === path.resolve(project));
    assert.equal(mine.length, 1, `due client hanno aperto due chat nello stesso progetto: ${mine.length}`);
    assert.equal(mine[0].sessionId, sessionId);

    // 4) Chi guarda non riscrive: il sito è 'chat', quindi i suoi tasti non arrivano al PTY.
    //    Se arrivassero, il messaggio comparirebbe due volte.
    const before = terminal.output.length;
    site.send({ t: 'input', data: 'tasto-di-prova\r' });
    await sleep(1_500);
    assert.equal(terminal.output.slice(before).includes('tasto-di-prova'), false, 'un client di sola lettura ha scritto nel terminale');
  } finally {
    try { terminal?.ws.close(); } catch { /* già chiuso */ }
    try { site?.ws.close(); } catch { /* già chiuso */ }
    const closed = new Promise((resolve) => {
      if (server.exitCode !== null) return resolve();
      server.on('close', resolve);
      setTimeout(resolve, 5_000).unref();
    });
    server.kill();
    await closed;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 10) throw error;
        await sleep(200);
      }
    }
  }
});
