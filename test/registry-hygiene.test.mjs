import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SEGNI_SOLO_DEI_TEST, splitProjects, testProjectKeys, verdictOf } from '../src/web/core/registry-hygiene.mjs';

// Il registro si è riempito di voci scritte dai test. Questo test tiene ferma la regola con cui le
// si riconosce — e soprattutto tiene ferma la regola con cui **non** si riconoscono: il nome da
// solo non è una prova, e una cartella vera in una cartella temporanea non si tocca.

const temp = (nome) => path.join(process.env.TEMP ?? '/tmp', nome);

test('una cartella in %TEMP% con un nome di prova e nessuna conversazione è di prova', () => {
  const v = verdictOf({ path: temp('cc-remote-e2e-ab12cd'), key: temp('cc-remote-e2e-ab12cd') }, { sessions: 0 });
  assert.equal(v.test, true);
  assert.equal(v.weak, false);
  assert.ok(v.signals.length >= 2, 'servono almeno due prove indipendenti');
  assert.ok(v.signals.some((s) => s.id === 'test-name'));
});

test('**il nome da solo non basta**: una cartella di prova con conversazioni dentro non si tocca', () => {
  // Il caso che conta: se qualcuno avesse davvero una cartella chiamata così e ci lavorasse, le sue
  // conversazioni sono lì. Il nome è una prova, non un verdetto.
  const v = verdictOf({ path: temp('cc-remote-e2e-ab12cd') }, { sessions: 3 });
  assert.equal(v.test, false, 'con conversazioni dentro non è «sicuramente» di prova');
  assert.equal(v.weak, true);
});

test('una cartella vera in una cartella temporanea non è di prova', () => {
  // `%TEMP%\il-mio-progetto` è un progetto come un altro: sta in Temp perché lì l'ha messo chi
  // lavora. Senza il segno che viene dal codice, non c'è verdetto.
  const v = verdictOf({ path: temp('il-mio-progetto') }, { sessions: 0 });
  assert.equal(v.test, false);
  assert.equal(v.weak, true);
  assert.match(v.signals.map((s) => s.detail).join(' '), /temporanea/);
});

test('un progetto normale non ha nessuna prova contro di sé', () => {
  const v = verdictOf({ path: 'C:\\Users\\example\\Desktop\\Projects\\cc-remote' }, { sessions: 12 });
  assert.deepEqual(v, { test: false, weak: false, signals: [] });
});

test('un progetto appena aggiunto, senza conversazioni, non è di prova', () => {
  const v = verdictOf({ path: 'C:\\Users\\example\\Desktop\\Projects\\nuovo' }, { sessions: 0 });
  assert.equal(v.test, false);
  assert.equal(v.weak, true, 'è solo «da guardare», non da cancellare');
});

// ── I falsi positivi: i casi in cui la regola **non deve** scattare ─────────────────────────────
// Sono quelli che contano davvero. Un filtro che sbaglia per eccesso cancella il lavoro di
// qualcuno: questi quattro casi esistono perché quella è la sola parte di questo modulo che
// dispiace fare due volte.

test('un progetto vero che si chiama come una cartella di prova non è di prova', () => {
  // Non basta il nome: `progetto-auto-2` può benissimo essere il nome che qualcuno ha dato a una
  // cartella sua, sul Desktop, dove tiene il lavoro. Il segno **c'è** — è quello del nome, non
  // quello della cartella temporanea — e una prova sola non fa un verdetto.
  const v = verdictOf({ path: 'C:\\Users\\example\\Desktop\\progetto-auto-2' }, { sessions: 1 });
  assert.equal(v.test, false, 'con una conversazione dentro non si tocca');
  assert.equal(v.weak, true);
  assert.deepEqual(v.signals.map((s) => s.id), ['test-name'], 'manca la prova della cartella temporanea');
});

test('una conversazione conta anche quando la nomina per percorso e non per chiave', () => {
  // Il registro non è uniforme: una voce può portare `projectKey`, un\'altra solo `projectPath`. Se
  // il conteggio guardasse una sola delle due, un progetto **vivo** risulterebbe vuoto — e sarebbe
  // un falso positivo per costruzione, proprio sulla cosa che si vuole proteggere.
  const percorso = temp('cc-remote-e2e-vivo');
  const { test: prova, sospetti } = splitProjects([{ key: 'k', path: percorso }], [{ projectPath: percorso }]);
  assert.deepEqual(prova, [], 'ha una conversazione: non si dichiara di prova');
  assert.equal(sospetti[0]?.sessions, 1, 'la conversazione non è stata contata: il progetto sembra vuoto');
});

test('una cartella temporanea con del lavoro dentro non entra mai fra quelle da cancellare', () => {
  // «Da guardare» è un'altra cosa da «di prova»: la prima si mostra, la seconda si propone di
  // toglierla. Una cartella in %TEMP% con una conversazione dentro resta nella prima casella — e
  // l'unico segno che ha è quello della cartella, non quello del nome.
  const percorso = temp('il-mio-progetto');
  const { test: prova, sospetti } = splitProjects([{ key: 'k', path: percorso }], [{ projectKey: 'k' }]);
  assert.deepEqual(prova, []);
  assert.equal(sospetti.length, 1);
  assert.deepEqual(sospetti[0].signals.map((s) => s.id), ['temp']);
});

test('i tre elenchi: di prova, da guardare, veri — e ogni voce nell\'elenco giusto', () => {
  const projects = [
    { key: 'k1', path: temp('cc-remote-e2e-1') },
    { key: 'k2', path: temp('progetto-auto-2') },
    { key: 'k3', path: temp('senza-conversazioni') },
    { key: 'k4', path: 'C:\\lavoro\\vero' },
  ];
  const sessions = [{ projectKey: 'k4' }, { projectKey: 'k4' }, { projectKey: 'k2' }];

  const { test: prova, sospetti, veri } = splitProjects(projects, sessions);
  assert.deepEqual(prova.map((v) => v.project.key), ['k1'], 'k2 ha una conversazione: non è «sicuramente»');
  assert.deepEqual(sospetti.map((v) => v.project.key).sort(), ['k2', 'k3']);
  assert.deepEqual(veri.map((v) => v.project.key), ['k4']);
  assert.equal(prova[0].sessions, 0);
});

test('le chiavi da nascondere sono le stesse per la testata e per la pagina', () => {
  // Il numero accanto a «Progetti» e le righe della pagina chiedono la regola allo stesso posto:
  // erano due conti diversi, e la testata diceva 29 mentre la pagina ne mostrava 21.
  const projects = [
    { key: 'finta', path: temp('cc-remote-e2e-1') },
    { key: 'vera', path: 'C:\\lavoro\\vero' },
  ];
  const sessions = [{ projectKey: 'vera' }];
  assert.deepEqual([...testProjectKeys(projects, sessions)], ['finta']);
  assert.deepEqual([...testProjectKeys(projects, sessions, { hide: false })], [], 'se si mostrano, non si nasconde nessuna');
});

test('i segni dei test compaiono nel file di test, e **non** nel codice di produzione', () => {
  // È il legame che rende vera la regola: se uno di questi nomi comparisse in `src/`, il segno non
  // sarebbe più una prova — e questo test lo dice invece di lasciarlo scoprire a chi cancella.
  const radice = path.resolve(import.meta.dirname, '..');
  // Il modulo che **dichiara** i segni è l'unico posto dove possono stare: si esclude lui, e
  // nient'altro. Un `if` più largo renderebbe il controllo una formalità.
  const dichiarante = path.join('core', 'registry-hygiene.mjs');
  const leggi = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((voce) => {
    const pieno = path.join(dir, voce.name);
    if (voce.isDirectory()) return voce.name === 'node_modules' ? [] : leggi(pieno);
    if (!voce.name.endsWith('.mjs') && !voce.name.endsWith('.js')) return [];
    return pieno.endsWith(dichiarante) ? [] : [pieno];
  });

  const sorgenti = leggi(path.join(radice, 'src')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const test = fs.readFileSync(path.join(radice, 'test', 'e2e.stub.test.mjs'), 'utf8');

  for (const segno of SEGNI_SOLO_DEI_TEST) {
    assert.ok(test.includes(segno), `«${segno}» non compare più nel file di test: il segno è scaduto`);
    assert.ok(!sorgenti.includes(segno), `«${segno}» compare in src/: non è più una prova di test`);
  }
});
