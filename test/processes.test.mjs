// I processi: chi è nostro, chi è rimasto, e — la cosa che conta di più — **cosa non si tocca**.
// Su questa macchina `claude` gira anche per la sessione interattiva di chi usa il PC e per il rig
// vecchio: un elenco che pesca per nome dell'eseguibile è il modo di ammazzare il lavoro di
// qualcun altro. Si riconosce un processo nostro dall'id che gli abbiamo passato noi.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProcessLedger, ledgerFile } from '../src/host/process-ledger.mjs';
import { classify, killVerified, listProcesses, ours, processAlive, sessionIdOf } from '../src/host/processes.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ESTRANEO = '99999999-9999-4999-8999-999999999999';

test('l\'id di una conversazione si legge dalla riga di comando, in tutte le sue forme', () => {
  assert.equal(sessionIdOf(`node claude --session-id ${A}`), A);
  assert.equal(sessionIdOf(`claude.exe --resume ${B} --permission-mode default`), B);
  assert.equal(sessionIdOf(`claude --session-id="${A}"`), A);
  assert.equal(sessionIdOf('claude'), null);
  assert.equal(sessionIdOf(undefined), null);
});

test('nostro è solo chi porta l\'id di una nostra conversazione', () => {
  const rows = [
    { pid: 1, commandLine: `claude --session-id ${A}` },
    { pid: 2, commandLine: `claude --session-id ${ESTRANEO}` },
    { pid: 3, commandLine: 'claude' },
    { pid: 4, commandLine: 'node /percorso/fake-claude.mjs --session-id ' + B },
  ];
  assert.deepEqual(ours(rows, [A, B]).map((row) => row.pid), [1, 4]);
});

test('chi non si riconosce non si tocca: la sessione interattiva di chi usa il PC resta fuori', () => {
  const processes = [
    { pid: 100, commandLine: `claude --session-id ${A}`, startedAt: '2026-11-02T10:00:00.000Z' },
    { pid: 300, commandLine: '"C:\\nodejs\\node.exe" claude.exe' }, // senza id assegnato
    { pid: 400, commandLine: `claude --session-id ${ESTRANEO}` }, // un altro rig
  ];
  const out = classify({
    processes,
    managed: [{ pid: 100, sessionId: A, name: 'una' }],
    leftovers: [],
    known: [A],
  });
  assert.deepEqual(out.managed.map((row) => row.pid), [100]);
  assert.deepEqual(out.orphans, []);
  assert.deepEqual(out.windows, []);
  assert.deepEqual(out.foreign.map((row) => row.pid), [400], 'gli estranei si vedono e non si toccano');
  assert.ok(!out.rows.some((row) => row.pid === 400));
});

// Il caso che questa distinzione esiste per evitare: la `claude` di una conversazione aperta in
// un'altra finestra (`cc`, `rc attach`) non è un residuo — è lavoro in corso. Se comparisse fra gli
// orfani, il pannello offrirebbe di chiudere la sessione che si sta usando.
test('una conversazione aperta da un\'altra finestra non è un residuo', () => {
  const processes = [{ pid: 500, commandLine: `claude --session-id ${A}`, startedAt: '2026-11-02T10:00:00.000Z' }];
  const out = classify({ processes, managed: [], leftovers: [], known: [A] });
  assert.deepEqual(out.orphans, []);
  assert.deepEqual(out.windows.map((row) => row.pid), [500]);
  assert.match(out.windows[0].why, /work in progress/);
});

test('un processo acceso dal server e mai chiuso è un residuo, e si dice da dove viene', () => {
  const processes = [
    { pid: 200, commandLine: `claude --resume ${B}`, startedAt: '2026-11-02T11:00:00.000Z' },
    { pid: 500, commandLine: `claude --session-id ${A}` },
  ];
  const out = classify({
    processes,
    managed: [],
    leftovers: [{ pid: 200, sessionId: B, name: 'due' }, { pid: 900, sessionId: null }],
    known: [A, B],
  });
  const residuo = out.orphans.find((row) => row.pid === 200);
  assert.equal(residuo.sessionId, B);
  assert.equal(residuo.name, 'due');
  assert.match(residuo.why, /forced shutdown/);
  // 500 ha il nostro id ma non è nel registro dei processi del server: è un'altra finestra.
  assert.deepEqual(out.windows.map((row) => row.pid), [500]);
  // 900 era scritto e non c'è più: non è un residuo, è una riga da togliere.
  assert.equal(out.rows.find((row) => row.pid === 900).kind, 'gone');
  assert.equal(processAlive(900), false);
});

test('chiudere un processo richiede di riconoscerlo: nessuna verifica, nessuna chiusura', () => {
  const calls = [];
  const verify = () => ({ alive: true, sessionId: A });
  assert.equal(killVerified({ pid: 100, sessionId: A, verify, kill: (id) => calls.push(id) }).ok, true);
  assert.deepEqual(calls, [100]);

  const noVerify = killVerified({ pid: 100, sessionId: A, kill: (id) => calls.push(id) });
  assert.equal(noVerify.ok, false);
  assert.match(noVerify.reason, /will not close it/);

  const altro = killVerified({ pid: 100, sessionId: B, verify, kill: (id) => calls.push(id) });
  assert.equal(altro.ok, false);
  assert.match(altro.reason, /another conversation/);

  const muto = killVerified({ pid: 100, sessionId: A, verify: () => ({ alive: true, sessionId: null }), kill: (id) => calls.push(id) });
  assert.equal(muto.ok, false);
  assert.match(muto.reason, /by hand/);

  const morto = killVerified({ pid: 100, sessionId: A, verify: () => ({ alive: false, sessionId: A }), kill: (id) => calls.push(id) });
  assert.equal(morto.ok, false);
  assert.match(morto.reason, /is gone/);

  assert.deepEqual(calls, [100], 'solo il primo ha chiuso qualcosa');
});

test('il registro dei processi si scrive accanto al registro delle conversazioni', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ledger-'));
  const config = { stateFile: path.join(dir, 'sessions.json'), home: dir };
  assert.equal(ledgerFile(config), path.join(dir, 'processes.json'));

  const ledger = createProcessLedger({ file: ledgerFile(config) });
  ledger.note({ pid: 101, sessionId: A, name: 'una' });
  ledger.note({ pid: 102, sessionId: B, name: 'due' });
  ledger.note({ pid: 101, sessionId: A, name: 'una' }); // due volte lo stesso processo: una riga
  assert.equal(ledger.all().length, 2);
  assert.deepEqual(ledger.leftovers((pid) => pid === 102).map((entry) => entry.pid), [102]);

  ledger.forget(101);
  assert.deepEqual(ledger.all().map((entry) => entry.pid), [102]);
  ledger.clear();
  assert.deepEqual(ledger.all(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('un registro dei processi illeggibile non fa cadere niente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ledger-broken-'));
  const file = path.join(dir, 'processes.json');
  fs.writeFileSync(file, 'non è json');
  const ledger = createProcessLedger({ file });
  assert.deepEqual(ledger.all(), []);
  ledger.note({ pid: 7, sessionId: A });
  assert.equal(ledger.all().length, 1, 'e si riparte da un registro sano');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('un pid non valido non entra nel registro', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ledger-pid-'));
  const ledger = createProcessLedger({ file: path.join(dir, 'processes.json') });
  ledger.note({ pid: null, sessionId: A });
  ledger.note({ pid: 0, sessionId: A });
  ledger.note({ pid: -3, sessionId: A });
  assert.deepEqual(ledger.all(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('la scansione dei processi non solleva mai: se non si può, dice «non lo so»', () => {
  assert.equal(listProcesses({ probes: { run: () => { throw new Error('niente powershell'); } } }), null);
  const parsed = listProcesses({
    probes: {
      platform: 'win32',
      run: () => JSON.stringify([{ ProcessId: 5, ParentProcessId: 1, CreationDate: '/Date(1762000000000)/', CommandLine: `claude --session-id ${A}` }]),
    },
  });
  assert.deepEqual(parsed, [{ pid: 5, ppid: 1, startedAt: new Date(1762000000000).toISOString(), commandLine: `claude --session-id ${A}` }]);
});
