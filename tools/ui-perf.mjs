#!/usr/bin/env node
// Quanto ci mette l'interfaccia con 10, 100, 500, 2000 conversazioni: per ogni soglia si costruisce
// un mondo usa e getta, si misura, si porta via. Non tocca il registro vero e non lascia processi.
//
//   node tools/ui-perf.mjs                     (10,100,500,2000)
//   node tools/ui-perf.mjs --sizes 1000        (una soglia sola)
//
// Il mondo lo fa `tools/bench.mjs`, come per gli altri banchi: prima questo file si seminava il
// registro da sé, si accendeva il server e aspettava **2,5 secondi fissi** — che sulla macchina
// lenta sono pochi e su quella veloce sono buttati. Adesso si aspetta che il server dica di essere
// in ascolto, e la TUI finta arriva insieme al resto (prima il `claude` vero era a un passo).
import os from 'node:os';
import path from 'node:path';
import { startBench } from './bench.mjs';
import { argsOf, launch } from './cdp.mjs';

const { arg } = argsOf();
const sizes = arg('sizes', '10,100,500,2000').split(',').map(Number);

const rows = [];
for (const total of sizes) {
  const bench = await startBench({ sessions: total, projects: 24, name: `  ${total} conversazioni` });

  const page = await launch({
    // `ui-perf` non scatta niente: la cartella delle schermate serve solo perché il banco la crei.
    base: bench.base, token: bench.token, shotDir: path.join(os.tmpdir(), 'cc-remote-perf-shots'),
    name: `  ${total} conversazioni`, port: 9366, viewport: { width: 1440, height: 900 },
  });
  const { evaluate, goto } = page;

  const opened = Date.now();
  await goto({ waitFor: `document.querySelectorAll('#conversations-body .list .row[data-id]').length > 0` });
  const loadMs = Date.now() - opened;

  const searchMs = await evaluate(`(async () => {
    const at = performance.now();
    const field = document.querySelector('#filter');
    field.value = 'migrazione';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round(performance.now() - at);
  })()`);

  const drawn = await evaluate(`document.querySelectorAll('#conversations-body .list .row[data-id]').length`);
  // Da quando il guscio è a pagine, la seconda cosa da misurare è il **cambio di pagina**: è
  // l'operazione che il guscio nuovo ha aggiunto, ed è quella che si poteva pagare cara.
  const cambiaPaginaMs = await evaluate(`(async () => {
    const at = performance.now();
    [...document.querySelectorAll('#nav-tabs .nav-tab')].find((b) => b.textContent.includes('Progetti')).click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round(performance.now() - at);
  })()`);

  rows.push({ conversazioni: total, aperturaMs: loadMs, ricercaMs: searchMs, cambiaPaginaMs, righeDisegnate: drawn });
  await page.close();
  await bench.stop();
}

console.log('');
console.log('| conversazioni | apertura | ricerca | cambia pagina | righe disegnate |');
console.log('|---|---|---|---|---|');
for (const row of rows) {
  console.log(`| ${row.conversazioni} | ${row.aperturaMs} ms | ${row.ricercaMs} ms | ${row.cambiaPaginaMs} ms | ${row.righeDisegnate} |`);
}
