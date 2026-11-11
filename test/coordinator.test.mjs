import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createTurnCoordinator } from '../src/host/turn-coordinator.mjs';

// Il coordinatore: coda per sessione, idempotenza del requestId, bersaglio congelato.
// Si inietta un finto `run` al posto del motore vero: qui si prova la logica, non il PTY.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ delayMs = 60 } = {}) {
  const started = [];
  const registry = {
    sinkFor: (sessionId) => ({ sessionId, projectPath: '/tmp/x', transcriptPath: `/tmp/${sessionId}.jsonl`, send: async () => {} }),
    markBusy: (sessionId, busy) => started.push({ sessionId, busy }),
  };
  const config = { ...loadConfig({}), promptMatchMs: 100, pollMs: 50, settleMs: 50, turnMaxMs: 5000 };
  const coordinator = createTurnCoordinator({
    config,
    registry,
    run: async ({ pty, message }) => {
      await sleep(delayMs);
      return { status: 'done', reply: `RICEVUTO ${message}`, promptId: 'p', transcript: pty.transcriptPath, elapsedMs: delayMs };
    },
  });
  return { coordinator, started };
}

test('un turno alla volta per sessione: il secondo va in coda, non si sovrappone', async () => {
  const { coordinator } = setup({ delayMs: 120 });
  const a = coordinator.submit({ sessionId: 's1', message: 'prima' });
  const b = coordinator.submit({ sessionId: 's1', message: 'seconda' });

  assert.equal(b.turn.state, 'queued');
  assert.equal(b.turn.position, 1);
  await coordinator.wait(a.turn.turnId, 2_000);
  const done = await coordinator.wait(b.turn.turnId, 2_000);
  assert.equal(done.state, 'done');
  assert.equal(done.reply, 'RICEVUTO seconda');

  // due sessioni diverse non si aspettano: ognuna parte subito (e' la prima della sua coda)
  const c = coordinator.submit({ sessionId: 's2', message: 'altra' });
  const d = coordinator.submit({ sessionId: 's3', message: 'terza' });
  assert.equal(c.turn.state, 'running');
  assert.equal(d.turn.state, 'running');
  assert.equal(coordinator.depth('s2'), 1);
});

test('lo stesso requestId non esegue due volte: nemmeno dopo una disconnessione', async () => {
  const { coordinator } = setup({ delayMs: 120 });
  const first = coordinator.submit({ sessionId: 's1', message: 'una volta', requestId: 'req-1' });
  const again = coordinator.submit({ sessionId: 's1', message: 'una volta', requestId: 'req-1' });

  assert.equal(again.reused, true, 'il secondo invio riusa il turno');
  assert.equal(again.turn.turnId, first.turn.turnId);

  const done = await coordinator.wait(first.turn.turnId, 2_000);
  assert.equal(done.reply, 'RICEVUTO una volta');

  // e anche a turno finito, lo stesso requestId restituisce quello di prima
  const later = coordinator.submit({ sessionId: 's1', message: 'una volta', requestId: 'req-1' });
  assert.equal(later.turn.turnId, first.turn.turnId);
  assert.equal(later.turn.state, 'done');
});

test("il bersaglio e' congelato: cambiare scelta a meta' turno non sposta il turno", async () => {
  const { coordinator, started } = setup({ delayMs: 150 });
  const turn = coordinator.submit({ sessionId: 'A', message: 'resta qui' });
  // "cambio switch": arriva un altro turno su B
  const other = coordinator.submit({ sessionId: 'B', message: 'altro' });

  const done = await coordinator.wait(turn.turn.turnId, 2_000);
  assert.equal(done.sessionId, 'A', 'il turno finisce dove e partito');
  assert.equal(other.turn.sessionId, 'B');
  assert.deepEqual(
    started.map((entry) => entry.sessionId).filter((value, index, all) => all.indexOf(value) === index).sort(),
    ['A', 'B'],
  );
});
