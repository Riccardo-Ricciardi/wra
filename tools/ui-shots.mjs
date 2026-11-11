#!/usr/bin/env node
// Le schermate dell'interfaccia, sempre le stesse: prima e dopo un restyling, allo stesso modo.
// È il modo di avere un «prima/dopo» che si può guardare invece di ricordare.
//
//   node tools/ui-shots.mjs --shot docs/screenshots/m8.1        (o --url ... --token ...)
//
// Non controlla niente: fa le foto. I controlli stanno in `ui-check.mjs` e `ui-admin-check.mjs`.
import path from 'node:path';
import { startBench } from './bench.mjs';
import { argsOf, launch } from './cdp.mjs';

const { arg, has } = argsOf();
const fornito = arg('url', null);
const bench = fornito ? null : await startBench({ name: 'schermate' });
const base = (fornito ?? bench.base).replace(/\/$/, '');
const token = arg('token', bench?.token ?? process.env.CR_TOKEN ?? '');
const shotDir = path.resolve(arg('shot', path.join('docs', 'screenshots', 'm8', 'dopo')));

const page = await launch({
  base, token, shotDir, name: 'cc-remote — le schermate',
  headful: has('headful'), port: Number(arg('port', 9344)), viewport: { width: 1440, height: 900 },
});
const { click, evaluate, goto, setViewport, shot, closeOverlays, sleep: wait } = page;

const RIGHE = '#conversations-body .list .row[data-id]';
await goto({ waitFor: `document.querySelectorAll('${RIGHE}').length > 0` });

/** Va su una pagina della testata. */
async function pagina(nome) {
  await closeOverlays();
  await evaluate(`(() => { location.hash = ''; return true; })()`);
  await click('#nav-tabs .nav-tab', { text: nome, what: `la voce ${nome}` });
  await wait(350);
}

/** Apre la prima conversazione dell'elenco. */
async function apriConversazione() {
  await pagina('Conversazioni');
  await click(RIGHE, { what: 'la prima conversazione' });
  await wait(900);
}

// ── Le pagine, i due temi ────────────────────────────────────────────────────
for (const dark of [false, true]) {
  const tema = dark ? 'scuro' : 'chiaro';
  await setViewport(1440, 900, { dark });
  await pagina('Conversazioni');
  await shot(`01-conversazioni-${tema}-1440`);
  await pagina('Progetti');
  await shot(`02-progetti-${tema}-1440`);
  await pagina('Attività');
  await shot(`03-attivita-${tema}-1440`);
}

await setViewport(1440, 900, { dark: false });

// ── Dentro una conversazione ─────────────────────────────────────────────────
await apriConversazione();
await shot('04-conversazione-1440');
// E in cima: la chat si apre in fondo, e il turno di chi scrive — quello che deve distinguersi a
// colpo d'occhio dal turno dell'agente — sta sopra.
await evaluate(`(() => { document.getElementById('viewport').scrollTop = 0; return true; })()`);
await wait(300);
await shot('04b-conversazione-in-cima-1440');
await evaluate(`(() => { const v = document.getElementById('viewport'); v.scrollTop = v.scrollHeight; return true; })()`);
await click('#conv-auth', { what: 'il modo di autorizzare' });
await wait(600);
await shot('05-permessi-1440');
await evaluate(`document.getElementById('conv-back').click()`);
await wait(400);
await click('#tab-terminal', { what: 'la scheda Terminale' });
await wait(900);
await shot('06-terminale-1440');
await click('#tab-chat', { what: 'la scheda Chat' });
await wait(400);

// ── L'amministrazione ────────────────────────────────────────────────────────
await pagina('Amministrazione');
await wait(600);
await shot('07-amministrazione-1440');
// Per **nome**, non per indice: con l'indice, la schermata chiamata «impostazioni» mostrava le
// copie — cinque schede, e i numeri erano quelli di quando ce n'erano quattro. Una foto col nome
// sbagliato è peggio di una foto mancante: la si guarda e si crede di aver visto l'altra pagina.
for (const nome of ['Accesso', 'Copie', 'Impostazioni']) {
  await click('#pane-admin .admin-tab', { text: nome, what: `la scheda ${nome}` });
  await wait(700);
  await shot(`08-amministrazione-${nome.toLowerCase()}-1440`);
}

// ── Il tablet e il telefono ──────────────────────────────────────────────────
await setViewport(768, 1024, { dark: false });
await pagina('Conversazioni');
await shot('09-conversazioni-768');

await setViewport(390, 844, { dark: false });
await pagina('Conversazioni');
await shot('10-telefono-conversazioni-390');
await apriConversazione();
await shot('11-telefono-conversazione-390');
await pagina('Progetti');
await shot('12-telefono-progetti-390');

await setViewport(390, 844, { dark: true });
await apriConversazione();
await shot('13-telefono-conversazione-scuro-390');

console.log(`schermate in ${shotDir}`);
await page.close();
await bench?.stop();
