import assert from 'node:assert/strict';
import test from 'node:test';
import { CLEAR_LINE, PASTE_END, PASTE_START, framePrompt, normalizePrompt, promptMatches } from '../src/core/prompt.mjs';

test('framePrompt svuota la riga, incapsula nel bracketed paste e sottomette', () => {
  const framed = framePrompt('riga uno\nriga due');
  assert.equal(framed, `${CLEAR_LINE}${PASTE_START}riga uno\nriga due${PASTE_END}\r`);
  assert.ok(framed.startsWith('\x15'));
  assert.ok(framed.includes('\x1b[200~'));
  assert.ok(framed.includes('\x1b[201~'));
  assert.ok(framed.endsWith('\r'));
});

test('normalizePrompt collassa gli spazi', () => {
  assert.equal(normalizePrompt('  ciao   mondo \n'), 'ciao mondo');
});

test('promptMatches accetta il testo identico a meno di spazi', () => {
  assert.equal(promptMatches('ciao   mondo', 'ciao mondo'), true);
  assert.equal(promptMatches('  ciao mondo  ', 'ciao mondo'), true);
});

test('promptMatches accetta il nostro testo in coda a un residuo del composer', () => {
  assert.equal(promptMatches('zRispondi esattamente con: LIVE-1a2b', 'Rispondi esattamente con: LIVE-1a2b'), true);
  assert.equal(promptMatches('residuo lungo e strano ciao', 'ciao'), true);
  assert.equal(promptMatches('ciao e poi altro', 'ciao'), false, 'non basta che il nostro sia un prefisso');
});

test('promptMatches trova il testo dentro il wrapper <pasted_content> della TUI', () => {
  const sent = 'Riga uno.\nRiga due.\nRispondi solo con: MULTI-OK';
  const scritto = `\n\n<pasted_content id="f39a">\n${sent}\n</pasted_content id="f39a">\n`;
  assert.equal(promptMatches(scritto, sent), true);
  // illo tempore: il confronto esatto falliva e il turno risultava fallito pur riuscito
  assert.equal(normalizePrompt(scritto), normalizePrompt(sent));
});

test('promptMatches rifiuta testi diversi', () => {
  assert.equal(promptMatches('altro testo', 'ciao mondo'), false);
  assert.equal(promptMatches('', 'ciao'), false);
  assert.equal(promptMatches('ciao mondo in piu', 'ciao mondo'), false);
});
