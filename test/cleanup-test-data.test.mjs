import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, missingTestSignals } from '../tools/cleanup-test-data.mjs';

const TEMP = 'c:/users/x/appdata/local/temp';
const TEST_ENTRY = `${TEMP}/cc-remote-e2e-abc123/progetto-auto-2`;

test('cartella temporanea + prefisso del test + basename del test: rimovibile', () => {
  assert.deepEqual(missingTestSignals(TEST_ENTRY, new Set(), TEMP), []);
});

test('una cartella vera non è di test, per quanti segnali manchino', () => {
  const missing = missingTestSignals('C:\\Users\\x\\Desktop\\Projects\\cc-remote', new Set(), TEMP);
  assert.equal(missing.length, 3);
});

test('se una sessione del registro punta lì, la voce non si tocca', () => {
  const missing = missingTestSignals(TEST_ENTRY, new Set([TEST_ENTRY]), TEMP);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /^S4/);
});

test('Temp2 non è la cartella temporanea: il prefisso da solo non basta', () => {
  const trap = 'c:/users/x/appdata/local/temp2/cc-remote-e2e-abc123/progetto-auto-2';
  assert.ok(missingTestSignals(trap, new Set(), TEMP).some((reason) => reason.startsWith('S1')));
});

test('classify separa rimovibili, da approvare e conservate', () => {
  const result = classify({
    tempRoot: TEMP,
    projects: [
      { key: 'a', path: TEST_ENTRY },
      { key: 'b', path: `${TEMP}/cc-remote-e2e-abc123/altro-progetto` },
      { key: 'c', path: 'c:/users/x/desktop/projects/cc-remote' },
    ],
    sessions: [],
  });
  assert.deepEqual(result.disposable.map((row) => row.key), ['a']);
  assert.deepEqual(result.ambiguous.map((row) => row.key), ['b']);
  assert.deepEqual(result.kept.map((row) => row.key), ['c']);
});

test('una sessione in una cartella temporanea si segnala e basta', () => {
  const result = classify({
    tempRoot: TEMP,
    projects: [],
    sessions: [{ sessionId: 's1', name: 'x', projectPath: `${TEMP}/una-cartella` }],
  });
  assert.equal(result.tempSessions.length, 1);
  assert.equal(result.disposable.length, 0);
});
