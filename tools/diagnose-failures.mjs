#!/usr/bin/env node
// La riproduzione minima dei controlli rossi, uno per uno, con lo stato che serve a capire **di
// chi** è il difetto: del prodotto o del controllo. Non è un banco — non passa e non fallisce —
// stampa e basta, ed è quello che serve quando un controllo dice «non trovato» e non si sa perché.
//
//   node tools/diagnose-failures.mjs --url http://127.0.0.1:4399 --token <token>
import path from 'node:path';
import { argsOf, launch } from './cdp.mjs';

const { arg } = argsOf();
const page = await launch({
  base: arg('url', 'http://127.0.0.1:4399').replace(/\/$/, ''),
  token: arg('token', process.env.CR_TOKEN || ''),
  shotDir: path.resolve(arg('shot', path.join(process.env.TEMP || '/tmp', 'cc-remote-diagnosi'))),
  name: 'cc-remote — diagnosi',
  headful: false,
  port: Number(arg('port', 9388)),
  viewport: { width: 1440, height: 900 },
});
const { click, evaluate, goto, sleep, shot } = page;
const RIGHE = '#conversations-body .list .row[data-id]';

const stampa = (titolo, valore) => console.log(`\n── ${titolo}\n${typeof valore === 'string' ? valore : JSON.stringify(valore, null, 2)}`);

await goto({ waitFor: `document.querySelectorAll('${RIGHE}').length > 0` });
await sleep(400);

// ── 1. Il menu del «Quando» ──────────────────────────────────────────────────
// Il sospetto: `openMenu` viene chiamato, ma qualcosa lo chiude subito dopo. Qui si guarda lo
// strato dei menu **prima**, **durante** e **dopo** il clic, e cosa c'è dentro.
await click('#when-btn', { what: 'il pulsante Quando' });
await sleep(500);
stampa('1. menu «Quando»', await evaluate(`(() => {
  const strato = document.getElementById('menu-layer');
  const menu = strato.querySelector('.menu');
  return {
    figliNelloStrato: strato.childElementCount,
    menuC_e: Boolean(menu),
    voci: menu ? [...menu.querySelectorAll('.row .label')].map((n) => n.textContent) : null,
    expandAriaDelPulsante: document.getElementById('when-btn')?.getAttribute('aria-expanded'),
    pulsanteNelDocumento: document.body.contains(document.getElementById('when-btn')),
    classiMenu: menu ? menu.className : null,
    rettangolo: menu ? (() => { const r = menu.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
  };
})()`));
await shot('1-menu-quando');

// ── 2. Una conversazione che si apre ─────────────────────────────────────────
// Tre controlli falliscono aprendo una conversazione. Qui si prova la sequenza **esatta** che
// fanno: ricerca nel contenuto, poi apertura.
await evaluate(`(() => { const i = document.querySelector('${RIGHE}'); i.click(); return true })()`);
await sleep(700);
stampa('2a. apertura diretta (click sintetico)', await evaluate(`({
  sessioneVisibile: !document.getElementById('page-session').hidden,
  nome: document.getElementById('conv-name')?.textContent ?? null,
  indirizzo: location.hash,
})`));
await click('#conv-back', { what: 'torna indietro' }).catch((e) => console.log('   (conv-back)', e.message));
await sleep(400);

await click(RIGHE, { index: 0, what: 'la prima riga' });
await sleep(700);
stampa('2b. apertura con clic vero del mouse', await evaluate(`({
  conversazioniVisibili: !document.getElementById('page-conversations').hidden,
  sessioneVisibile: !document.getElementById('page-session').hidden,
  nome: document.getElementById('conv-name')?.textContent ?? null,
  indirizzo: location.hash,
  righe: document.querySelectorAll('${RIGHE}').length,
})`));
await shot('2-apertura');

// ── 3. Il dialogo dell'archiviazione in blocco ───────────────────────────────
await evaluate(`document.getElementById('conv-back')?.click()`);
await sleep(400);
await click('#nav-more', { what: 'il menu della testata' });
await sleep(400);
await click('#menu-layer .menu .row', { text: 'Seleziona più conversazioni' });
await sleep(500);
stampa('3a. selezione accesa', await evaluate(`({
  barraVisibile: !document.getElementById('selectbar').hidden,
  caselle: document.querySelectorAll('${RIGHE} .pick').length,
})`));
await click(RIGHE, { index: 0 });
await click(RIGHE, { index: 1 });
await sleep(300);
stampa('3b. due scelte', await evaluate(`({
  barra: document.querySelector('#selectbar strong')?.textContent ?? null,
  azioni: [...document.querySelectorAll('#selectbar .act')].map((b) => ({ testo: b.textContent.trim(), spento: b.disabled })),
})`));
await click('#selectbar .act', { text: 'archivia', what: 'archivia' });
await sleep(1_000);
stampa('3c. il dialogo', await evaluate(`(() => {
  const strato = document.getElementById('dialog-layer');
  return {
    figli: strato.childElementCount,
    html: strato.innerHTML.slice(0, 400),
    avviso: document.getElementById('toast').hidden ? null : document.getElementById('toast').textContent,
  };
})()`));
await shot('3-dialogo-blocco');

console.log(`\nconsole: ${page.consoleErrors.length ? page.consoleErrors.join(' | ') : 'pulita'}`);

// ── 4. La conversazione aperta: chi ha altezza zero? ─────────────────────────
await evaluate(`document.getElementById('conv-back')?.click()`);
await sleep(400);
await click(RIGHE, { index: 0, what: 'la prima conversazione' });
await sleep(700);
stampa('4. altezze nella conversazione', await evaluate(`(() => {
  const h = (sel) => { const n = document.querySelector(sel); if (!n) return 'assente';
    const r = n.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) + (n.hidden ? ' (hidden)' : ''); };
  return {
    '#main': h('#main'),
    '#page-session': h('#page-session'),
    '#pane-chat': h('#pane-chat'),
    '#viewport': h('#viewport'),
    '#composer-wrap': h('#composer-wrap'),
    '#composer': h('#composer'),
    '#composer-text': h('#composer-text'),
    classiSession: document.getElementById('page-session').className,
    displayCalcolato: getComputedStyle(document.getElementById('page-session')).display,
  };
})()`));
await page.close();
