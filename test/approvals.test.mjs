import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovals } from '../src/host/approvals.mjs';

// Il relay delle approvazioni. Il caso che conta più di tutti è l'ultimo: quando nessuno
// risponde, la risposta è «non decido io» — mai un permesso concesso da soli.

const setup =(overrides = {}) => createApprovals({ config: { approvalTtlMs: 5_000, ...overrides } });

test('una richiesta in attesa si vede, e la decisione torna a chi ha chiesto', async () => {
  const approvals = setup();
  const waiting = approvals.ask({ sessionId: 's1', toolName: 'Bash', input: { command: 'rm -rf /tmp/x' } });

  const [asked] = approvals.list();
  assert.equal(asked.sessionId, 's1');
  assert.equal(asked.toolName, 'Bash');
  assert.equal(asked.input.command, 'rm -rf /tmp/x', 'chi decide deve vedere cosa verrebbe eseguito');

  approvals.decide(asked.id, { behavior: 'allow' });
  assert.deepEqual(await waiting, { behavior: 'allow' });
  assert.equal(approvals.list().length, 0, 'decisa, non è più in attesa');
});

test('rifiutare porta un motivo, e il motivo arriva a chi ha chiesto', async () => {
  const approvals = setup();
  const waiting = approvals.ask({ sessionId: 's1', toolName: 'Write' });
  approvals.decide(approvals.list()[0].id, { behavior: 'deny', message: 'non qui' });
  assert.deepEqual(await waiting, { behavior: 'deny', message: 'non qui' });
});

test('la prima decisione vince: la seconda non cambia niente', async () => {
  const approvals = setup();
  const waiting = approvals.ask({ sessionId: 's1', toolName: 'Bash' });
  const id = approvals.list()[0].id;

  approvals.decide(id, { behavior: 'deny', message: 'no' });
  assert.equal(approvals.decide(id, { behavior: 'allow' }), null, 'la seconda non trova più niente');
  assert.equal((await waiting).behavior, 'deny');
});

test('una decisione che non è allow né deny si rifiuta', () => {
  const approvals = setup();
  approvals.ask({ sessionId: 's1', toolName: 'Bash' });
  assert.throws(() => approvals.decide(approvals.list()[0].id, { behavior: 'forse' }), /invalid decision/);
});

test('nessuno risponde: la risposta è «non decido io», non un permesso', async () => {
  const approvals = setup({ approvalTtlMs: 60 });
  const decision = await approvals.ask({ sessionId: 's1', toolName: 'Bash' });
  assert.equal(decision, null, 'scaduta: il terminale mostra il suo dialog');
  assert.equal(approvals.list().length, 0);
});

test('relay spento (TTL 0): non si mette in attesa nessuno', async () => {
  const approvals = setup({ approvalTtlMs: 0 });
  assert.equal(await approvals.ask({ sessionId: 's1', toolName: 'Bash' }), null);
  assert.equal(approvals.list().length, 0);
});

test('le richieste si distinguono per sessione, e una sessione che muore le libera', async () => {
  const approvals = setup();
  const first = approvals.ask({ sessionId: 's1', toolName: 'Bash' });
  const second = approvals.ask({ sessionId: 's2', toolName: 'Write' });
  assert.equal(approvals.forSession('s1').length, 1);
  assert.equal(approvals.forSession('s1')[0].toolName, 'Bash');
  assert.equal(approvals.list().length, 2);

  approvals.clear('s1');
  assert.equal(await first, null, 'la sessione non c è più: chi aspetta esce');
  assert.equal(approvals.forSession('s2').length, 1, 'e l altra resta');

  approvals.decide(approvals.list()[0].id, { behavior: 'deny' });
  assert.equal((await second).behavior, 'deny');
});

test('gli eventi raccontano la storia: chiesta, poi sparita', async () => {
  const approvals = setup();
  const seen = [];
  approvals.onEvent((event) => seen.push(event.type));

  const waiting = approvals.ask({ sessionId: 's1', toolName: 'Bash' });
  approvals.decide(approvals.list()[0].id, { behavior: 'allow' });
  await waiting;
  assert.deepEqual(seen, ['asked', 'gone']);
});

// ── il criterio dell'«MCP automatico controllato» ────────────────────────────
// Non è una deroga alla regola («qui non si concede mai niente da soli»): è un criterio che si
// applica prima dell'attesa, non decide mai su un guasto, e viene interrogato a ogni richiesta —
// ed è per questo che la revoca ha effetto subito.

const withPolicy = (policy, overrides = {}) => createApprovals({ config: { approvalTtlMs: 5_000, ...overrides }, policy });

test('il criterio che concede: la risposta è immediata e non resta niente in attesa', async () => {
  const seen = [];
  const approvals = withPolicy((request) => {
    seen.push(request);
    return request.toolName === 'Edit' ? { behavior: 'allow', reason: 'Edit inside the project, no reserved path' } : null;
  });
  approvals.onEvent((event) => seen.push(event.type));

  const decision = await approvals.ask({ sessionId: 's1', toolName: 'Edit', input: { file_path: 'a.js' } });
  assert.deepEqual(decision, { behavior: 'allow' });
  assert.equal(approvals.list().length, 0, 'concessa: nessuno deve decidere niente');
  assert.ok(seen.includes('auto'), 'la concessione si annuncia: un permesso dato senza chiedere non deve essere invisibile');

  const [granted] = approvals.autoList();
  assert.equal(granted.sessionId, 's1');
  assert.equal(granted.toolName, 'Edit');
  assert.equal(granted.reason, 'Edit inside the project, no reserved path');
  assert.equal(granted.automatic, true);
  assert.ok(granted.id, 'anche una concessione automatica ha un id: si può nominare');
  assert.equal(approvals.autoCount(), 1);
});

test('il criterio che tace: si chiede come sempre, e la persona decide', async () => {
  const approvals = withPolicy(() => null);
  const waiting = approvals.ask({ sessionId: 's1', toolName: 'Bash', input: { command: 'rm -rf /tmp/x' } });
  assert.equal(approvals.list().length, 1, 'il criterio non ha concesso niente: la richiesta è in attesa');
  approvals.decide(approvals.list()[0].id, { behavior: 'deny', message: 'no' });
  assert.equal((await waiting).behavior, 'deny');
  assert.equal(approvals.autoCount(), 0);
});

test('un criterio che si rompe non concede niente: si prosegue verso l\'attesa', async () => {
  const approvals = withPolicy(() => { throw new Error('criterio rotto'); });
  const waiting = approvals.ask({ sessionId: 's1', toolName: 'Edit', input: { file_path: 'a.js' } });
  assert.equal(approvals.list().length, 1, 'un guasto del criterio costa una domanda, non un permesso');
  approvals.decide(approvals.list()[0].id, { behavior: 'allow' });
  assert.equal((await waiting).behavior, 'allow', 'la decisione della persona arriva comunque');
});

test('il criterio risponde, ma nessuno risponde: la revoca vale dalla richiesta dopo', async () => {
  let acceso = true;
  const approvals = withPolicy(() => (acceso ? { behavior: 'allow', reason: 'acceso' } : null));

  assert.equal((await approvals.ask({ sessionId: 's1', toolName: 'Edit', input: { file_path: 'a.js' } })).behavior, 'allow');

  acceso = false; // la dashboard ha spento l'interruttore: nessun riavvio, nessuna cache
  const waiting = approvals.ask({ sessionId: 's1', toolName: 'Edit', input: { file_path: 'a.js' } });
  assert.equal(approvals.list().length, 1, 'spento: si torna a chiedere');
  approvals.decide(approvals.list()[0].id, { behavior: 'deny', message: 'adesso no' });
  assert.equal((await waiting).behavior, 'deny');
});

test('relay spento (TTL 0): non risponde nemmeno il criterio', async () => {
  const approvals = withPolicy(() => ({ behavior: 'allow', reason: 'acceso' }), { approvalTtlMs: 0 });
  assert.equal(await approvals.ask({ sessionId: 's1', toolName: 'Edit', input: { file_path: 'a.js' } }), null);
  assert.equal(approvals.autoCount(), 0, 'se cc-remote non deve rispondere ai permessi, non risponde per nessuna via');
});

test('senza criterio configurato non cambia niente: si chiede', async () => {
  const approvals = createApprovals({ config: { approvalTtlMs: 5_000 } });
  const waiting = approvals.ask({ sessionId: 's1', toolName: 'Edit', input: { file_path: 'a.js' } });
  assert.equal(approvals.list().length, 1);
  approvals.decide(approvals.list()[0].id, { behavior: 'allow' });
  assert.equal((await waiting).behavior, 'allow');
});
