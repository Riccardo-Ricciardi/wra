import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { runTurn } from '../src/core/turns.mjs';
import { TailingReader } from '../src/core/transcript.mjs';
import { createTurnCoordinator } from '../src/host/turn-coordinator.mjs';
import { createTurnJournal } from '../src/host/turn-journal.mjs';

/**
 * Il ciclo di vita di un turno lungo.
 *
 * Il difetto che questi casi chiudono, trovato nel giornale dei turni veri (due `state:
 * "timeout"`, `reply: null`, `error: null` a 600 secondi esatti): la **finestra di ascolto**
 * veniva trattata come la **fine del turno**. L'agente continuava a lavorare — i commit li ha
 * fatti — ma nessuno leggeva più il transcript, e la risposta non era recuperabile da nessuna
 * parte. Il messaggio del client era «Errore: null».
 *
 * Quello che si pretende adesso:
 *  - la finestra scade, il turno **no**: si riprende a guardare dallo stesso punto;
 *  - il messaggio si manda **una volta sola** (rimandarlo sarebbe un secondo prompt);
 *  - il risultato finale si recupera anche senza il `turnId` (una connessione nuova);
 *  - il tetto vero, quando arriva, lascia il parziale e un motivo — mai `null`.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function registryStub() {
  const busy = [];
  return {
    busy,
    sinkFor: (sessionId) => ({
      sessionId,
      projectPath: path.join(os.tmpdir(), 'progetto'),
      transcriptPath: path.join(os.tmpdir(), `${sessionId}.jsonl`),
      send: async () => {},
    }),
    markBusy: (sessionId, value) => busy.push({ sessionId, value }),
  };
}

function setup({ run, journal = null, config: extra = {} } = {}) {
  const registry = registryStub();
  const config = { ...loadConfig({}), promptMatchMs: 200, pollMs: 20, settleMs: 30, turnMaxMs: 5_000, ...extra };
  const coordinator = createTurnCoordinator({ config, registry, run, journal });
  return { coordinator, registry, config };
}

// ---------------------------------------------------------------------------
// Il motore: la ripresa non rimanda il messaggio, e non rilegge quello che ha già letto.
// ---------------------------------------------------------------------------

test('la ripresa riparte dallo stesso punto: nessun doppione, nessun secondo prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-resume-'));
  const transcript = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(transcript, '');

  const line = (entry) => `${JSON.stringify(entry)}\n`;
  const assistant = (text, stop) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop },
  });

  let sends = 0;
  const pty = {
    projectPath: dir,
    alive: () => true,
    send: async () => {
      sends += 1;
      // Quello che farebbe l'agente: il prompt nel transcript, e una prima parte di risposta
      // che **non** chiude il turno (una chiamata a strumento in mezzo).
      fs.appendFileSync(transcript, line({ type: 'user', message: { role: 'user', content: 'messaggio lungo' }, promptId: 'p1' }));
      fs.appendFileSync(transcript, line(assistant('prima parte', 'tool_use')));
    },
  };

  const first = await runTurn({
    pty, message: 'messaggio lungo', transcriptPath: transcript, projectDir: dir,
    promptMatchMs: 2_000, pollMs: 20, settleMs: 40, maxWaitMs: 250,
  });

  assert.equal(first.status, 'in_progress', 'la finestra di ascolto finisce, il turno no');
  assert.equal(first.partial, 'prima parte');
  assert.equal(typeof first.offset, 'number', 'e si sa da dove riprendere');
  assert.equal(sends, 1);

  // L'agente finisce **dopo**: è esattamente il caso dei due turni persi.
  fs.appendFileSync(transcript, line(assistant('seconda parte', 'end_turn')));

  const second = await runTurn({
    pty, message: 'messaggio lungo', transcriptPath: transcript, projectDir: dir,
    promptMatchMs: 2_000, pollMs: 20, settleMs: 40, maxWaitMs: 5_000,
    resume: { transcriptPath: first.transcript, promptId: first.promptId, offset: first.offset, partial: first.partial, tools: first.tools, ended: first.ended },
  });

  assert.equal(second.status, 'done', JSON.stringify(second));
  assert.equal(second.reply, 'prima parte\n\nseconda parte', 'il testo raccolto prima non si perde e non si duplica');
  assert.equal(sends, 1, 'il messaggio NON si rimanda: sarebbe un secondo prompt nella stessa conversazione');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('un agente che finisce e poi esce lascia la risposta: non si dichiara morto senza leggerla', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-dead-'));
  const transcript = path.join(dir, 'chat.jsonl');
  // La risposta è già lì: l'agente l'ha scritta e **poi** è uscito.
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'fatto' }], stop_reason: 'end_turn' },
  })}\n`);

  const pty = { projectPath: dir, alive: () => false, send: async () => { throw new Error('non deve rimandare niente'); } };

  const result = await runTurn({
    pty, message: 'x', transcriptPath: transcript, projectDir: dir,
    promptMatchMs: 2_000, pollMs: 20, settleMs: 30, maxWaitMs: 3_000,
    resume: { transcriptPath: transcript, promptId: 'p1', offset: 0, partial: '', tools: [], ended: false },
  });

  assert.equal(result.status, 'done', JSON.stringify(result));
  assert.equal(result.reply, 'fatto');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Il coordinatore: la finestra si rinnova, il turno resta uno solo.
// ---------------------------------------------------------------------------

test('la finestra di ascolto si rinnova: il turno arriva in fondo, con il messaggio mandato una volta', async () => {
  const calls = [];
  const states = [];
  const { coordinator } = setup({
    run: async ({ message, resume }) => {
      calls.push({ message, resume });
      if (!resume) {
        return { status: 'in_progress', promptId: 'p1', transcript: '/t.jsonl', partial: 'prima parte', offset: 100, tools: ['Bash'], ended: false, elapsedMs: 5 };
      }
      return { status: 'done', promptId: 'p1', transcript: '/t.jsonl', reply: 'prima parte\n\nseconda parte', tools: ['Bash'], offset: 200, elapsedMs: 5 };
    },
  });
  coordinator.onEvent((turn) => states.push(turn.state));

  const submitted = coordinator.submit({ sessionId: 's1', message: 'lavoro lungo', requestId: 'req-lungo' });
  const done = await coordinator.wait(submitted.turn.turnId, 3_000);

  assert.equal(done.state, 'done', JSON.stringify(done));
  assert.equal(done.reply, 'prima parte\n\nseconda parte');
  assert.equal(calls.length, 2, 'due finestre, un solo turno');
  assert.equal(calls[1].resume.offset, 100, 'la seconda riparte da dove la prima si era fermata');
  assert.equal(calls[1].message, calls[0].message);
  assert.equal(done.watches, 2);
  assert.ok(!states.includes('timeout'), 'la fine di una finestra non è un timeout');
});

test('con la stessa requestId, mentre il turno si sta ancora riprendendo, non parte un secondo turno', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { coordinator } = setup({
    run: async ({ resume }) => {
      calls += 1;
      if (!resume) return { status: 'in_progress', transcript: '/t.jsonl', partial: 'a', offset: 1, tools: [], ended: false, elapsedMs: 1 };
      await gate;
      return { status: 'done', transcript: '/t.jsonl', reply: 'finito', offset: 2, elapsedMs: 1 };
    },
  });

  const first = coordinator.submit({ sessionId: 's1', message: 'una volta', requestId: 'req-1' });
  await sleep(60); // il turno è nella seconda finestra, ancora in corso
  assert.equal(coordinator.get(first.turn.turnId).state, 'running');

  const again = coordinator.submit({ sessionId: 's1', message: 'una volta', requestId: 'req-1' });
  assert.equal(again.reused, true, 'la stessa richiesta riusa il turno');
  assert.equal(again.turn.turnId, first.turn.turnId);
  assert.equal(calls, 2, 'e non fa partire una terza esecuzione');
  assert.equal(coordinator.depth('s1'), 1);

  release();
  const done = await coordinator.wait(first.turn.turnId, 3_000);
  assert.equal(done.reply, 'finito');
});

test('un turno che si riprende tiene il posto in coda: il secondo non gli passa davanti', async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { coordinator } = setup({
    run: async ({ message, resume }) => {
      if (!resume) {
        order.push(`inizio ${message}`);
        return { status: 'in_progress', transcript: '/t.jsonl', partial: '', offset: 1, tools: [], ended: false, elapsedMs: 1 };
      }
      if (message === 'prima') await gate;
      order.push(`fine ${message}`);
      return { status: 'done', transcript: '/t.jsonl', reply: `ok ${message}`, offset: 2, elapsedMs: 1 };
    },
  });

  const a = coordinator.submit({ sessionId: 's1', message: 'prima' });
  await sleep(60);
  const b = coordinator.submit({ sessionId: 's1', message: 'seconda' });
  assert.equal(b.turn.state, 'queued');
  assert.equal(coordinator.depth('s1'), 2, 'il turno in ripresa occupa ancora il posto');

  release();
  await coordinator.wait(a.turn.turnId, 3_000);
  const done = await coordinator.wait(b.turn.turnId, 3_000);
  assert.equal(done.state, 'done');
  assert.deepEqual(order, ['inizio prima', 'fine prima', 'inizio seconda', 'fine seconda']);
});

test('il client si disconnette: la chiamata torna "in corso", il turno arriva lo stesso in fondo', async () => {
  const { coordinator } = setup({
    run: async ({ resume }) => {
      if (!resume) {
        // Più lungo della grana con cui `wait` guarda lo stato (150 ms), così la scadenza del
        // client arriva **mentre** il turno lavora: è quello che si vuole provare.
        await sleep(800);
        return { status: 'in_progress', transcript: '/t.jsonl', partial: 'meta', offset: 1, tools: [], ended: false, elapsedMs: 1 };
      }
      return { status: 'done', transcript: '/t.jsonl', reply: 'risposta completa', offset: 2, elapsedMs: 1 };
    },
  });

  const submitted = coordinator.submit({ sessionId: 's1', message: 'ciao' });
  // Quello che fa la chiamata MCP quando la sua attesa scade (o il socket cade).
  const cut = await coordinator.settle(submitted.turn, 40);
  assert.equal(cut.state, 'running', 'la scadenza del client non tocca il turno');

  const later = await coordinator.wait(submitted.turn.turnId, 3_000);
  assert.equal(later.state, 'done');
  assert.equal(later.reply, 'risposta completa');
});

test('senza il turnId la risposta si recupera lo stesso: l\'ultimo turno di quella chat', async () => {
  const { coordinator } = setup({
    run: async () => ({ status: 'done', transcript: '/t.jsonl', reply: 'eccola', offset: 1, elapsedMs: 1 }),
  });

  const submitted = coordinator.submit({ sessionId: 's1', message: 'ciao' });
  await coordinator.wait(submitted.turn.turnId, 3_000);

  const recovered = coordinator.latest('s1');
  assert.equal(recovered.reply, 'eccola');
  assert.equal(recovered.turnId, submitted.turn.turnId);
  assert.equal(coordinator.latest('mai-vista'), null);
});

test('il tetto vero: il turno si chiude con il parziale e con un motivo, mai con null', async () => {
  const { coordinator } = setup({
    // Il tetto va dentro `config`: passato di fianco sarebbe ignorato, e un motore che risponde
    // sempre "in corso" girerebbe per sempre.
    config: { turnHardMs: 0 },
    run: async () => ({ status: 'in_progress', transcript: '/t.jsonl', partial: 'quello che ha scritto finora', offset: 1, tools: [], ended: false, elapsedMs: 1 }),
  });

  const submitted = coordinator.submit({ sessionId: 's1', message: 'ciao' });
  const done = await coordinator.wait(submitted.turn.turnId, 3_000);

  assert.equal(done.state, 'timeout');
  assert.equal(done.partial, 'quello che ha scritto finora', 'il parziale non si butta');
  assert.ok(done.error && done.error.length > 0, 'e il motivo c\'è');
  assert.notEqual(done.error, null);
});

// ---------------------------------------------------------------------------
// Il giornale: la risposta sopravvive al riavvio, anche per chi non ha il requestId.
// ---------------------------------------------------------------------------

test('il giornale tiene la risposta e il parziale, e si interroga anche per sessione', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-journal-'));
  const journal = createTurnJournal({ file: path.join(dir, 'turns.json'), size: 10 });

  journal.remember({ requestId: 'r1', sessionId: 's1', turnId: 't1', state: 'done', reply: 'la risposta', partial: 'non serve', finishedAt: Date.now() });
  journal.remember({ requestId: 'r2', sessionId: 's1', turnId: 't2', state: 'timeout', reply: null, partial: 'x'.repeat(9_000), error: 'tetto raggiunto', finishedAt: Date.now() });

  assert.equal(journal.latestFor('s1').turnId, 't2', 'l\'ultimo di quella sessione');
  assert.equal(journal.latestFor('s2'), null);
  assert.equal(journal.get('r1').partial, null, 'di un turno riuscito il parziale non serve: la risposta c\'è');
  assert.equal(journal.get('r2').partial.length, 4_000, 'di uno scaduto si tiene, con un tetto');

  // e il coordinatore lo presenta come un turno finito, non come uno vivo
  const { coordinator } = setup({ journal, run: async () => ({ status: 'done', reply: null, elapsedMs: 1 }) });
  const remembered = coordinator.byRequest('r2');
  assert.equal(remembered.fromJournal, true);
  assert.equal(remembered.state, 'timeout');
  assert.equal(remembered.partial.length, 4_000);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('una riga arrivata a metà non si perde: la ripresa riparte dall inizio di quella riga', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-split-'));
  const transcript = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(transcript, '');

  const complete = (entry) => `${JSON.stringify(entry)}\n`;
  const user = { type: 'user', message: { role: 'user', content: 'messaggio' }, promptId: 'p1' };
  const partial = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'prima parte' }], stop_reason: 'tool_use' } };
  // La riga finale, scritta **in due pezzi**: è quello che fa un transcript quando la risposta
  // è grossa o il disco scrive quando gli pare.
  const finalLine = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'parte finale intera' }], stop_reason: 'end_turn' },
  });
  const half = Math.floor(finalLine.length / 2);

  const pty = {
    projectPath: dir,
    alive: () => true,
    send: async () => {
      fs.appendFileSync(transcript, complete(user));
      fs.appendFileSync(transcript, complete(partial));
      fs.appendFileSync(transcript, finalLine.slice(0, half)); // niente a capo: riga incompleta
    },
  };

  const first = await runTurn({
    pty, message: 'messaggio', transcriptPath: transcript, projectDir: dir,
    promptMatchMs: 2_000, pollMs: 20, settleMs: 40, maxWaitMs: 250,
  });

  assert.equal(first.status, 'in_progress');
  assert.equal(first.partial, 'prima parte', 'la riga a metà non è stata interpretata');
  const completeBytes = Buffer.byteLength(complete(user) + complete(partial), 'utf8');
  assert.equal(first.offset, completeBytes, 'si riprende dall\'inizio della riga incompleta, non da metà');

  fs.appendFileSync(transcript, `${finalLine.slice(half)}\n`); // adesso è intera

  const second = await runTurn({
    pty, message: 'messaggio', transcriptPath: transcript, projectDir: dir,
    promptMatchMs: 2_000, pollMs: 20, settleMs: 40, maxWaitMs: 3_000,
    resume: { transcriptPath: transcript, promptId: first.promptId, offset: first.offset, partial: first.partial, tools: [], ended: false },
  });

  assert.equal(second.status, 'done', JSON.stringify(second));
  assert.equal(second.reply, 'prima parte\n\nparte finale intera', 'e la riga si legge intera');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('se il transcript si accorcia sotto il turno, non si riprende: si dice, non si duplica', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-troncato-'));
  const transcript = path.join(dir, 'chat.jsonl');
  // Un file che esiste ma è **più corto** del punto da cui si riprendeva: troncato, sostituito,
  // o un id riusato. Riprendere da lì rileggerebbe da capo e duplicherebbe la risposta.
  fs.writeFileSync(transcript, 'x\n');

  const pty = { projectPath: dir, alive: () => true, send: async () => { throw new Error('non deve rimandare niente'); } };
  const result = await runTurn({
    pty, message: 'messaggio', transcriptPath: transcript, projectDir: dir,
    promptMatchMs: 1_000, pollMs: 20, settleMs: 30, maxWaitMs: 1_000,
    resume: { transcriptPath: transcript, promptId: 'p1', offset: 5_000, partial: 'quello di prima', tools: [], ended: false },
  });

  assert.equal(result.status, 'error', JSON.stringify(result));
  assert.match(result.error, /transcript changed during the turn/);
  assert.equal(result.partial, 'quello di prima', 'e quello che si era raccolto non si butta');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('una riga tagliata DENTRO un carattere multi-byte non si perde', async () => {
  // Il caso che il taglio "a metà stringa" non copre: se il confine della scrittura cade dentro
  // una sequenza UTF-8, il decoder tiene da parte quei byte, e non sono in `carry`. Contando i
  // byte *letti* invece di quelli *emessi*, `resumeOffset` ripartiva dentro la riga e la riga
  // andava persa. Provato con una sonda prima di scrivere il controllo: dava `1` invece di `0`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-multibyte-'));
  const transcript = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(transcript, '');

  const reader = new TailingReader(transcript);
  reader.sync();

  const line = `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'però è così' }], stop_reason: 'end_turn' },
  })}\n`;
  const bytes = Buffer.from(line, 'utf8');
  const cut = bytes.indexOf(Buffer.from('è', 'utf8')) + 1; // dentro la sequenza di `è`

  fs.appendFileSync(transcript, bytes.subarray(0, cut));
  assert.deepEqual(reader.readNew(), [], 'la riga non è completa: non si interpreta');
  assert.equal(reader.resumeOffset, 0, 'si riprende dall\'inizio della riga, non da dentro il carattere');

  fs.appendFileSync(transcript, bytes.subarray(cut));
  const resumed = new TailingReader(transcript);
  resumed.sync();
  resumed.seek(reader.resumeOffset);
  const entries = resumed.readNew();
  assert.equal(entries.length, 1, 'la riga si legge intera');
  assert.equal(entries[0].message.content[0].text, 'però è così', 'e il testo non è mozzato');

  fs.rmSync(dir, { recursive: true, force: true });
});
