import assert from 'node:assert/strict';
import test from 'node:test';
import { RESUME_QUIET_MS, latestForProject, planAttach } from '../src/core/attach-plan.mjs';

const LIVE = { uuid: 'aaaaaaaa-1111-2222-3333-444444444444' };
const NEWEST = { id: 'bbbbbbbb-1111-2222-3333-444444444444', mtimeMs: 0 };
const NOW = RESUME_QUIET_MS * 10;

const plan = (extra = {}) => planAttach({ projectDir: 'C:\\proj', live: null, newest: null, now: NOW, ...extra });

test('cc: apre sempre una sessione nuova', () => {
  const result = plan({ mode: 'new' });
  assert.equal(result.action, 'new');
  assert.equal(result.resumeId, null);
  assert.equal(result.forceRestart, true, 'deve chiudere comunque quella che trova: nuova vuol dire nuova');
});

test('cc -c senza niente da riprendere apre una nuova', () => {
  const result = plan({ mode: 'continue' });
  assert.equal(result.action, 'new');
});

test('cc: se una sessione e viva la chiude, perche nuova vuol dire nuova', () => {
  const result = plan({ mode: 'new', live: LIVE });
  assert.equal(result.action, 'new');
  assert.equal(result.forceRestart, true);
  assert.match(result.text, /chiudo la sessione viva/);
});

test('cc -c: riprende la conversazione piu recente', () => {
  const result = plan({ mode: 'continue', newest: NEWEST });
  assert.equal(result.action, 'resume');
  assert.equal(result.resumeId, NEWEST.id);
});

test('cc -c: se e gia quella viva si limita ad agganciarla, senza riavviare', () => {
  const result = plan({ mode: 'continue', live: { uuid: NEWEST.id }, newest: NEWEST });
  assert.equal(result.action, 'attach');
  assert.equal(result.forceRestart, false);
});

test('cc -c: sostituisce la sessione viva se e un altra conversazione', () => {
  const result = plan({ mode: 'continue', live: LIVE, newest: NEWEST });
  assert.equal(result.action, 'resume');
  assert.equal(result.resumeId, NEWEST.id);
  assert.equal(result.forceRestart, true);
});

test('cc -c senza niente da riprendere apre una nuova', () => {
  const result = plan({ mode: 'continue' });
  assert.equal(result.action, 'new');
});

test('auto: aggancia la sessione viva se c e', () => {
  const result = plan({ live: LIVE, newest: NEWEST });
  assert.equal(result.action, 'attach');
  assert.equal(result.resumeId, null);
});

test('auto: riprende la conversazione piu recente se e ferma da un po', () => {
  const result = plan({ newest: NEWEST });
  assert.equal(result.action, 'resume');
  assert.equal(result.resumeId, NEWEST.id);
});

test('auto: NON riprende una conversazione scritta adesso (sarebbe un fork)', () => {
  const result = plan({ newest: { id: NEWEST.id, mtimeMs: NOW - 1000 } });
  assert.equal(result.action, 'new');
  assert.equal(result.resumeId, null);
  assert.match(result.text, /already has a conversation written/);
  assert.equal(result.forceRestart, false);
});

test('auto: senza niente, nessuna azione', () => {
  const result = plan({});
  assert.equal(result.action, 'none');
});

test('wra -c riprende la conversazione piu attiva della cartella, non l ultima creata', () => {
  const sessions = [
    { sessionId: 'vecchia-ma-attiva', projectPath: 'C:\\proj', createdAt: '2026-01-01T00:00:00Z', lastActivityAt: '2026-11-09T10:00:00Z' },
    { sessionId: 'nuova-ma-ferma', projectPath: 'C:\\proj', createdAt: '2026-11-01T00:00:00Z', lastActivityAt: '2026-11-02T10:00:00Z' },
    { sessionId: 'altro-progetto', projectPath: 'C:\\other', createdAt: '2026-11-10T00:00:00Z', lastActivityAt: '2026-11-10T10:00:00Z' },
  ];
  assert.equal(latestForProject(sessions, 'C:\\proj')?.sessionId, 'vecchia-ma-attiva');
});

test('la scelta a mano vince, ma solo dentro la cartella', () => {
  const sessions = [
    { sessionId: 'scelta', projectPath: 'C:\\proj', lastActivityAt: '2026-01-01T00:00:00Z' },
    { sessionId: 'recente', projectPath: 'C:\\proj', lastActivityAt: '2026-11-09T00:00:00Z' },
    { sessionId: 'altrove', projectPath: 'C:\\other', lastActivityAt: '2026-11-10T00:00:00Z' },
  ];
  assert.equal(latestForProject(sessions, 'C:\\proj', 'scelta')?.sessionId, 'scelta');
  assert.equal(latestForProject(sessions, 'C:\\proj', 'altrove')?.sessionId, 'recente');
});

test('senza conversazioni in questa cartella non se ne inventa una', () => {
  assert.equal(latestForProject([], 'C:\\proj'), null);
});
