// Le copie di sicurezza e il ripristino. Il caso che conta più di tutti è l'ultimo: **un
// ripristino non deve poter sovrascrivere dati che non è riuscito a copiare**. È la lezione
// dell'incidente del 02/11 applicata alla funzione più pericolosa del programma.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBackupStore, stateFiles } from '../src/host/backup-store.mjs';

const sessions = (names) => JSON.stringify({
  version: 1,
  sessions: names.map((name, at) => ({ sessionId: `id-${at}-${name}`, name, projectPath: 'C:\\progetti\\uno' })),
}, null, 2);

function makeConfig(dir) {
  return {
    home: dir,
    stateFile: path.join(dir, 'sessions.json'),
    projectsFile: path.join(dir, 'projects.json'),
    turnJournalFile: path.join(dir, 'turns.json'),
    accessFile: path.join(dir, 'access.json'),
  };
}

function world(names = ['alfa', 'beta', 'gamma']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-backup-'));
  const config = makeConfig(dir);
  fs.writeFileSync(config.stateFile, sessions(names));
  fs.writeFileSync(`${config.stateFile}.bak`, sessions(names.slice(0, 1)));
  fs.writeFileSync(config.projectsFile, JSON.stringify({ version: 1, projects: [{ path: 'C:\\progetti\\uno', name: 'Uno' }] }));
  fs.writeFileSync(config.accessFile, JSON.stringify({ tailscale: { origin: 'https://x.ts.net' } }));
  return { dir, config, store: createBackupStore({ config }) };
}

test('una copia contiene il registro, i progetti e la scelta dell\'accesso — e non il token', () => {
  const { dir, config, store } = world();
  fs.writeFileSync(path.join(dir, 'token'), 'segreto');
  const { folder, manifest } = store.create();
  const names = manifest.files.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['access.json', 'projects.json', 'sessions.json', 'sessions.json.bak']);
  assert.equal(manifest.chats, 3);
  assert.equal(manifest.readable, true);
  assert.match(manifest.note, /transcript/);
  assert.ok(!fs.existsSync(path.join(folder, 'token')), 'il token non si copia: è un segreto');
  assert.ok(!manifest.files.some((entry) => entry.name.includes('token')));
});

test('l\'impronta dice se la copia è ancora quella', () => {
  const { store } = world();
  const { folder } = store.create();
  assert.equal(store.verify(folder).ok, true);
  fs.writeFileSync(path.join(folder, 'sessions.json'), sessions(['manomesso']));
  const after = store.verify(folder);
  assert.equal(after.ok, false);
  assert.deepEqual(after.bad, ['sessions.json']);
});

test('una cartella senza manifesto non è una copia', () => {
  const { store } = world();
  const empty = path.join(store.folder, '2026-01-01T00-00-00');
  fs.mkdirSync(empty, { recursive: true });
  assert.equal(store.verify(empty).missing, true);
  assert.equal(store.list().length, 0, 'e non compare nell\'elenco');
  assert.match(store.plan(empty).reason, /MANIFEST/);
});

test('l\'anteprima dice quali conversazioni tornano e quali escono, per nome', () => {
  const { config, store } = world(['alfa', 'beta', 'gamma']);
  const { folder } = store.create();
  // Il registro cambia: via «gamma», dentro «delta».
  fs.writeFileSync(config.stateFile, sessions(['alfa', 'beta', 'delta']));
  const plan = store.plan(folder);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.counts, { now: 3, after: 3, added: 1, removed: 1 });
  assert.deepEqual(plan.added, ['gamma']);
  assert.deepEqual(plan.removed, ['delta']);
  assert.match(plan.transcripts, /not touched/);
  assert.ok(plan.safety, 'prima di sovrascrivere si mette da parte quello che c\'è');
});

test('il ripristino mette da parte lo stato attuale, e la copia di sicurezza è verificabile', () => {
  const { config, store } = world(['alfa', 'beta', 'gamma']);
  const { folder } = store.create();
  fs.writeFileSync(config.stateFile, sessions(['solo-questa']));

  const result = store.restore(folder);
  assert.equal(result.ok, true);
  assert.equal(result.chats, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(config.stateFile, 'utf8')).sessions.length, 3);
  assert.ok(result.safety, 'lo stato di prima è da qualche parte');
  assert.equal(store.verify(result.safety).ok, true, 'e quella copia si può verificare');
  assert.match(fs.readFileSync(path.join(result.safety, 'sessions.json'), 'utf8'), /solo-questa/);
});

test('una copia non integra non si ripristina', () => {
  const { config, store } = world();
  const { folder } = store.create();
  fs.appendFileSync(path.join(folder, 'sessions.json'), 'modificato dopo la copia');
  const before = fs.readFileSync(config.stateFile, 'utf8');
  const result = store.restore(folder);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not intact/);
  assert.equal(fs.readFileSync(config.stateFile, 'utf8'), before, 'e il registro non è stato toccato');
});

test('se la copia di sicurezza non si può fare, lo stato si mette da parte invece di sparire', () => {
  const { dir, config, store } = world();
  const { folder } = store.create();
  // La cartella delle copie è un file: crearne una lì dentro fallisce. Allora il registro attuale
  // si **sposta** (spostare non richiede di aprirlo) e resta al suo posto sotto un altro nome.
  const blocked = path.join(dir, 'bloccato');
  const broken = createBackupStore({
    config: {
      ...config,
      stateFile: path.join(blocked, 'sessions.json'),
      projectsFile: path.join(blocked, 'projects.json'),
      turnJournalFile: path.join(blocked, 'turns.json'),
      accessFile: path.join(blocked, 'access.json'),
    },
  });
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, 'sessions.json'), sessions(['intoccabile']));
  fs.writeFileSync(path.join(blocked, 'backups'), 'sono un file, non una cartella');

  const result = broken.restore(folder);
  assert.equal(result.ok, true);
  assert.equal(result.safety, null, 'nessuna copia: la cartella non si poteva usare');
  assert.equal(result.moved.length, 1, 'il registro di prima è stato messo da parte');
  assert.match(fs.readFileSync(result.moved[0], 'utf8'), /intoccabile/, 'e non è andato perso');
});

// Il caso che il 02/11 ha insegnato a temere: un registro che non si legge **e** non si sposta.
// Lì non c'è nessuna rete possibile, e la sola risposta onesta è non toccare niente.
test('un registro illeggibile e non spostabile ferma il ripristino', (t) => {
  if (process.platform !== 'win32') {
    return t.skip("l'ACL che rende un file illeggibile e non spostabile è di Windows");
  }
  const { dir, config, store } = world();
  const { folder } = store.create();
  const locked = path.join(dir, 'bloccato', 'sessions.json');
  fs.mkdirSync(path.join(dir, 'bloccato'), { recursive: true });
  fs.writeFileSync(locked, sessions(['intoccabile']));
  fs.writeFileSync(path.join(dir, 'bloccato', 'backups'), 'sono un file, non una cartella');
  execFileSync('icacls', [locked, '/inheritance:r']);
  assert.throws(() => fs.readFileSync(locked), { code: 'EPERM' }, 'la premessa del test non regge: il file è leggibile');

  try {
    const broken = createBackupStore({ config: { ...config, stateFile: locked } });
    const result = broken.restore(folder);
    assert.equal(result.ok, false);
    assert.match(result.reason, /restoring nothing/);
    assert.match(result.reason, /icacls/, 'e dice come si sistema, perché è quasi sempre quello');
    assert.equal(fs.existsSync(locked), true, 'il registro è ancora lì');
  } finally {
    execFileSync('icacls', [locked, '/reset']);
  }
});

test('un file che non conosciamo in una copia non viene ripristinato a caso', () => {
  const { config, store } = world();
  const { folder } = store.create();
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'MANIFEST.json'), 'utf8'));
  fs.writeFileSync(path.join(folder, 'strano.json'), '{}');
  manifest.files.push({ name: 'strano.json', bytes: 2, sha256: crypto.createHash('sha256').update('{}').digest('hex') });
  fs.writeFileSync(path.join(folder, 'MANIFEST.json'), JSON.stringify(manifest));

  const result = store.restore(folder);
  assert.equal(result.ok, true);
  assert.ok(!result.restored.includes('strano.json'));
  assert.ok(!fs.existsSync(path.join(config.home, 'strano.json')));
  // E `stateFiles` non nomina mai niente fuori dallo stato: è la lista chiusa dei file che si
  // possono scrivere, e vale come confine.
  assert.ok(stateFiles(config).every((entry) => path.resolve(entry.file).startsWith(path.resolve(config.home))));
});
