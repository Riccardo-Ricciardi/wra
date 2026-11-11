// I due elenchi che non coincidono: il registro e i transcript.
//
// Le due metà della regola, e la seconda conta più della prima: quello che **non** si importa e
// quello che **non** si cancella. L'audit di M9 ha misurato i due casi sul registro vero — 13 voci
// senza transcript e 183 transcript senza voce — e la procedura esiste per non sbagliarli.
import assert from 'node:assert/strict';
import test from 'node:test';

import { capienza, choose, reconcile } from '../src/core/reconcile.mjs';

const quando = (minuti) => new Date(Date.UTC(2026, 10, 5, 12, minuti)).toISOString();

test('quello che è già nel registro non si importa due volte', () => {
  const sessions = [{ sessionId: 'a', transcript: 'a.jsonl' }];
  const found = [{ sessionId: 'a', modifiedAt: quando(0) }, { sessionId: 'b', modifiedAt: quando(1) }];
  const plan = reconcile({ sessions, found, exists: () => true });
  assert.deepEqual(plan.importabili.map((e) => e.sessionId), ['b']);
  assert.equal(plan.counts.registro, 1);
  assert.equal(plan.counts.trovati, 2);
});

test('lo stesso id in due cartelle è una conversazione sola: si tiene la più recente', () => {
  // Succede quando una cartella viene spostata e Claude Code ne ricostruisce lo slug. Importare
  // due volte la stessa conversazione è il modo di far credere che il lavoro sia stato fatto due
  // volte.
  const found = [
    { sessionId: 'x', transcript: 'vecchio/x.jsonl', modifiedAt: quando(0) },
    { sessionId: 'x', transcript: 'nuovo/x.jsonl', modifiedAt: quando(9) },
  ];
  const plan = reconcile({ found, exists: () => true });
  assert.deepEqual(plan.importabili.map((e) => e.transcript), ['nuovo/x.jsonl']);
  assert.equal(plan.counts.duplicati, 1);
  assert.equal(plan.duplicati[0].transcript, 'vecchio/x.jsonl');
  assert.equal(plan.duplicati[0].invece, 'nuovo/x.jsonl');
});

test('una conversazione che `--resume` non riprende si mostra, e non si importa', () => {
  const found = [
    { sessionId: 'buona', modifiedAt: quando(0), riprendibile: { ok: true } },
    { sessionId: 'morta', modifiedAt: quando(1), riprendibile: { ok: false, reason: 'la cartella non esiste più' } },
  ];
  const plan = reconcile({ found, exists: () => true });
  assert.deepEqual(plan.importabili.map((e) => e.sessionId), ['buona']);
  assert.deepEqual(plan.nonRiprendibili.map((e) => e.sessionId), ['morta']);
  assert.match(plan.nonRiprendibili[0].riprendibile.reason, /non esiste/);
});

test('una voce del registro senza più il suo file è un difetto, e si dice', () => {
  const sessions = [
    { sessionId: 'viva', name: 'viva', transcript: 'viva.jsonl' },
    { sessionId: 'sparita', name: 'School agent audit', transcript: 'sparita.jsonl', projectPath: 'C:\\lavoro', imported: true },
  ];
  const plan = reconcile({ sessions, found: [{ sessionId: 'viva', modifiedAt: quando(0) }], exists: (file) => file !== 'sparita.jsonl' });
  assert.deepEqual(plan.senzaTranscript.map((s) => s.sessionId), ['sparita']);
  assert.equal(plan.counts.senzaTranscript, 1);
});

test('una conversazione mai usata non è una conversazione senza transcript', () => {
  // Il registro il percorso del transcript lo **calcola** sempre, quindi «il file non c'è» da solo
  // non vuol dire niente: una conversazione creata e mai aperta non ha ancora niente da scrivere.
  // Il banco ne è pieno — 518 su 520 — e dirle tutte come difetti sarebbe un allarme che non
  // significa niente. Quello che rende la mancanza un difetto è che la conversazione sia stata
  // **usata**: importata da un transcript che c'era, o aperta almeno una volta.
  const sessions = [
    { sessionId: 'nuova', name: 'nuova', transcript: 'nuova.jsonl' },
    { sessionId: 'aperta', transcript: 'aperta.jsonl', lastActivityAt: quando(3) },
    { sessionId: 'orfana', transcript: 'orfana.jsonl', imported: true },
    { sessionId: 'senza-percorso', transcript: null },
  ];
  const plan = reconcile({ sessions, found: [], exists: () => false });
  assert.deepEqual(plan.senzaTranscript.map((s) => s.sessionId), ['aperta', 'orfana']);
  assert.deepEqual(plan.maiAperte.map((s) => s.sessionId), ['nuova', 'senza-percorso']);
});

test('si importa solo quello che il server ha appena trovato', () => {
  // Il client può chiedere quello che vuole: la lista buona è quella risultata dalla scansione.
  const plan = reconcile({
    sessions: [{ sessionId: 'gia', transcript: 'gia.jsonl' }],
    found: [
      { sessionId: 'gia', modifiedAt: quando(0) },
      { sessionId: 'buona', modifiedAt: quando(1) },
      { sessionId: 'morta', modifiedAt: quando(2), riprendibile: { ok: false, reason: 'no' } },
    ],
    exists: () => true,
  });
  const scelta = choose(plan, ['buona', 'morta', 'gia', 'inventata', 'buona']);
  assert.deepEqual(scelta.scelti.map((e) => e.sessionId), ['buona'], 'anche chiesta due volte, una sola volta');
  assert.deepEqual(scelta.rifiutati.sort(), ['gia', 'inventata', 'morta']);
});

test('un registro vuoto e un disco vuoto non sono un errore', () => {
  const plan = reconcile({});
  assert.deepEqual(plan.counts, {
    registro: 0, trovati: 0, importabili: 0, nonRiprendibili: 0, senzaTranscript: 0, maiAperte: 0, duplicati: 0,
  });
  assert.deepEqual(choose(plan, ['x']).rifiutati, ['x']);
});

test('l\'anteprima è ordinata dalla più recente, perché è quella che si cerca', () => {
  const found = [
    { sessionId: 'vecchia', modifiedAt: quando(0) },
    { sessionId: 'nuova', modifiedAt: quando(9) },
    { sessionId: 'mezzo', modifiedAt: quando(4) },
  ];
  const plan = reconcile({ found, exists: () => true });
  assert.deepEqual(plan.importabili.map((e) => e.sessionId), ['nuova', 'mezzo', 'vecchia']);
});

// ── quante ce ne stanno ───────────────────────────────────────────────────────────────────────
// Il difetto vero, misurato sul registro di questa macchina: 84 conversazioni dentro, il tetto a
// 256, e 212 transcript che l'interfaccia non mostra — 296, che non ci stanno. Senza questo conto
// l'importazione riempiva il registro fino al tetto e poi si fermava a metà.

test('la capienza dice quanti posti restano, e quanti ne mancano', () => {
  // I numeri veri del registro del 5/11/2026.
  assert.deepEqual(capienza({ inRegistro: 84, daImportare: 212, max: 256 }), { posti: 172, mancano: 40, ok: false });
  assert.deepEqual(capienza({ inRegistro: 84, daImportare: 172, max: 256 }), { posti: 172, mancano: 0, ok: true });
  assert.deepEqual(capienza({ inRegistro: 84, daImportare: 0, max: 256 }), { posti: 172, mancano: 0, ok: true });
});

test('un registro già pieno non fa numeri negativi', () => {
  assert.deepEqual(capienza({ inRegistro: 256, daImportare: 3, max: 256 }), { posti: 0, mancano: 3, ok: false });
  assert.deepEqual(capienza({ inRegistro: 300, daImportare: 1, max: 256 }), { posti: 0, mancano: 1, ok: false });
});
