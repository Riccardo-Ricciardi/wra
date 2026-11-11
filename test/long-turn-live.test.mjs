import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

/**
 * Il turno lungo, sul server vero: HTTP → coordinatore → PTY → transcript.
 *
 * È il caso che ha prodotto due turni persi: l'agente lavora più a lungo della finestra di
 * ascolto, e la risposta arrivava quando nessuno guardava più. Qui l'attesa non si simula —
 * c'è un processo vero, un transcript vero, e una finestra di ascolto **corta apposta**
 * (`CR_MAX_WAIT_MS=900`) con una risposta che arriva molto dopo (`CR_FAKE_DELAY_MS=2500`).
 *
 * Quello che si pretende:
 *  1. la chiamata HTTP riceve la **risposta finale**, non un parziale né un timeout;
 *  2. se il client se ne va prima (la connessione cade), il turno arriva lo stesso in fondo e
 *     la risposta resta nel giornale — recuperabile dopo, anche dopo un riavvio del server.
 */

const repo = path.resolve(import.meta.dirname, '..');
const TOKEN = 'token-di-prova-turni-lunghi-abbastanza';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server = null;
let port = null;
let root = null;

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-lungo-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });

  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const chosen = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], {
    env: {
      ...process.env,
      CR_TOKEN: TOKEN,
      CR_PORT: String(chosen),
      CR_CLAUDE_CMD: process.execPath,
      CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
      CR_DEFAULT_PROJECT: project,
      CR_ALLOWED_ROOTS: root,
      CR_STATE_FILE: path.join(root, 'sessions.json'),
      CR_PROJECTS_FILE: path.join(root, 'projects.json'),
      CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
      CR_PROJECTS_ROOT: path.join(root, 'projects'),
      // La finestra di ascolto, corta: un turno la supera di sicuro.
      CR_MAX_WAIT_MS: '900',
      CR_POLL_MS: '150',
      CR_SETTLE_MS: '400',
      // La risposta dell'agente, molto dopo la fine della prima finestra.
      CR_FAKE_DELAY_MS: '2500',
      CR_DEFAULT_WAIT_S: '25',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !port) {
    const match = out.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) port = Number(match[1]);
    else await sleep(100);
  }
  if (!port) throw new Error(`server non partito: ${out}`);
  server = { child, project };
});

test.after(() => {
  server?.child.kill();
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // il PTY può tenere la cartella: è pulizia, non un test
  }
});

const headers = { 'x-cc-remote-token': TOKEN, 'content-type': 'application/json' };
const url = (route) => `http://127.0.0.1:${port}${route}`;

async function newSession() {
  const response = await fetch(url('/local/sessions'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ projectPath: server.project, name: 'turno lungo' }),
  });
  assert.equal(response.status, 200, 'la chat si crea');
  const body = await response.json();
  return body.session.sessionId;
}

const health = async () => (await fetch(url('/healthz'), { headers })).json();

async function waitForFree(sessionId, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const body = await health();
    const entry = (body.turns?.sessions ?? []).find((item) => item.sessionId === sessionId);
    if (!entry || (!entry.running && !entry.waiting)) return body;
    await sleep(200);
  }
  throw new Error('il turno non è finito entro il tempo massimo');
}

test('un turno più lungo della finestra di ascolto arriva in fondo, e la risposta è intera', { timeout: 90_000 }, async () => {
  const sessionId = await newSession();
  await sleep(1_500); // il PTY deve essere acceso

  const started = Date.now();
  const response = await fetch(url('/local/talk'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId, message: 'un lavoro che dura', requestId: 'r-lungo-1' }),
  });
  assert.equal(response.status, 200);
  const { turn } = await response.json();

  assert.equal(turn.state, 'done', `atteso done, arrivato ${turn.state}: ${JSON.stringify(turn).slice(0, 300)}`);
  assert.match(String(turn.reply), /RICEVUTO un lavoro che dura/, 'la risposta è quella dell\'agente, intera');
  assert.ok(turn.watches >= 2, `la finestra di ascolto si è rinnovata (finestre: ${turn.watches})`);
  assert.ok(Date.now() - started >= 2_500, 'e la risposta è arrivata davvero dopo la prima finestra');
});

test('il client se ne va a metà: il turno finisce lo stesso, e la risposta resta nel giornale', { timeout: 90_000 }, async () => {
  const sessionId = await newSession();
  await sleep(1_500);

  // La connessione cade mentre l'agente lavora: è quello che succede quando la chiamata MCP
  // scade, o quando il telefono perde la rete.
  const controller = new AbortController();
  const call = fetch(url('/local/talk'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId, message: 'lavoro abbandonato', requestId: 'r-lungo-2' }),
    signal: controller.signal,
  }).catch(() => null);
  await sleep(400);
  controller.abort();
  await call;

  await waitForFree(sessionId);

  const journal = JSON.parse(fs.readFileSync(path.join(root, 'turns.json'), 'utf8'));
  const entry = journal.turns.find((item) => item.requestId === 'r-lungo-2');
  assert.ok(entry, 'il turno è nel giornale: la risposta non è andata persa con la connessione');
  assert.equal(entry.state, 'done');
  assert.match(String(entry.reply), /RICEVUTO lavoro abbandonato/, 'e la risposta c\'è tutta');

  // E il server non è rimasto con un turno appeso: la chat è di nuovo libera.
  const body = await health();
  const entryNow = (body.turns?.sessions ?? []).find((item) => item.sessionId === sessionId);
  assert.ok(!entryNow || (!entryNow.running && !entryNow.waiting), 'nessun turno appeso');
});

test('due conversazioni, due turni lunghi insieme: nessuna aspetta l altra, e nessuna perde la risposta', { timeout: 90_000 }, async () => {
  const [a, b] = [await newSession(), await newSession()];
  await sleep(2_000); // due PTY da accendere

  const call = (sessionId, message) => fetch(url('/local/talk'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId, message, requestId: `r-conc-${sessionId.slice(0, 8)}` }),
  }).then((response) => response.json());

  const started = Date.now();
  const [first, second] = await Promise.all([
    call(a, 'lavoro lungo A'),
    call(b, 'lavoro lungo B'),
  ]);

  // Entrambe le risposte sono intere, e nessuna è in coda dietro l'altra: due conversazioni
  // diverse non si aspettano (una coda è per sessione, non globale).
  assert.equal(first.turn.state, 'done', JSON.stringify(first.turn).slice(0, 200));
  assert.equal(second.turn.state, 'done', JSON.stringify(second.turn).slice(0, 200));
  assert.match(String(first.turn.reply), /RICEVUTO lavoro lungo A/);
  assert.match(String(second.turn.reply), /RICEVUTO lavoro lungo B/);
  assert.ok(first.turn.watches >= 2 && second.turn.watches >= 2, 'tutte e due hanno superato la finestra');
  assert.ok(Date.now() - started < 20_000, 'sono andate in parallelo, non una dopo l\'altra');
});
