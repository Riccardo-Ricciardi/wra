import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectStore } from '../src/host/project-store.mjs';

// I metadati organizzativi dei progetti. Il punto di questi test non è il salvataggio: è che
// niente **qui** possa toccare una cartella o una conversazione, e che un file rotto non si
// porti via i nomi che qualcuno ha scelto.

function setup(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cc-remote-proj-${name}-`));
  return { root, file: path.join(root, 'projects.json') };
}

test('rinominare salva un\'etichetta, non un percorso nuovo', () => {
  const { file } = setup('rename');
  const store = createProjectStore({ file });
  store.load();
  const saved = store.set('C:\\work\\alfa', { name: 'Cliente Alfa' });
  assert.equal(saved.name, 'Cliente Alfa');
  assert.equal(saved.path, 'C:\\work\\alfa', 'il percorso resta quello vero');
  assert.equal(saved.key, 'c:\\work\\alfa');
});

test('stella e nome si cambiano uno per volta, senza cancellare l\'altro', () => {
  const { file } = setup('fields');
  const store = createProjectStore({ file });
  store.load();
  store.set('C:\\work\\alfa', { name: 'Alfa' });
  store.set('C:\\work\\alfa', { favorite: true });
  const after = store.get('C:\\work\\alfa');
  assert.equal(after.name, 'Alfa');
  assert.equal(after.favorite, true);
  store.set('C:\\work\\alfa', { hidden: true });
  assert.equal(store.get('C:\\work\\alfa').name, 'Alfa');
  assert.equal(store.get('C:\\work\\alfa').favorite, true);
  assert.equal(store.get('C:\\work\\alfa').hidden, true);
});

test('un nome vuoto torna al nome della cartella invece di restare scritto', () => {
  const { file } = setup('empty');
  const store = createProjectStore({ file });
  store.load();
  store.set('C:\\work\\alfa', { name: 'Alfa' });
  store.set('C:\\work\\alfa', { name: '   ' });
  assert.equal(store.get('C:\\work\\alfa').name, null);
});

test('la stessa cartella scritta in due modi è una voce sola', () => {
  const { file } = setup('keys');
  const store = createProjectStore({ file });
  store.load();
  store.set('C:\\Work\\Alfa\\', { favorite: true });
  store.set('c:/work/alfa', { name: 'Alfa' });
  assert.equal(store.all().length, 1);
  assert.equal(store.get('C:\\work\\ALFA').favorite, true);
});

test('sopravvive al riavvio: si rilegge quello che si è scritto', () => {
  const { file } = setup('restart');
  const first = createProjectStore({ file });
  first.load();
  first.set('C:\\work\\alfa', { name: 'Alfa', favorite: true, hidden: true });

  const second = createProjectStore({ file });
  second.load();
  assert.deepEqual(
    { name: second.get('C:\\work\\alfa').name, favorite: second.get('C:\\work\\alfa').favorite, hidden: second.get('C:\\work\\alfa').hidden },
    { name: 'Alfa', favorite: true, hidden: true },
  );
  assert.ok(!fs.existsSync(`${file}.${process.pid}.tmp`), 'nessun temporaneo lasciato indietro');
});

test('un file rotto si recupera dal backup, e l\'originale si mette da parte', () => {
  const { file } = setup('corrupt');
  const store = createProjectStore({ file });
  store.load();
  store.set('C:\\work\\alfa', { name: 'Alfa' });
  store.set('C:\\work\\beta', { name: 'Beta' }); // questo giro scrive il .bak con dentro Alfa
  fs.writeFileSync(file, '{ questo non è JSON');

  const recovered = createProjectStore({ file });
  recovered.load();
  assert.equal(recovered.get('C:\\work\\alfa').name, 'Alfa');
  assert.equal(recovered.get('C:\\work\\beta'), null, 'il backup è la versione precedente, non l\'ultima');
  const damaged = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('corrupt-'));
  assert.equal(damaged.length, 1, 'l\'originale rotto non si cancella, si mette da parte');
});

test('con primario e backup rotti si rifiuta di partire invece di azzerare', () => {
  const { file } = setup('both-broken');
  const store = createProjectStore({ file });
  store.load();
  store.set('C:\\work\\alfa', { name: 'Alfa' });
  store.set('C:\\work\\beta', { name: 'Beta' });
  fs.writeFileSync(file, 'non-json');
  fs.writeFileSync(`${file}.bak`, 'nemmeno-questo');

  const broken = createProjectStore({ file });
  assert.throws(() => broken.load(), /unreadable/);
});

test('dimenticare toglie i metadati e non tocca nient\'altro', () => {
  const { file } = setup('remove');
  const store = createProjectStore({ file });
  store.load();
  store.set('C:\\work\\alfa', { name: 'Alfa' });
  store.set('C:\\work\\beta', { name: 'Beta' });
  assert.equal(store.remove('C:\\work\\ALFA\\'), true);
  assert.equal(store.get('C:\\work\\alfa'), null);
  assert.equal(store.all().length, 1);
  assert.equal(store.remove('C:\\work\\gamma'), false, 'una cartella mai vista non è un errore');
});
