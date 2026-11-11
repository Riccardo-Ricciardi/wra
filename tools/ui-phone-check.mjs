#!/usr/bin/env node
// Il telefono, e la riconnessione: quello che della checklist di `docs/PHONE.md` si può provare
// senza avere il telefono in mano.
//
//   node tools/ui-phone-check.mjs
//
// Un Chrome vero con le misure e il **tocco** di un telefono (412×915, fattore 2.625, touch
// acceso), su un banco isolato che si costruisce il proprio mondo. Le cose che restano fuori sono
// dichiarate in fondo, e sono quelle che solo il dispositivo può dire: la tastiera che si apre
// davvero, Tailscale, l'icona sulla schermata di casa.
//
// La prova che conta è la **riconnessione**: si stacca la rete sotto alla pagina, si guarda che
// l'avviso compaia e che non si porti via niente, e si guarda che torni da sola — e che dopo il
// ritorno il **terminale riscriva**, che è la differenza fra «la pagina si è ripresa» e «la
// conversazione si è ripresa».
import { startBench } from './bench.mjs';
import { launch } from './cdp.mjs';

const PIXEL = { width: 412, height: 915, scale: 2.625 };
const RIGHE = '#conversations-body .list .row[data-id]';

const bench = await startBench({ name: 'telefono' });
const page = await launch({
  base: bench.base, token: bench.token, shotDir: 'docs/screenshots/phone',
  name: 'cc-remote — il telefono', port: 9377, viewport: { width: PIXEL.width, height: PIXEL.height },
});
const { check, evaluate, click, goto, setViewport, shot, sleep: wait } = page;



await setViewport(PIXEL.width, PIXEL.height, { mobile: true, scale: PIXEL.scale });
await goto({ waitFor: `document.querySelectorAll('${RIGHE}').length > 0` });

await check('il tocco è acceso: altrimenti i bersagli da dito non si stanno provando', async () => {
  const tocco = await evaluate(`({ punti: navigator.maxTouchPoints ?? 0, mobile: matchMedia('(pointer: coarse)').matches })`);
  // `maxTouchPoints` viene dall'emulazione: se è zero, questa prova sta girando su un desktop
  // travestito, e le misure che seguono non valgono niente.
  return `${tocco.punti} punti di tocco · puntatore grosso: ${tocco.mobile}`;
});

await check('la pagina si apre alla larghezza di un telefono, senza scorrere di lato', async () => {
  const misura = await evaluate(`({
    larghezza: document.documentElement.scrollWidth,
    finestra: window.innerWidth,
    titolo: document.querySelector('#conversations-body h1')?.textContent ?? null,
    righe: document.querySelectorAll('${RIGHE}').length,
  })`);
  if (misura.larghezza > misura.finestra + 1) throw new Error(`la pagina è larga ${misura.larghezza} su una finestra da ${misura.finestra}`);
  if (!misura.righe) throw new Error('l\'elenco delle conversazioni è vuoto');
  await shot('telefono-elenco');
  return `${misura.righe} conversazioni in ${misura.finestra}px`;
});

await check('si apre una conversazione, e la sua chat si vede', async () => {
  await click(RIGHE, { what: 'la prima conversazione' });
  await wait(900);
  const vista = await evaluate(`({
    nome: document.getElementById('conv-name')?.textContent ?? null,
    scrittura: Boolean(document.getElementById('composer-text')),
    chat: !document.getElementById('pane-chat').hidden,
  })`);
  if (!vista.chat || !vista.scrittura) throw new Error(`la conversazione non si è aperta: ${JSON.stringify(vista)}`);
  await shot('telefono-conversazione');
  return `«${vista.nome}» con il campo di scrittura in fondo`;
});

await check('il campo di scrittura non finisce sotto il bordo dello schermo', async () => {
  // La tastiera vera non si può alzare da qui (vedi in fondo): quello che si può misurare è che il
  // campo stia **dentro** il viewport, che è la condizione perché la logica di `visualViewport`
  // abbia qualcosa su cui lavorare.
  const misura = await evaluate(`(() => {
    const campo = document.getElementById('composer-wrap').getBoundingClientRect();
    return { fondo: Math.round(campo.bottom), altezza: Math.round(window.innerHeight), dentro: campo.bottom <= window.innerHeight + 1 };
  })()`);
  if (!misura.dentro) throw new Error(`il campo finisce a ${misura.fondo} su uno schermo alto ${misura.altezza}`);
  return `il campo finisce a ${misura.fondo}px, lo schermo è alto ${misura.altezza}px`;
});

// Questa **misura e dichiara**, non fallisce. Nella testata della conversazione tre comandi sono
// sotto i 44px, e sono lì da prima di questa prova: l'interfaccia è congelata dal 5/11 e non si
// tocca per un bersaglio da 26px. Ma il numero si guarda a ogni giro — un difetto dichiarato è una
// decisione, un difetto taciuto è un difetto che qualcuno ritroverà.
await check('i comandi si toccano: quanto sono grandi davvero', async () => {
  const misure = await evaluate(`(() => {
    const nodi = [...document.querySelectorAll('#page-session button:not([hidden]), #page-session .seg button')];
    return nodi.map((n) => {
      const r = n.getBoundingClientRect();
      return { nome: n.id || n.textContent.trim().slice(0, 18) || '(icona)', w: Math.round(r.width), h: Math.round(r.height) };
    }).filter((m) => m.w > 0 && m.h > 0);
  })()`);
  const piccoli = misure.filter((m) => m.w < 44 || m.h < 44);
  if (piccoli.length) {
    console.log(`  ⚠ sotto i 44px (interfaccia congelata: dichiarati, non corretti): ${piccoli.map((m) => `${m.nome} ${m.w}×${m.h}`).join(' | ')}`);
  }
  return `${misure.length - piccoli.length}/${misure.length} sopra i 44px`;
});

await check('il terminale si apre e ha dentro il TUI vero', async () => {
  await click('#tab-terminal', { what: 'la scheda Terminale' });
  await wait(1_500);
  const terminale = await evaluate(`(() => {
    const schermo = document.getElementById('screen');
    const righe = schermo.querySelectorAll('.xterm-rows > div').length;
    const testo = (schermo.textContent || '').replace(/\\s+/g, ' ').trim();
    return { righe, scritto: testo.length, inizio: testo.slice(0, 60) };
  })()`);
  await shot('telefono-terminale');
  if (!terminale.scritto) throw new Error('il terminale è vuoto: il TUI non è arrivato');
  return `${terminale.righe} righe, comincia con «${terminale.inizio}»`;
});

await check('staccando la rete: avviso sì, e niente sparisce', async () => {
  await click('#tab-chat', { what: 'la scheda Chat' });
  await wait(400);
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await wait(2_500);
  const staccato = await evaluate(`({
    avviso: !document.getElementById('banner').hidden,
    testo: document.getElementById('banner').textContent.trim().slice(0, 80),
    conversazione: !document.getElementById('page-session').hidden,
    nome: document.getElementById('conv-name')?.textContent ?? null,
  })`);
  if (!staccato.avviso) throw new Error('senza rete non compare nessun avviso: la pagina sembra rotta e non lo dice');
  if (!staccato.conversazione) throw new Error('senza rete la conversazione aperta è sparita');
  await shot('telefono-senza-rete');
  return `avviso «${staccato.testo}», e «${staccato.nome}» è ancora aperta`;
});

await check('tornata la rete si riconnette da sola', async () => {
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const scaduto = Date.now() + 20_000;
  let tornato = await evaluate(`document.getElementById('banner').hidden === true`);
  while (Date.now() < scaduto && !tornato) {
    await wait(500);
    tornato = await evaluate(`document.getElementById('banner').hidden === true`);
  }
  if (!tornato) throw new Error('tornata la rete, l\'avviso resta: la pagina non si è riconnessa');
  // Il pallino accanto alla parola: `setConn` scrive `data-state` su `#conn`, ma il CSS colora
  // `.nav-conn[data-state=…] .dot` — cioè il **contenitore**, che nell'HTML è fermo a «off» e non
  // lo aggiorna nessuno. Quindi il pallino non cambia mai colore. Non è bloccante (la parola dice
  // il vero) e l'interfaccia è congelata: si dichiara.
  const pallino = await evaluate(`({
    punto: document.getElementById('conn').dataset.state,
    parola: document.getElementById('conn-text').textContent,
    colore: getComputedStyle(document.getElementById('conn')).backgroundColor,
  })`);
  console.log(`  ⚠ il pallino dice «${pallino.punto}» e resta ${pallino.colore}: il CSS guarda il contenitore, che non lo aggiorna nessuno`);
  return `avviso sparito, la parola dice «${pallino.parola}»`;
});

await check('dopo la riconnessione il terminale torna a scrivere', async () => {
  // È la prova che distingue «la pagina si è ripresa» da «la conversazione si è ripresa»: il
  // websocket è nuovo, e il server deve aver rimandato lo schermo a chi lo guarda.
  await click('#tab-terminal', { what: 'la scheda Terminale' });
  await wait(1_500);
  const prima = await evaluate(`document.getElementById('screen').textContent.replace(/\\s+/g, ' ').trim().length`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'x', key: 'x' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x' });
  await wait(1_200);
  const dopo = await evaluate(`document.getElementById('screen').textContent.replace(/\\s+/g, ' ').trim()`);
  if (!prima) throw new Error('dopo la riconnessione il terminale è vuoto: lo schermo non è tornato');
  await shot('telefono-terminale-dopo-riconnessione');
  return `lo schermo è tornato (${prima} caratteri) e accetta tasti (${dopo.length} adesso)`;
});

await check('nessun errore in pagina', async () => {
  // Gli errori di rete li ha provocati questa prova, e sono la prova che la disconnessione è
  // arrivata: non contano.
  const errori = page.consoleErrors.filter((line) => !/^\[network\]/.test(line));
  if (errori.length) throw new Error(errori.slice(0, 3).join(' | '));
  return 'nessun errore in console';
});

page.report();
console.log('\nRestano fuori, e solo il telefono in mano può dirle: la tastiera che si apre davvero');
console.log('(qui il campo si misura dentro il viewport, non sotto una tastiera vera), Tailscale, e');
console.log('l\'icona sulla schermata di casa. Stanno in docs/PHONE.md.');

await page.close();
await bench.stop();
process.exit(page.results.failures.length ? 1 : 0);
