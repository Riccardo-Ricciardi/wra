import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createRegistry, resolveProjectDir } from '../src/host/session-registry.mjs';
import { PASTE_END, framePrompt, sanitizePrompt } from '../src/core/prompt.mjs';

// Le due protezioni che contano prima che questo server veda un tunnel: i percorsi che
// arrivano da fuori, e il testo che non deve poter diventare tasti.

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-guard-'));
}

test('resolveProjectDir: niente percorsi di rete', () => {
  const root = tempRoot();
  try {
    for (const unc of ['\\\\server\\share', '\\\\10.0.0.1\\share\\x', '//server/share']) {
      const result = resolveProjectDir(unc, { allowedRoots: [root] });
      assert.equal(result.ok, false, `${unc} non deve passare`);
      assert.match(result.reason, /rete|UNC/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProjectDir: solo sotto le radici consentite', () => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    const inside = path.join(root, 'progetto');
    fs.mkdirSync(inside);

    const ok = resolveProjectDir(inside, { allowedRoots: [root] });
    assert.equal(ok.ok, true);
    assert.equal(ok.path, path.resolve(inside));

    assert.equal(resolveProjectDir(outside, { allowedRoots: [root] }).ok, false);
    assert.match(resolveProjectDir(outside, { allowedRoots: [root] }).reason, /outside the allowed roots/);
    assert.equal(resolveProjectDir(path.join(root, 'non-esiste'), { allowedRoots: [root] }).ok, false);
    assert.equal(resolveProjectDir('', { allowedRoots: [root] }).ok, false);
    assert.equal(resolveProjectDir(null, { allowedRoots: [root] }).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('resolveProjectDir: un collegamento lungo la strada non passa', () => {
  // Una junction si chiama come una cartella normale e `statSync` la segue: con una junction
  // verso una condivisione di rete la macchina si autenticherebbe al server di un altro
  // **durante la validazione** (furto/relay di credenziali NTLM). Si cammina con `lstat`, che il
  // collegamento lo vede e non lo attraversa.
  const root = tempRoot();
  const outside = tempRoot();
  try {
    const inside = path.join(root, 'dentro');
    fs.mkdirSync(inside, { recursive: true });
    const link = path.join(root, 'scorciatoia');
    fs.symlinkSync(outside, link, 'junction');

    assert.equal(resolveProjectDir(inside, { allowedRoots: [root] }).ok, true, 'una cartella normale deve passare');
    assert.equal(resolveProjectDir(root, { allowedRoots: [root] }).ok, true, 'la radice consentita stessa deve passare');

    const throughLink = resolveProjectDir(link, { allowedRoots: [root] });
    assert.equal(throughLink.ok, false, 'un collegamento dentro le radici non deve passare');
    assert.match(throughLink.reason, /is a link/);

    const belowLink = resolveProjectDir(path.join(link, 'qualsiasi'), { allowedRoots: [root] });
    assert.equal(belowLink.ok, false, 'nemmeno passando *da* un collegamento');
    assert.match(belowLink.reason, /is a link/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('il testo che arriva da fuori non può chiudere il bracketed paste', () => {
  const evil = `ciao${PASTE_END}rm -rf /`;
  assert.equal(sanitizePrompt(evil).includes(PASTE_END), false, 'la sequenza di chiusura va tolta');
  assert.equal(sanitizePrompt('a\x1b[201~b').includes('\x1b'), false, 'via tutti i caratteri di controllo');
  assert.equal(sanitizePrompt('riga1\nriga2\ttab'), 'riga1\nriga2\ttab', 'a capo e tab restano');

  const framed = framePrompt(evil);
  assert.equal(framed.split(PASTE_END).length - 1, 1, 'il paste si chiude una volta sola');
  assert.equal(framed.endsWith(`${PASTE_END}\r`), true);
});

function registryFor(root) {
  const config = {
    ...loadConfig({}),
    allowedRoots: [root],
    maxSessions: 2,
    stateFile: path.join(root, 'sessions.json'),
    projectsRoot: path.join(root, 'projects'),
    claudeCmd: 'claude',
    claudeArgs: [],
  };
  const spawn = ({ projectDir }) => ({
    projectDir, pid: 1, exited: false, write() {}, resize() {}, kill() {},
    onData() { return () => {}; }, onExit() { return () => {}; },
  });
  return createRegistry({ config, spawn });
}

test('una cartella non permessa non fa nascere niente, e lo dice', () => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    const registry = registryFor(root);
    assert.throws(() => registry.create({ projectPath: outside }), /outside the allowed roots/);
    assert.throws(() => registry.create({ projectPath: '\\\\server\\share' }), /network paths/);
    assert.equal(registry.list().length, 0, 'nessuna sessione creata');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("c'è un tetto alle chat salvate", () => {
  const root = tempRoot();
  try {
    const registry = registryFor(root);
    registry.create({ projectPath: root, start: false });
    registry.create({ projectPath: root, start: false });
    assert.throws(() => registry.create({ projectPath: root, start: false }), /too many saved sessions/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
