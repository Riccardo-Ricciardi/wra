import assert from 'node:assert/strict';
import test from 'node:test';
import { baseName, buildProjects, pathKey } from '../src/core/workspace.mjs';

// I progetti come li vede l'interfaccia: l'unione di quelli che hanno conversazioni e quelli
// registrati a mano, con sopra i metadati organizzativi.

const session = (over = {}) => ({
  sessionId: 's1', name: 'chat 1', projectPath: 'C:\\work\\alfa',
  archived: false, createdAt: '2026-10-01T10:00:00.000Z', lastActivityAt: null, state: 'offline',
  ...over,
});

test('la stessa cartella scritta in due modi è un progetto solo', () => {
  assert.equal(pathKey('C:\\Work\\Alfa\\'), pathKey('c:/work/alfa'));
  assert.equal(pathKey('C:\\work\\.\\alfa'), pathKey('C:\\work\\alfa'));
  assert.equal(pathKey(''), '');
  assert.equal(baseName('C:\\work\\alfa\\'), 'alfa');
  assert.equal(baseName('C:\\work\\alfa'), 'alfa');
});

test('i conteggi separano quello che si vede da quello che c\'è', () => {
  const [project] = buildProjects({
    sessions: [
      session({ sessionId: 'a' }),
      session({ sessionId: 'b', archived: true }),
      session({ sessionId: 'c', state: 'ready' }),
    ],
  });
  assert.equal(project.count, 3, 'tutte le conversazioni della cartella');
  assert.equal(project.open, 2, 'le archiviate non contano come lavoro in corso');
  assert.equal(project.running, 1);
});

test('l\'ultima attività del progetto è quella della sua conversazione più recente', () => {
  const [project] = buildProjects({
    sessions: [
      session({ lastActivityAt: '2026-10-02T10:00:00.000Z' }),
      session({ lastActivityAt: '2026-10-09T10:00:00.000Z' }),
      session({ lastActivityAt: '2026-10-05T10:00:00.000Z' }),
    ],
  });
  assert.equal(project.lastActivityAt, '2026-10-09T10:00:00.000Z');
});

test('i metadati vincono sul nome della cartella, e il percorso vero resta quello', () => {
  const [project] = buildProjects({
    sessions: [session()],
    stored: [{ key: pathKey('C:\\work\\alfa'), path: 'C:\\work\\alfa', name: 'Cliente Alfa', favorite: true, hidden: true }],
  });
  assert.equal(project.name, 'Cliente Alfa');
  assert.equal(project.realName, 'alfa');
  assert.equal(project.favorite, true);
  assert.equal(project.hidden, true);
  assert.equal(project.registered, true);
  // Il percorso non è mai il nome: rinominare non deve poter spostare niente.
  assert.equal(project.path, 'C:\\work\\alfa');
});

test('un progetto registrato a mano compare anche senza conversazioni, e viceversa', () => {
  const projects = buildProjects({
    sessions: [session({ projectPath: 'C:\\work\\beta' })],
    stored: [{ path: 'C:\\work\\vuoto', name: 'Da iniziare', favorite: false, hidden: false }],
  });
  const names = projects.map((project) => project.name).sort();
  assert.deepEqual(names, ['Da iniziare', 'beta']);
  const empty = projects.find((project) => project.name === 'Da iniziare');
  assert.equal(empty.count, 0);
  assert.equal(empty.lastActivityAt, null);
  // La cartella con conversazioni ma senza metadati non è «registrata»: è solo conosciuta.
  assert.equal(projects.find((project) => project.name === 'beta').registered, false);
});

test('una conversazione senza progetto non inventa un progetto vuoto', () => {
  assert.deepEqual(buildProjects({ sessions: [session({ projectPath: '' })] }), []);
});

test('l\'automatico del progetto arriva all\'interfaccia, e nasce spento', () => {
  const [plain] = buildProjects({ sessions: [session()] });
  assert.equal(plain.autoApprove, false, 'una cartella senza metadati non ha niente acceso');

  const [on] = buildProjects({ stored: [{ path: 'C:\work\alfa', autoApprove: true }] });
  assert.equal(on.autoApprove, true, 'l\'interruttore del progetto si vede da fuori');

  const [off] = buildProjects({ stored: [{ path: 'C:\work\alfa', autoApprove: 'si' }] });
  assert.equal(off.autoApprove, false, 'solo il vero è acceso');
});
