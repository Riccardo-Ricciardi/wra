import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createTurnCoordinator } from '../src/host/turn-coordinator.mjs';
import { createTurnJournal } from '../src/host/turn-journal.mjs';

// Il giornale dei turni, e la cosa per cui esiste: **l'idempotenza sopravvive al riavvio**.
// In memoria basta un Map; il caso che conta è il client che riprova la stessa richiesta dopo
// che il server è stato spento e riacceso — lì il Map non c'è più, il giornale sì.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-journal-'));
  return { root, file: path.join(root, 'turns.json') };
}

const registry = () => ({
  sinkFor: (sessionId) => ({ sessionId, projectPath: '/tmp/x', transcriptPath: `/tmp/${sessionId}.jsonl`, send: async () => {}, alive: () => true }),
  markBusy: () => {},
});

function coordinatorWith(journal, { delayMs = 20, config = {} } = {}) {
  return createTurnCoordinator({
    config: { ...loadConfig({}), promptMatchMs: 100, pollMs: 20, settleMs: 20, turnMaxMs: 2_000, maxQueue: 3, ...config },
    registry: registry(),
    journal,
    run: async ({ message }) => {
      await sleep(delayMs);
      return { status: 'done', reply: `RICEVUTO ${message}`, elapsedMs: delayMs };
    },
  });
}

test('un turno finito con requestId resta scritto nel giornale', async () => {
  const { file, root } = tempFile();
  try {
    const journal = createTurnJournal({ file });
    const coordinator = coordinatorWith(journal);
    const submitted = coordinator.submit({ sessionId: 's1', message: 'ciao', requestId: 'req-1' });
    await coordinator.wait(submitted.turn.turnId, 2_000);

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.turns.length, 1);
    assert.equal(written.turns[0].requestId, 'req-1');
    assert.equal(written.turns[0].state, 'done');
    assert.equal(written.turns[0].reply, 'RICEVUTO ciao');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dopo un riavvio la stessa requestId non riesegue il turno', async () => {
  const { file, root } = tempFile();
  try {
    const first = coordinatorWith(createTurnJournal({ file }));
    const submitted = first.submit({ sessionId: 's1', message: 'una volta sola', requestId: 'req-importante' });
    await first.wait(submitted.turn.turnId, 2_000);

    // il server si spegne e riparte: coordinator nuovo, stesso file
    let executed = false;
    const restarted = createTurnCoordinator({
      config: { ...loadConfig({}), pollMs: 20, settleMs: 20 },
      registry: registry(),
      journal: createTurnJournal({ file }),
      run: async () => { executed = true; return { status: 'done', reply: 'DI NUOVO', elapsedMs: 1 }; },
    });

    const again = restarted.submit({ sessionId: 's1', message: 'una volta sola', requestId: 'req-importante' });
    assert.equal(again.reused, true, 'la richiesta è riconosciuta come già fatta');
    assert.equal(again.fromJournal, true);
    assert.equal(again.turn.state, 'done');
    assert.equal(again.turn.reply, 'RICEVUTO una volta sola', 'e restituisce la risposta di allora');

    await sleep(120);
    assert.equal(executed, false, 'il motore NON è stato richiamato: nessun secondo prompt nella conversazione');

    // e si ritrova anche chiedendo lo stato per requestId
    assert.equal(restarted.byRequest('req-importante').reply, 'RICEVUTO una volta sola');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('senza requestId non si scrive niente: non c è niente da rendere idempotente', async () => {
  const { file, root } = tempFile();
  try {
    const journal = createTurnJournal({ file });
    const coordinator = coordinatorWith(journal);
    const submitted = coordinator.submit({ sessionId: 's1', message: 'senza id' });
    await coordinator.wait(submitted.turn.turnId, 2_000);
    assert.equal(journal.size(), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il giornale è limitato: i più vecchi escono', async () => {
  const { file, root } = tempFile();
  try {
    const journal = createTurnJournal({ file, size: 3 });
    for (const id of ['a', 'b', 'c', 'd']) {
      journal.remember({ requestId: id, sessionId: 's1', turnId: `t-${id}`, state: 'done', reply: id, finishedAt: Date.now() });
    }
    assert.deepEqual(journal.list().map((entry) => entry.requestId), ['b', 'c', 'd']);
    assert.equal(journal.get('a'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un giornale illeggibile non impedisce di partire: al massimo si perde la memoria', () => {
  const { file, root } = tempFile();
  try {
    fs.writeFileSync(file, '{rotto');
    const journal = createTurnJournal({ file });
    assert.equal(journal.size(), 0);
    journal.remember({ requestId: 'x', sessionId: 's1', turnId: 't', state: 'done', reply: 'ok', finishedAt: Date.now() });
    assert.equal(journal.get('x').reply, 'ok', 'e riscrive da capo un giornale valido');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).turns.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('la coda ha un tetto: oltre, si rifiuta invece di accodare all infinito', async () => {
  const { root } = tempFile();
  try {
    const coordinator = coordinatorWith(null, { delayMs: 400, config: { maxQueue: 2 } });
    coordinator.submit({ sessionId: 's1', message: 'in corso' }); // occupa il posto di testa
    coordinator.submit({ sessionId: 's1', message: 'coda 1' });
    coordinator.submit({ sessionId: 's1', message: 'coda 2' });
    assert.throws(
      () => coordinator.submit({ sessionId: 's1', message: 'troppo' }),
      (error) => error.code === 'QUEUE_FULL' && /queue is full/.test(error.message),
    );
    // e un'altra sessione non paga per la prima
    assert.ok(coordinator.submit({ sessionId: 's2', message: 'altra' }).turn.turnId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('se il processo dell agente muore, il turno finisce subito con un errore chiaro', async () => {
  const { root } = tempFile();
  try {
    let alive = true;
    const coordinator = createTurnCoordinator({
      config: { ...loadConfig({}), pollMs: 20, settleMs: 20, turnMaxMs: 60_000 },
      registry: {
        sinkFor: (sessionId) => ({ sessionId, projectPath: '/tmp/x', transcriptPath: '/tmp/x.jsonl', send: async () => {}, alive: () => alive }),
        markBusy: () => {},
      },
      run: async ({ pty }) => {
        // il motore vero controlla `alive()`; qui si aspetta che il processo sparisca, come fa lui
        const deadline = Date.now() + 3_000;
        while (pty.alive() && Date.now() < deadline) await sleep(20);
        return { status: 'error', error: 'il processo dell\'agente è terminato durante il turno', elapsedMs: 0 };
      },
    });

    const submitted = coordinator.submit({ sessionId: 's1', message: 'ciao' });
    const startedAt = Date.now();
    setTimeout(() => { alive = false; }, 100);

    const done = await coordinator.wait(submitted.turn.turnId, 3_000);
    assert.equal(done.state, 'error');
    assert.match(done.error, /terminato/);
    assert.ok(Date.now() - startedAt < 2_500, 'non si aspetta la scadenza lunga del turno');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lo snapshot dice cosa sta girando e cosa aspetta', async () => {
  const { root } = tempFile();
  try {
    const coordinator = coordinatorWith(null, { delayMs: 150 });
    coordinator.submit({ sessionId: 's1', message: 'in corso' });
    coordinator.submit({ sessionId: 's1', message: 'in coda' });

    const snapshot = coordinator.snapshot();
    const s1 = snapshot.sessions.find((entry) => entry.sessionId === 's1');
    assert.equal(s1.waiting, 1);
    assert.equal(s1.running.state, 'running');
    assert.equal(typeof s1.running.elapsedMs, 'number');
    assert.ok(Array.isArray(snapshot.stuck), 'e i turni sospetti si elencano a parte');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
