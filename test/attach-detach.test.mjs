import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { DETACH, DETACH_KEYS, detachAt } from '../src/core/attach-plan.mjs';

// `rc attach` si stacca con Ctrl+Q (0x11). Non con Ctrl+C: quello deve continuare ad arrivare
// a Claude, che lo usa per interrompere.
//
// La prova con un PTY dentro un PTY non regge: su Windows il conhost inietta eventi di
// fuoco/mouse nello stdin del figlio appena l'output abilita il reporting (`?1004h`), e i tasti
// scritti dopo finiscono persi o fusi con quelli. È un artefatto del banco di prova, non del
// programma — il byte 0x11 arriva intatto a un figlio in raw mode. Quindi qui si prova ciò che
// è deterministico: la sequenza di tasti, e che staccarsi non tocchi il processo della chat.

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'token-di-prova-lungo-abbastanza';
const FAKE = path.join(repo, 'tools', 'fake-claude.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('nella sequenza di tasti, Ctrl+Q è quello che stacca', () => {
  assert.equal(detachAt(Buffer.from('ciao')), -1);
  assert.equal(detachAt(Buffer.from([DETACH])), 0);
  // In mezzo al testo: il byte resta riconoscibile anche quando arriva insieme ad altro.
  assert.equal(detachAt(Buffer.from(`abc${String.fromCharCode(DETACH)}`)), 3);
  // Ctrl+C non stacca: deve restare libero per Claude.
  assert.equal(detachAt(Buffer.from([0x03])), -1);
});

// Due tasti, non uno: su Windows un terminale può mangiarsi una combinazione e non l'altra, e
// restare agganciati senza una via d'uscita è peggio che avere due modi di uscire.
test('anche Ctrl+] stacca, e vince il tasto che arriva per primo', () => {
  assert.deepEqual(DETACH_KEYS, [0x11, 0x1d]);
  assert.equal(detachAt(Buffer.from([0x1d])), 0);
  assert.equal(detachAt(Buffer.from('abc\x1d')), 3);
  assert.equal(detachAt(Buffer.from('ab\x1dcd\x11')), 2, 'il primo dei due, non l\'ultimo');
  assert.equal(detachAt(Buffer.from('ab\x11cd\x1d')), 2);
  // Un tasto normale che contiene lo stesso byte per caso non stacca.
  assert.equal(detachAt(Buffer.from('q')), -1);
});

test('staccarsi chiude il client, non la chat: il processo resta vivo e occupato', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-detach-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  // Porta scelta dal sistema (`CR_PORT=0`), non pescata a caso: su Windows esistono intervalli
  // riservati (`netsh int ipv4 show excludedportrange protocol=tcp`) — 25050-25149 su questa
  // macchina — e una porta dentro uno di quelli dà EACCES all'avvio. Il test falliva una volta su
  // dieci per questo, non per il codice.
  const env = {
    ...process.env,
    CR_TOKEN: TOKEN,
    CR_PORT: '0',
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: project,
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_LOG_FILE: path.join(root, 'serve.log'),
    CR_CLAUDE_CMD: process.execPath,
    CR_CLAUDE_ARGS: JSON.stringify([FAKE]),
  };

  const server = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.setEncoding('utf8').on('data', (chunk) => { serverLog += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { serverLog += chunk; });

  let ws;
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !/WRA on http:\/\//.test(serverLog)) {
      if (server.exitCode !== null) break;
      await sleep(100);
    }
    assert.match(serverLog, /WRA on http:\/\//, `il server non è partito: ${serverLog}`);
    // La porta vera la dice il server: con `CR_PORT=0` è l'unico modo di saperla.
    const port = Number(serverLog.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/)[1]);
    assert.ok(port > 0, 'il server non ha detto la porta');

    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [`bearer.${TOKEN}`]);
    const opened = new Promise((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', proto: 2, role: 'terminal', cols: 100, rows: 30 })));
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.t === 'opened') resolve(message.session);
      });
      ws.on('error', reject);
    });
    await new Promise((resolve) => ws.on('message', (raw) => {
      if (JSON.parse(raw.toString()).t === 'welcome') resolve();
    }));
    ws.send(JSON.stringify({ t: 'create', projectPath: project, name: 'stacco' }));
    const session = await opened;

    // Scriviamo qualcosa: la chat si muove, come quando Claude risponde.
    ws.send(JSON.stringify({ t: 'input', data: 'ciao-da-attach\r' }));
    const health = async () => fetch(`http://127.0.0.1:${port}/healthz`, { headers: { 'x-cc-remote-token': TOKEN } }).then((r) => r.json());
    const until = async (predicate, what) => {
      const limit = Date.now() + 20_000;
      while (Date.now() < limit) {
        const found = await health();
        if (predicate(found)) return found;
        await sleep(150);
      }
      throw new Error(`tempo scaduto aspettando ${what}`);
    };
    await until((h) => h.sessions.some((s) => s.sessionId === session.sessionId), 'la chat viva');
    const before = (await health()).sessions.find((s) => s.sessionId === session.sessionId);

    // Lo stacco: esattamente quello che fa `leave()` — si chiude il socket e basta.
    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
    await sleep(1_000);

    const after = await health();
    const still = after.sessions.find((s) => s.sessionId === session.sessionId);
    assert.ok(still, 'la chat è sparita dal server dopo lo stacco');
    // Quello che conta è che il processo sia ancora vivo, non che lo stato sia *identico*:
    // fra prima e dopo l'agente può aver finito di avviarsi (starting → ready), e quello è
    // lavoro suo, non un effetto dello stacco.
    assert.ok(
      ['starting', 'ready', 'busy'].includes(still.state),
      `lo stacco ha spento la conversazione: era ${before.state}, ora è ${still.state}`,
    );
    assert.equal(still.pid, before.pid, 'ed è lo stesso processo di prima, non uno riavviato');
  } finally {
    try { ws?.close(); } catch { /* già chiuso */ }
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
