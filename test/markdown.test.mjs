import assert from 'node:assert/strict';
import test from 'node:test';
import { inlineSpans, parseMarkdown } from '../src/web/core/markdown.mjs';

// Quello che scrive l'agente è testo, non markup: il parser produce blocchi e pezzi di riga, e
// chi disegna costruisce nodi del DOM uno per uno. Qui si prova che il testo resti testo.

test('i paragrafi si separano sulle righe vuote', () => {
  const blocks = parseMarkdown('primo rigo\n\nsecondo');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'paragraph']);
  assert.equal(blocks[0].spans[0].text, 'primo rigo');
});

test('un blocco di codice si prende tutto, lingue comprese', () => {
  const blocks = parseMarkdown('ecco:\n\n```js\nconst a = 1;\n```\n\nfine');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'code', 'paragraph']);
  assert.equal(blocks[1].lang, 'js');
  assert.equal(blocks[1].text, 'const a = 1;');
});

test('dentro il codice il markdown NON si interpreta', () => {
  const [block] = parseMarkdown('```\n**non grassetto** [non](link)\n```');
  assert.equal(block.type, 'code');
  assert.equal(block.text, '**non grassetto** [non](link)');
});

test('un blocco di codice senza chiusura non mangia il resto del messaggio', () => {
  const blocks = parseMarkdown('```\nancora aperto');
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].text, 'ancora aperto');
});

test('titoli, elenchi, citazioni e righe', () => {
  const blocks = parseMarkdown('# Titolo\n\n## Sotto\n\n- uno\n- due\n\n1. primo\n2. secondo\n\n> citato\n\n---');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'heading', 'list', 'list', 'quote', 'rule']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].level, 2);
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[2].items[0][0].text, 'uno');
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[3].items[1][0].text, 'secondo');
  assert.equal(blocks[4].spans[0].text, 'citato');
});

test('grassetto, corsivo, codice in linea', () => {
  const spans = inlineSpans('un **forte**, un *debole* e `codice`');
  assert.deepEqual(spans.map((s) => s.type), ['text', 'strong', 'text', 'em', 'text', 'code']);
  assert.equal(spans[1].text, 'forte');
  assert.equal(spans[5].text, 'codice');
});

test('un link normale si riconosce', () => {
  const spans = inlineSpans('vedi [la documentazione](https://code.claude.com/docs)');
  const link = spans.find((s) => s.type === 'link');
  assert.equal(link.text, 'la documentazione');
  assert.equal(link.href, 'https://code.claude.com/docs');
});

test('un link pericoloso resta testo, non diventa cliccabile', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:x']) {
    const spans = inlineSpans(`[clicca](${bad})`);
    assert.equal(spans.some((s) => s.type === 'link'), false, `non doveva passare: ${bad}`);
    assert.equal(spans.map((s) => s.text).join(''), `[clicca](${bad})`, 'e si vede per quello che è');
  }
});

test('un markdown storto non esplode: esce testo leggibile', () => {
  const blocks = parseMarkdown('**aperto\n\n[link](senza-chiusura\n\n`codice');
  const text = JSON.stringify(blocks);
  assert.match(text, /aperto/);
  assert.match(text, /senza-chiusura/);
});

test('un asterisco solo non diventa corsivo', () => {
  const spans = inlineSpans('2 * 3 = 6');
  assert.deepEqual(spans.map((s) => s.type), ['text']);
  assert.equal(spans[0].text, '2 * 3 = 6');
});

// ── le tabelle ───────────────────────────────────────────────────────────────
// Gli agenti le scrivono di continuo per confrontare due cose. Prima non erano un blocco: erano un
// paragrafo di pipe e trattini, con le colonne disallineate — la parete di `|` che si vedeva nella
// conversazione vera del 5/11.

test('una tabella diventa un blocco, con dentro i pezzi di riga', () => {
  const blocks = parseMarkdown('| Nel log | Vuol dire |\n|---|---|\n| `a` → **200** | passa |');
  assert.deepEqual(blocks.map((b) => b.type), ['table']);
  assert.deepEqual(blocks[0].head.map((cell) => cell[0].text), ['Nel log', 'Vuol dire']);
  assert.deepEqual(blocks[0].rows[0][0].map((span) => span.type), ['code', 'text', 'strong']);
  assert.equal(blocks[0].rows[0][1][0].text, 'passa');
});

test('le pipe senza la riga di separazione restano testo', () => {
  const blocks = parseMarkdown('| non | è |\n| una | tabella |');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph']);
});

test('la tabella finisce dove finiscono le righe con le pipe', () => {
  const blocks = parseMarkdown('| a | b |\n|--|--|\n| 1 | 2 |\n\nDopo.');
  assert.deepEqual(blocks.map((b) => b.type), ['table', 'paragraph']);
  assert.equal(blocks[0].rows.length, 1);
  assert.equal(blocks[1].spans[0].text, 'Dopo.');
});

test('una tabella senza pipe esterne si legge lo stesso', () => {
  const [table] = parseMarkdown('a | b\n--- | ---\n1 | 2');
  assert.equal(table.type, 'table');
  assert.deepEqual(table.head.map((cell) => cell[0].text), ['a', 'b']);
  assert.deepEqual(table.rows[0].map((cell) => cell[0].text), ['1', '2']);
});
