import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSessions, sortProjects, sortSessions } from '../src/web/core/ordering.mjs';

// Gli ordini dell'elenco: regole piccole, ma promesse — «i preferiti in cima» è una promessa, e
// una promessa si verifica. Sono pure, quindi si provano in Node, come il markdown.

const session = (name, over = {}) => ({ sessionId: name, name, ...over });
const project = (name, over = {}) => ({ key: name, name, ...over });

test('le conversazioni: per attività, per nome, per data di creazione', () => {
  const list = [
    session('b', { lastActivityAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-09-30T00:00:00.000Z' }),
    session('a', { lastActivityAt: '2026-10-09T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' }),
    session('c', { lastActivityAt: '2026-10-05T00:00:00.000Z', createdAt: '2026-10-04T00:00:00.000Z' }),
  ];
  assert.deepEqual(sortSessions(list, 'activity').map((s) => s.name), ['a', 'c', 'b']);
  assert.deepEqual(sortSessions(list, 'name').map((s) => s.name), ['a', 'b', 'c']);
  assert.deepEqual(sortSessions(list, 'created').map((s) => s.name), ['c', 'b', 'a']);
});

test('le fissate stanno in cima comunque sia ordinato l\'elenco', () => {
  const list = [
    session('zzz', { lastActivityAt: '2026-10-09T00:00:00.000Z' }),
    session('aaa', { lastActivityAt: '2026-01-01T00:00:00.000Z', favorite: true }),
  ];
  assert.deepEqual(sortSessions(list, 'activity').map((s) => s.name), ['aaa', 'zzz']);
  assert.deepEqual(sortSessions(list, 'name').map((s) => s.name), ['aaa', 'zzz']);
});

test('una conversazione senza date non finisce davanti a chi ha lavorato', () => {
  const list = [session('mai'), session('oggi', { lastActivityAt: '2026-10-09T00:00:00.000Z' })];
  assert.deepEqual(sortSessions(list, 'activity').map((s) => s.name), ['oggi', 'mai']);
});

test('i progetti: attività recente, nome, preferiti in cima', () => {
  const list = [
    project('beta', { lastActivityAt: '2026-10-01T00:00:00.000Z' }),
    project('alfa', { lastActivityAt: '2026-10-09T00:00:00.000Z' }),
    project('gamma', { lastActivityAt: null, createdAt: '2026-09-01T00:00:00.000Z', favorite: true }),
  ];
  assert.deepEqual(sortProjects(list, 'activity').map((p) => p.name), ['alfa', 'beta', 'gamma']);
  assert.deepEqual(sortProjects(list, 'name').map((p) => p.name), ['alfa', 'beta', 'gamma']);
  // «preferiti in cima» non è un ordine a sé: sopra i preferiti, sotto gli altri come sempre.
  assert.deepEqual(sortProjects(list, 'favorite').map((p) => p.name), ['gamma', 'alfa', 'beta']);
});

test('l\'ordine non tocca la lista di partenza', () => {
  const list = [session('b'), session('a')];
  sortSessions(list, 'name');
  assert.deepEqual(list.map((s) => s.name), ['b', 'a']);
});

test('senza sezioni non ci sono intestazioni inventate', () => {
  const groups = groupSessions([session('a'), session('b')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, null);
  assert.equal(groups[0].sessions.length, 2);
});

test('con le sezioni, il preferito resta in cima e l\'etichetta resta scritta', () => {
  const groups = groupSessions([
    session('uno', { label: 'lavoro' }),
    session('due', { label: 'lavoro' }),
    session('tre', { label: 'casa' }),
    session('quattro', { label: 'lavoro', favorite: true }),
    session('cinque'),
  ]);
  assert.deepEqual(groups.map((group) => group.title), ['fissate', 'casa', 'lavoro', 'senza sezione']);
  const pinned = groups.find((group) => group.title === 'fissate');
  assert.deepEqual(pinned.sessions.map((s) => s.name), ['quattro']);
  // …e non è sparito dalla sua sezione in doppia copia: la stella lo sposta, non lo duplica.
  const lavoro = groups.find((group) => group.title === 'lavoro');
  assert.deepEqual(lavoro.sessions.map((s) => s.name), ['due', 'uno']);
});
