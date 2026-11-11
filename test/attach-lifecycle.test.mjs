import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TERMINAL_RESET } from '../src/web/ui/terminal-reset.mjs';

// Il ciclo di vita di una finestra agganciata, provato con un PTY **vero** e il binario vero di
// `rc attach`. Non si iniettano tasti da fuori: si scrivono i byte che il terminale manderebbe, e
// si guarda cosa fa attach — che è la parte che dipende da noi.
//
// I tre modi di uscire che contano, e che non devono confondersi fra loro:
//   Ctrl+C  → interrompe il lavoro dell'agente, **non** stacca
//   Ctrl+Q  → stacca, la conversazione resta viva
//   la morte dell'agente → la finestra esce da sola, invece di restare muta per sempre

const require = createRequire(import.meta.url);
const pty = require('node-pty');

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'token-di-prova-lungo-abbastanza';
const FAKE = path.join(repo, 'tools', 'fake-claude.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Un server suo, con il suo registro: la suite non deve toccare quello di nessuno. */
async function bench(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cc-attach-${name}-`));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  // La porta la sceglie il sistema (`CR_PORT=0`): un numero pescato a caso su Windows può cadere
  // in un intervallo riservato (`netsh int ipv4 show excludedportrange protocol=tcp`) e `listen`
  // dà EACCES — un fallimento che sembra un guasto del server ed è solo una porta vietata.
  // Il valore vero si legge dal log del server, ed è quello che usano poi anche i client.
  let port = 0;

  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CR_')) delete env[key];
  Object.assign(env, {
    CR_TOKEN: TOKEN,
    CR_PORT: String(port),
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_PROJECTS_FILE: path.join(root, 'projects.json'),
    CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: project,
    CR_LOG_FILE: path.join(root, 'serve.log'),
    CR_CLAUDE_CMD: process.execPath,
    CR_CLAUDE_ARGS: JSON.stringify([FAKE]),
  });

  const serve = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  serve.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  serve.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });

  const until = async (check, what, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await sleep(120);
    }
    throw new Error(`tempo scaduto: ${what}`);
  };
  await until(() => /WRA on http/.test(log), 'il server parta');
  // Con CR_PORT=0 la porta vera si sa solo adesso: si passa a `rc attach`, altrimenti quello non
  // trova nessuno, se ne accende un altro per conto suo e il test prova due server invece di uno.
  port = Number(log.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
  assert.ok(port > 0, `il server non ha detto la porta: ${log}`);
  env.CR_PORT = String(port);

  const api = (route, body = null) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-cc-remote-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((response) => response.json());

  const windows = [];
  const close = async () => {
    // Prima le finestre agganciate: un PTY ancora vivo tiene su l'event loop, e il file dei test
    // non finirebbe mai anche se tutti i casi sono passati.
    for (const window of windows) window.kill();
    await sleep(400);
    try { serve.kill(); } catch { /* già morto */ }
    await sleep(300);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        return;
      } catch {
        await sleep(250);
      }
    }
  };

  return { root, project, port, env, api, until, close, windows };
}

/** Apre una finestra agganciata in un PTY vero e restituisce i modi per guardarla. */
async function attach(bench_, { needle = 'finestra' } = {}) {
  const child = pty.spawn(process.execPath, [path.join(repo, 'src', 'cli', 'attach.mjs'), needle], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: bench_.project, env: bench_.env,
  });
  const state = { wrote: '', exited: false, code: null };
  child.onData((data) => { state.wrote += data; });
  child.onExit((event) => { state.exited = true; state.code = event.exitCode; });
  state.child = child;
  state.write = (bytes) => child.write(bytes);
  state.kill = () => { try { child.kill(); } catch { /* già morto */ } };
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !/attached/.test(state.wrote) && !state.exited) await sleep(120);
  bench_.windows.push(state);
  if (state.exited) throw new Error(`attach è uscito subito: ${JSON.stringify(state.wrote.slice(-200))}`);
  return state;
}

test('Ctrl+C non stacca: il byte va all\'agente, non al client', async () => {
  const bench_ = await bench('ctrlc');
  try {
    await bench_.api('/local/sessions', { projectPath: bench_.project, name: 'finestra' });
    const window = await attach(bench_);
    const before = window.wrote.length;
    window.write('\x03');
    await sleep(2_000);

    const after = window.wrote.slice(before);
    // La cosa che conta: non si è staccata da sola. Il byte 0x03 è andato alla sessione, che è
    // dove Claude lo usa per interrompere. Se il byte fosse stato interpretato qui, la finestra
    // sarebbe uscita — ed è il modo di sbagliare che questo test esiste per impedire.
    assert.ok(!/detached/.test(after), `Ctrl+C ha detached: ${JSON.stringify(after.slice(-120))}`);
    // Con questa TUI finta, il byte fa uscire l'agente (non è in raw mode, quindi per il suo
    // conhost è un CTRL_C_EVENT): la finestra allora se ne accorge e lo dice, invece di restare lì.
    if (window.exited) {
      assert.match(after, /the session has ended/, `uscita senza spiegazione: ${JSON.stringify(after.slice(-160))}`);
    }
  } finally {
    await bench_.close();
  }
});

test('Ctrl+Q stacca, la conversazione resta viva, e il terminale viene rimesso a posto', async () => {
  const bench_ = await bench('ctrlq');
  try {
    const created = await bench_.api('/local/sessions', { projectPath: bench_.project, name: 'finestra' });
    const sessionId = created.session.sessionId;
    const window = await attach(bench_);
    window.write('\x11');
    await sleep(1_500);

    assert.equal((window.wrote.match(/attached:/g) ?? []).length, 1, "la riga dell'aggancio è stata stampata più di una volta");
    assert.equal(window.exited, true, 'Ctrl+Q non ha detached');
    assert.equal(window.code, 0, `uscita con codice ${window.code}`);
    assert.match(window.wrote, /detached/, 'non ha detto che si è staccata');

    const after = (await bench_.api('/local/sessions')).sessions.find((session) => session.sessionId === sessionId);
    assert.ok(after, 'la conversazione è sparita dal registro');
    assert.ok(['ready', 'starting', 'busy'].includes(after.state), `lo stacco ha spento la conversazione: ${after.state}`);
  } finally {
    await bench_.close();
  }
});

test('quando l\'agente muore, la finestra agganciata esce da sola invece di restare muta', async () => {
  const bench_ = await bench('morte');
  try {
    const created = await bench_.api('/local/sessions', { projectPath: bench_.project, name: 'finestra' });
    const sessionId = created.session.sessionId;
    const window = await attach(bench_);
    await bench_.until(async () => (await bench_.api('/local/sessions')).sessions.find((s) => s.sessionId === sessionId)?.state === 'ready', 'la sessione sia pronta');

    // Il processo dell'agente muore (crash, `taskkill`, o Claude che esce).
    const pid = (await bench_.api('/local/sessions')).sessions.find((session) => session.sessionId === sessionId).pid;
    assert.ok(pid, 'la sessione non ha un processo');
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });

    await bench_.until(() => window.exited, 'la finestra esca da sola', 15_000);
    assert.match(window.wrote, /the session has ended/, 'è uscita senza dire perché');
    assert.equal(window.code, 0, `uscita con codice ${window.code}`);

    const after = (await bench_.api('/local/sessions')).sessions.find((session) => session.sessionId === sessionId);
    assert.equal(after.state, 'exited', 'una morte deve leggersi come morte, non come «mai accesa»');
    assert.ok(after, 'e la conversazione deve restare nel registro');
  } finally {
    await bench_.close();
  }
});

test('rc detach stacca la finestra, e la conversazione non se ne accorge', async () => {
  const bench_ = await bench('detach');
  try {
    const created = await bench_.api('/local/sessions', { projectPath: bench_.project, name: 'finestra' });
    const sessionId = created.session.sessionId;
    const window = await attach(bench_);

    const result = await bench_.api('/local/detach', { sessionId });
    assert.equal(result.detached, 1, 'rc detach non ha detached niente');

    await bench_.until(() => window.exited, 'la finestra esca', 10_000);
    assert.match(window.wrote, /on request/, 'non ha detto che è stato chiesto');
    assert.ok(['ready', 'starting', 'busy'].includes((await bench_.api('/local/sessions')).sessions.find((s) => s.sessionId === sessionId).state));
  } finally {
    await bench_.close();
  }
});

test('le sequenze che rimettono a posto il terminale ci sono tutte', async () => {
  // Attraverso un PTY non si può osservare: conhost è un terminale, e le sequenze che cambiano il
  // suo stato le consuma invece di rimandarle a chi legge. Quindi si prova la definizione, che è
  // l'unica parte che dipende da noi — e che è condivisa fra la finestra e la scheda del browser.
  const wanted = {
    'esce dallo schermo alternativo': '\x1b[?1049l',
    'mostra il cursore': '\x1b[?25h',
    'spegne il mouse (normale)': '\x1b[?1000l',
    'spegne il mouse (a pressione)': '\x1b[?1002l',
    'spegne il mouse (a movimento)': '\x1b[?1003l',
    'spegne il mouse (SGR)': '\x1b[?1006l',
    'spegne il report del fuoco': '\x1b[?1004l',
    'spegne il bracketed paste': '\x1b[?2004l',
    'azzera i colori': '\x1b[0m',
  };
  for (const [what, sequence] of Object.entries(wanted)) {
    assert.ok(TERMINAL_RESET.includes(sequence), `manca la sequenza che ${what}`);
  }
  // `rc attach` e la scheda del browser devono usare **questa** definizione, non una loro copia.
  //
  // Si cerca l'**nome** del modulo e non il percorso intero: il percorso è dove il file capita di
  // stare oggi, e un controllo che lo fissa non prova la cosa che promette — prova che nessuno ha
  // spostato un file. Spostarli è esattamente quello che M7 fa, e M8.1 ha portato il terminale del
  // browser in `ui/views/terminal.mjs`: un controllo che fissava `app.js` è caduto per quello, cioè
  // per un fatto che non c'entrava niente con la promessa. Quello che conta è che tutta la parte
  // browser punti alla definizione condivisa invece di averne una copia sua.
  const attach = fs.readFileSync(path.join(repo, 'src', 'cli', 'attach.mjs'), 'utf8');
  assert.match(attach, /from '[^']*terminal-reset\.mjs'/, 'attach non usa la definizione condivisa');

  const web = (function cammina(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return cammina(full);
      // `.js` **e** `.mjs`: `app.js` è il file più importante di tutti, ed è l'unico `.js` della
      // cartella — un controllo che cammina solo i moduli non guarderebbe mai il guscio.
      return /\.m?js$/.test(entry.name) ? [full] : [];
    });
  })(path.join(repo, 'src', 'web'));

  const utenti = web.filter((file) => !file.endsWith('terminal-reset.mjs')
    && fs.readFileSync(file, 'utf8').includes('TERMINAL_RESET'));
  assert.ok(utenti.length > 0, 'nessun file del browser usa la definizione condivisa');
  for (const file of utenti) {
    assert.match(fs.readFileSync(file, 'utf8'), /from '[^']*terminal-reset\.mjs'/,
      `${path.relative(repo, file)} nomina TERMINAL_RESET senza importare la definizione condivisa`);
  }

  // E nessuno se ne scrive una copia a mano, con o senza il nome: la sequenza che esce dallo
  // schermo alternativo è quella che fa la differenza fra «la cronologia si scorre» e «la scheda
  // resta sporca», ed è l'unica che si riconosce a colpo d'occhio.
  for (const file of web) {
    if (file.endsWith('terminal-reset.mjs')) continue;
    assert.ok(!fs.readFileSync(file, 'utf8').includes('?1049l'),
      `${path.relative(repo, file)} ha una copia a mano delle sequenze: usa la definizione condivisa`);
  }

  // E che sia la **stessa**: due import che pescano due file diversi con lo stesso nome è il modo
  // in cui questa promessa si rompe senza che nessuno se ne accorga.
  const nome = (sorgente) => /from '([^']*terminal-reset\.mjs)'/.exec(sorgente)?.[1].split('/').pop();
  for (const file of utenti) {
    assert.equal(nome(fs.readFileSync(file, 'utf8')), nome(attach), `${path.relative(repo, file)} importa un file diverso`);
  }
});
