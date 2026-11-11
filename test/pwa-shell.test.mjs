import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Il guscio che il service worker mette in cache deve essere **tutto** il codice dell'app.
//
// Perché serve una prova: gli elenchi si aggiornano quando si aggiunge un modulo, e un modulo
// dimenticato non si vede — online va in rete, quindi funziona; la prima apertura **senza rete**,
// invece, serve 504 e la pagina resta vuota. È successo davvero: `/ordering.mjs`,
// `/terminal-reset.mjs` e `/admin.mjs` erano fuori dall'elenco.
const root = path.dirname(import.meta.dirname);
const webDir = path.join(root, 'src', 'web');
const sw = fs.readFileSync(path.join(webDir, 'sw.js'), 'utf8');
const app = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');

/** Le voci dell'elenco `SHELL`, e niente altro (`neverCache` ha percorsi che non sono file). */
function shellEntries() {
  const from = sw.indexOf('const SHELL = [');
  assert.notEqual(from, -1, 'in sw.js non c\'è più un elenco SHELL: aggiorna questa prova');
  const to = sw.indexOf('];', from);
  assert.notEqual(to, -1, 'l\'elenco SHELL non è chiuso');
  return [...sw.slice(from, to).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** Dove finisce un percorso servito: la UI è statica, i pacchetti si servono sotto `/vendor`. */
function fileOf(route) {
  if (route === '/') return path.join(webDir, 'index.html');
  if (route.startsWith('/vendor/xterm/')) return path.join(root, 'node_modules', '@xterm', 'xterm', route.slice('/vendor/xterm/'.length));
  if (route.startsWith('/vendor/fit/')) return path.join(root, 'node_modules', '@xterm', 'addon-fit', route.slice('/vendor/fit/'.length));
  return path.join(webDir, route.slice(1));
}

test('ogni file del guscio esiste davvero', () => {
  const entries = shellEntries();
  assert.ok(entries.length >= 10, `l'elenco del guscio è sospettosamente corto: ${entries.length}`);
  const mancanti = entries.filter((route) => !fs.existsSync(fileOf(route)));
  assert.deepEqual(mancanti, [], `nel guscio ci sono file che non esistono: ${mancanti.join(', ')}`);
});

test('ogni modulo che app.js importa sta nel guscio', () => {
  const nelGuscio = new Set(shellEntries());
  const importati = [...app.matchAll(/from\s+'(\/[^']+)'/g)].map((match) => match[1]);
  assert.ok(importati.length >= 5, `app.js importa ${importati.length} moduli: la prova non sta guardando il file giusto`);
  const fuori = importati.filter((route) => !nelGuscio.has(route));
  assert.deepEqual(fuori, [], `app.js importa moduli che il guscio non mette in cache: ${fuori.join(', ')}`);
});

test('le icone che il manifest dichiara esistono, e sono quelle servite', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(webDir, 'manifest.webmanifest'), 'utf8'));
  const mancanti = manifest.icons.map((icon) => icon.src).filter((src) => !fs.existsSync(fileOf(src)));
  assert.deepEqual(mancanti, [], `il manifest promette icone che non ci sono: ${mancanti.join(', ')}`);
  // E almeno una è dichiarata installabile (`any` o `maskable`): senza, Android non la usa.
  assert.ok(manifest.icons.some((icon) => String(icon.purpose ?? '').includes('maskable')), 'nessuna icona `maskable`');
});

test('la versione della cache cambia quando cambia il guscio', () => {
  // La versione è a mano, quindi la prova non può dedurla: quello che può fare è pretendere che
  // il numero ci sia e sia leggibile, perché è l'unica cosa che fa scartare la cache vecchia a
  // chi ha già installato la PWA. Una versione ferma = moduli vecchi serviti per sempre.
  const match = /const VERSION = 'cc-remote-v(\d+)'/.exec(sw);
  assert.ok(match, 'la VERSION del service worker non è più nella forma `cc-remote-vN`');
  assert.ok(Number(match[1]) >= 2, `la versione è tornata indietro: v${match[1]}`);
});

// ── Il marchio: una sola sorgente ───────────────────────────────────────────────────────────────
// La favicon e le icone della PWA escono tutte da `tools/make-pwa-icons.mjs`. Se l'SVG scritto su
// disco e i PNG non vengono dallo stesso disegno, prima o poi dicono due cose diverse — è la
// lezione di questo repository sulle copie che divergono, applicata a un'icona.
test('la favicon è quella che il disegno produce', async () => {
  const { svgOf } = await import('../tools/make-pwa-icons.mjs');
  const suDisco = fs.readFileSync(path.join(webDir, 'icon.svg'), 'utf8');
  assert.equal(
    suDisco.replace(/\r\n/g, '\n'),
    svgOf(),
    'icon.svg non è quello che `node tools/make-pwa-icons.mjs` scrive: rigeneralo invece di modificarlo a mano',
  );
});

test('le icone della PWA sono quelle che il disegno produce', async () => {
  const { pngOf } = await import('../tools/make-pwa-icons.mjs');
  for (const size of [192, 512]) {
    const suDisco = fs.readFileSync(path.join(webDir, `icon-${size}.png`));
    assert.ok(
      suDisco.equals(pngOf(size)),
      `icon-${size}.png non è quello che il disegno produce: rigeneralo con \`node tools/make-pwa-icons.mjs\``,
    );
  }
});

test('il marchio si legge a 16 e a 32 pixel, e non è più blu', async () => {
  const { leggibilita, DISEGNO } = await import('../tools/make-pwa-icons.mjs');
  // Le due misure che si vedono davvero: la scheda del browser e il collegamento sul desktop.
  for (const size of [16, 32]) {
    const esito = leggibilita(size);
    assert.ok(esito.leggibile, `a ${size}px il marchio non si legge: ${JSON.stringify(esito)}`);
    assert.equal(esito.isolati, 0, `a ${size}px il segno si sbriciola in puntini: ${esito.isolati} pixel isolati`);
  }
  // Il difetto dell'audit: la favicon era `#2563a8`, un blu che non c'entrava più niente con
  // l'identità. Il nero è l'accento, e si vede nella differenza fra i due canali.
  const [r, g, b] = DISEGNO.bg;
  assert.equal(r, g, b, 'il fondo del marchio non è neutro: l\'accento è il nero, non un colore');
  const svgText = fs.readFileSync(path.join(webDir, 'icon.svg'), 'utf8');
  assert.ok(!/#2563a8/i.test(svgText), 'il blu vecchio è tornato nella favicon');
});