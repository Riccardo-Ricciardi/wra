// Le impostazioni del pannello. `allowedRoots` è un confine di sicurezza: allargarlo vuol dire
// permettere a una conversazione di girare in una cartella che prima era fuori. Quindi si prova
// soprattutto **cosa viene rifiutato**.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applySettings, checkRoot, createSettingsStore, emptySettings } from '../src/host/settings-store.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'));

test('una radice consentita esiste, è una cartella, è assoluta e non è un collegamento', () => {
  const dir = temp();
  const real = path.join(dir, 'progetti');
  fs.mkdirSync(real);
  assert.deepEqual(checkRoot(real), { ok: true, path: real });
  assert.equal(checkRoot(path.join(dir, 'non-c\'è')).ok, false);
  assert.match(checkRoot(path.join(dir, 'non-c\'è')).reason, /does not exist/);
  assert.match(checkRoot(path.join(real, 'sessions.json')).reason ?? 'ok', /does not exist|folder/);
  fs.writeFileSync(path.join(dir, 'un-file'), 'x');
  assert.match(checkRoot(path.join(dir, 'un-file')).reason, /not a folder/);
  assert.match(checkRoot('progetti/relativo').reason, /absolute path/);
  assert.match(checkRoot('').reason, /empty path/);
  assert.match(checkRoot('\\\\server\\share').reason, /network paths/);
  assert.match(checkRoot('//server/share').reason, /network paths/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('un collegamento non può essere una radice: il confine non esisterebbe più', () => {
  const dir = temp();
  const vera = path.join(dir, 'vera');
  const link = path.join(dir, 'scorciatoia');
  fs.mkdirSync(vera);
  fs.symlinkSync(vera, link, 'junction');
  const checked = checkRoot(link);
  assert.equal(checked.ok, false);
  assert.match(checked.reason, /is a link/);
  // E lo dice anche quando il collegamento è rotto (che è il caso in cui `stat` fallisce).
  fs.rmSync(vera, { recursive: true, force: true });
  assert.equal(checkRoot(link).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Il caso che si vede solo camminando il percorso: la junction sta **in mezzo**, non in fondo.
// `C:\j\progetti` con `C:\j` che punta a una condivisione è una cartella normalissima — e
// accettarla come radice vorrebbe dire che ogni conversazione sotto di lei gira da un'altra parte.
test('una radice che passa da un collegamento in mezzo al percorso non entra', (t) => {
  if (process.platform !== 'win32') {
    return t.skip('la junction è di Windows');
  }
  const dir = temp();
  const vera = path.join(dir, 'vera');
  const ponte = path.join(dir, 'ponte');
  fs.mkdirSync(path.join(vera, 'progetti'), { recursive: true });
  fs.symlinkSync(vera, ponte, 'junction');

  const checked = checkRoot(path.join(ponte, 'progetti'));
  assert.equal(checked.ok, false);
  assert.match(checked.reason, /is a link/);
  assert.match(checked.reason, /ponte/, 'e dice **quale** pezzo è il collegamento');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('su una radice sospetta non si chiede nemmeno se esiste: `stat` non si chiama', (t) => {
  if (process.platform !== 'win32') {
    return t.skip('la junction è di Windows');
  }
  const dir = temp();
  const vera = path.join(dir, 'vera');
  fs.mkdirSync(path.join(vera, 'dentro'), { recursive: true });
  const ponte = path.join(dir, 'ponte');
  fs.symlinkSync(vera, ponte, 'junction');

  let statCalled = 0;
  const checked = checkRoot(path.join(ponte, 'dentro'), {
    stat: (target) => { statCalled += 1; return fs.statSync(target); },
    lstat: (target) => fs.lstatSync(target),
  });
  assert.equal(checked.ok, false);
  // È il punto: `stat` **attraversa** un collegamento, quindi su `\\attaccante\share` la macchina
  // si autenticherebbe al server di un altro — furto o relay di credenziali NTLM — mentre sta
  // solo controllando un percorso. Prima si cammina con `lstat`, e `stat` non arriva mai.
  assert.equal(statCalled, 0, 'la validazione ha attraversato il collegamento');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('una radice scritta a mano nel file si ricontrolla prima di usarla', () => {
  const dir = temp();
  const buona = path.join(dir, 'buona');
  fs.mkdirSync(buona);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    allowedRoots: [buona, path.join(dir, 'sparita'), '\\\\server\\share'],
  }));
  const loaded = createSettingsStore({ file }).load();
  assert.deepEqual(loaded.allowedRoots, [buona], 'un confine che si fida del file non è un confine');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('un percorso sbagliato non entra: si rifiuta tutto, non metà', () => {
  const dir = temp();
  const buona = path.join(dir, 'buona');
  fs.mkdirSync(buona);
  const store = createSettingsStore({ file: path.join(dir, 'settings.json') });

  const rifiutato = store.set({ defaultProject: buona, allowedRoots: [buona, path.join(dir, 'inventata')] });
  assert.equal(rifiutato.ok, false);
  assert.match(rifiutato.reason, /inventata/);
  assert.deepEqual(store.get(), emptySettings(), 'e niente è stato scritto');

  const accettato = store.set({ defaultProject: buona, allowedRoots: [buona, buona] });
  assert.equal(accettato.ok, true);
  assert.deepEqual(accettato.settings.allowedRoots, [buona], 'i doppioni si tolgono');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).defaultProject, buona);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('le impostazioni si rileggono da disco, e un file rotto non ferma niente', () => {
  const dir = temp();
  const file = path.join(dir, 'settings.json');
  const buona = path.join(dir, 'buona');
  fs.mkdirSync(buona);
  const store = createSettingsStore({ file });
  store.set({ defaultProject: buona });
  assert.equal(createSettingsStore({ file }).load().defaultProject, buona);

  fs.writeFileSync(file, 'non è json');
  assert.deepEqual(createSettingsStore({ file }).load(), emptySettings());
  fs.rmSync(dir, { recursive: true, force: true });
});

test('l\'ambiente vince sempre, e le radici si aggiungono a quella di partenza', () => {
  const dir = temp();
  const extra = path.join(dir, 'extra');
  fs.mkdirSync(extra);
  // L'ambiente di chi lancia le prove può avere queste variabili: si mettono via e si rimettono,
  // altrimenti il test misura la macchina invece del codice.
  const keep = { a: process.env.CR_DEFAULT_PROJECT, b: process.env.CR_PROJECT_DIR, c: process.env.CR_ALLOWED_ROOTS };
  delete process.env.CR_DEFAULT_PROJECT;
  delete process.env.CR_PROJECT_DIR;
  delete process.env.CR_ALLOWED_ROOTS;
  try {
    const config = { home: dir, defaultProject: 'C:\\di-partenza', allowedRoots: [dir] };
    const applied = applySettings(config, { defaultProject: extra, allowedRoots: [extra] });
    assert.deepEqual(applied.sort(), ['allowedRoots', 'defaultProject']);
    assert.equal(config.defaultProject, extra);
    assert.deepEqual(config.allowedRoots, [dir, extra], 'la radice di partenza resta utilizzabile');

    const forced = { home: dir, defaultProject: 'C:\\fissata', allowedRoots: [dir] };
    process.env.CR_DEFAULT_PROJECT = 'C:\\da-ambiente';
    process.env.CR_ALLOWED_ROOTS = 'C:\\solo-questa';
    applySettings(forced, { defaultProject: extra, allowedRoots: [extra] });
    assert.equal(forced.defaultProject, 'C:\\fissata', 'una variabile d\'ambiente non si scavalca');
    assert.deepEqual(forced.allowedRoots, [dir], 'e nemmeno le radici');
  } finally {
    delete process.env.CR_DEFAULT_PROJECT;
    delete process.env.CR_ALLOWED_ROOTS;
    if (keep.a) process.env.CR_DEFAULT_PROJECT = keep.a;
    if (keep.b) process.env.CR_PROJECT_DIR = keep.b;
    if (keep.c) process.env.CR_ALLOWED_ROOTS = keep.c;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
