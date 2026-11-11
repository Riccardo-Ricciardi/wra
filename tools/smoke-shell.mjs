#!/usr/bin/env node
// Un carico di pagina e basta: la pagina si apre, le sezioni ci sono, la console è pulita.
// Serve mentre il guscio cambia forma — dice subito se la struttura si è rotta, senza aspettare i
// trentaquattro controlli che verificano il comportamento.
//
//   node tools/smoke-shell.mjs --url http://127.0.0.1:4399 --token <token> [--shot <cartella>]
import path from 'node:path';
import { argsOf, launch } from './cdp.mjs';

const { arg } = argsOf();
const page = await launch({
  base: arg('url', 'http://127.0.0.1:4399').replace(/\/$/, ''),
  token: arg('token', process.env.CR_TOKEN || ''),
  shotDir: path.resolve(arg('shot', path.join(process.env.TEMP || '/tmp', 'cc-remote-smoke'))),
  name: 'cc-remote — il guscio',
  headful: false,
  port: Number(arg('port', 9366)),
  viewport: { width: 1440, height: 900 },
});

const righe = `#conversations-body .list .row[data-id]`;
await page.goto({ waitFor: `document.querySelectorAll('${righe}').length > 0` });
await page.sleep(400);
await page.shot('guscio-1440');

// Le quattro pagine: ognuna deve avere il suo titolo e il suo contenuto.
for (const [voce, atteso] of [['Progetti', '#projects-body h1'], ['Attività', '#activity-body h1']]) {
  await page.click('#nav-tabs .nav-tab', { text: voce, what: `la voce ${voce}` });
  await page.sleep(300);
  const titolo = await page.evaluate(`document.querySelector('${atteso}')?.textContent ?? null`);
  console.log(`${voce}: ${titolo}`);
  await page.shot(`guscio-${voce.toLowerCase()}-1440`);
}

// La conversazione aperta: si torna alle conversazioni e si apre la prima riga.
await page.click('#nav-tabs .nav-tab', { text: 'Conversazioni', what: 'la voce Conversazioni' });
await page.sleep(300);
await page.click(righe, { what: 'la prima conversazione' });
await page.sleep(900);
const aperta = await page.evaluate(`(() => ({
  vista: !document.getElementById('page-session').hidden,
  titolo: document.getElementById('conv-name')?.textContent ?? null,
  torno: Boolean(document.getElementById('conv-back')),
}))()`);
console.log(`conversazione: ${JSON.stringify(aperta)}`);
await page.shot('conversazione-1440');

// Il telefono: la stessa pagina a 390, e l'elenco che deve restare leggibile.
await page.setViewport(390, 844);
await page.sleep(400);
const stretto = await page.evaluate(`(() => ({
  scrollOrizzontale: document.documentElement.scrollWidth > window.innerWidth + 1,
  larghezza: document.documentElement.scrollWidth,
  finestra: window.innerWidth,
}))()`);
console.log(`telefono: ${JSON.stringify(stretto)}`);
await page.shot('telefono-390');

// La pagina dei progetti e quello che propone per il registro: si guarda cosa dice, e **non** si
// conferma niente — la pulizia si prova a parte, sul registro isolato.
// Si torna a larghezza piena **prima**: la conversazione è ancora aperta da prima, e cliccare una
// voce della testata deve uscirne.
await page.setViewport(1440, 900);
await page.click('#nav-tabs .nav-tab', { text: 'Progetti', what: 'la voce Progetti' });
await page.sleep(300);
const pulizia = await page.evaluate(`(() => ({
  righe: document.querySelectorAll('#projects-body .list .row').length,
  prova: document.querySelector('#projects-body .note.tests')?.textContent ?? null,
  nascoste: [...document.querySelectorAll('#projects-body .list .row')].filter((n) => /cc-remote-e2e-/.test(n.title)).length,
}))()`);
console.log(`progetti: ${JSON.stringify(pulizia)}`);
await page.shot('progetti-1440');
await page.setViewport(1440, 900);

// L'amministrazione: prende il posto della pagina, e deve leggersi come una pagina.
await page.click('#nav-tabs .nav-tab', { text: 'Amministrazione', what: 'la voce Amministrazione' });
await page.sleep(700);
const amministrazione = await page.evaluate(`(() => ({
  visibile: !document.getElementById('pane-admin').hidden,
  sezioni: [...document.querySelectorAll('#pane-admin .admin-tab')].map((b) => b.textContent.trim()),
  righe: document.querySelectorAll('#pane-admin .ledger-row').length,
}))()`);
console.log(`amministrazione: ${JSON.stringify(amministrazione)}`);
await page.shot('amministrazione-1440');

console.log(page.consoleErrors.length ? `errori in console: ${page.consoleErrors.slice(0, 5).join(' | ')}` : 'nessun errore in console');
await page.close();
process.exit(page.consoleErrors.length ? 1 : 0);
