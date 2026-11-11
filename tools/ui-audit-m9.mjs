#!/usr/bin/env node
// L'audit visivo di M9: guarda le schermate **e** le misura, sulle superfici che si usano davvero.
// Non è un banco di controlli come `ui-check.mjs` (quello dice *cosa* fa la pagina): qui si
// raccoglie **come è fatta** — cosa esce dallo schermo, cosa si sovrappone a cosa, dove sta il
// fuoco, quanto è alto un bersaglio da dito, quale z-index ha chi, e se un menu aperto vicino al
// bordo resta dentro la finestra.
//
//   node tools/ui-audit-m9.mjs --shot <cartella> [--json <file>] [--url ... --token ...]
//
// Ogni sezione è isolata: se una si ferma, le altre arrivano lo stesso e la relazione lo scrive.
// Le schermate e la relazione vanno **fuori dal repo**: servono al confronto prima/dopo, alla
// stessa dimensione.
import fs from 'node:fs';
import path from 'node:path';
import { startBench } from './bench.mjs';
import { argsOf, launch } from './cdp.mjs';

const { arg, has } = argsOf();
const shotDir = path.resolve(arg('shot', path.join(process.env.TEMP || '/tmp', 'cc-remote-m9')));
const jsonFile = path.resolve(arg('json', path.join(shotDir, 'audit.json')));
const fornito = arg('url', null);
const bench = fornito ? null : await startBench({
  name: 'audit', sessions: Number(arg('sessions', 520)), projects: Number(arg('projects', 24)),
});
const base = (fornito ?? bench.base).replace(/\/$/, '');
const token = arg('token', bench?.token ?? process.env.CR_TOKEN ?? '');

const page = await launch({
  base, token, shotDir, name: 'cc-remote — audit M9',
  headful: has('headful'), port: Number(arg('port', 9377)), viewport: { width: 1440, height: 900 },
});
const { evaluate, click, goto, setViewport, shot, closeOverlays, sleep: wait, consoleErrors, press } = page;

const LARGHEZZE = [320, 390, 768, 1024, 1440, 1920];
/** L'etichetta di una sezione del pannello com'è scritta nella pagina: «stato» → «Stato».
 *  Il banco cerca le voci per testo, e `includes` distingue le maiuscole. */
const maiuscola = (nome) => nome[0].toUpperCase() + nome.slice(1);
const RIGHE = '#conversations-body .list .row[data-id]';
// Il menu di una riga sta **nella riga** (`li > .menu-btn`); `#conv-menu-btn` è quello della
// conversazione aperta, che esiste solo dentro la chat.
const MENU_RIGA = '#conversations-body .list li .menu-btn';
const MENU_CONV = '#conv-menu-btn';
const VOCI = '#menu-layer .menu .row .label';
const CAMPO_CERCA = '#conversations-body input[type="search"]';
const report = { quando: new Date().toISOString(), misure: {}, fuoco: [], errori: [], console: [] };
let problemi = 0;

/** Tutto quello che si può dire di una pagina senza guardarla. */
const MISURA = `(() => {
  const visibile = (node) => {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const nome = (node) => {
    if (!node) return null;
    const id = node.id ? '#' + node.id : '';
    const cls = [...node.classList].slice(0, 3).map((c) => '.' + c).join('');
    return node.tagName.toLowerCase() + id + cls;
  };
  const dentro = (rect) => rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
  const testo = (node) => (node.textContent || node.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  const galleggia = (node) => Boolean(node.closest('#menu-layer, #dialog-layer, #toast'));

  const orizzontale = {
    documento: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    colpevoli: [...document.querySelectorAll('body *')].filter(visibile)
      .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 12).map((node) => ({ chi: nome(node), destra: Math.round(node.getBoundingClientRect().right) })),
  };

  // Fuori dalla finestra conta per chi **gallega** (menu, dialoghi, avvisi) e per chi esce di lato:
  // una riga sotto la piega di una lista lunga è normale, e contarla sarebbe rumore.
  const fuori = [...document.querySelectorAll('button, input, select, textarea, a[href], [role="tab"], [role="button"]')]
    .filter(visibile)
    .filter((node) => {
      const r = node.getBoundingClientRect();
      if (r.right > innerWidth + 1 || r.left < -1) return true;
      return galleggia(node) && !dentro(r);
    })
    .map((node) => { const r = node.getBoundingClientRect(); return { chi: nome(node), testo: testo(node), galleggia: galleggia(node), x: Math.round(r.left), y: Math.round(r.top), destra: Math.round(r.right), sotto: Math.round(r.bottom) }; });

  const piccoli = [...document.querySelectorAll('button, a[href], input[type="checkbox"], [role="button"], [role="tab"], summary')]
    .filter(visibile)
    .map((node) => ({ chi: nome(node), testo: testo(node), h: Math.round(node.getBoundingClientRect().height), w: Math.round(node.getBoundingClientRect().width) }))
    .filter((voce) => voce.h > 0 && voce.h < 40);

  // Al centro di ogni controllo: chi c'è davvero? Se non è lui (né un suo parente), qualcosa lo copre.
  const coperti = [...document.querySelectorAll('button, input, select, a[href], [role="tab"], [role="button"]')]
    .filter(visibile)
    .map((node) => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
      const sopra = document.elementFromPoint(x, y);
      if (!sopra || sopra === node || node.contains(sopra) || sopra.contains(node)) return null;
      const style = getComputedStyle(sopra);
      // Chi copre è **un altro controllo** o è una cosa che sta sopra per mestiere? Un menu sopra
      // le righe, la testata sopra il contenuto che le è scorso sotto, il velo di una finestra:
      // fanno il loro lavoro. Un controllo coperto da un altro controllo no — è il difetto che
      // questa misura esiste per trovare (è così che si è visto l'avviso mangiarsi i pulsanti
      // della barra delle azioni, in M6).
      const CONTROLLO = 'button, a[href], input, select, textarea, [role="button"], [role="tab"]';
      // Chi copre sta **sopra per mestiere**? I menu e le finestre (nel loro strato), la testata e
      // la barra delle azioni (dichiarate nella scala dei livelli): coprono il contenuto che hanno
      // sotto, ed è esattamente quello che devono fare. Le voci di un menu sono dei button.row,
      // quindi senza questo elenco un menu aperto risulterebbe «un controllo che ne copre un
      // altro» — che è la cosa che questa misura NON deve dire.
      const STRATI = '#menu-layer, #dialog-layer, #toast, #scrim, .gate, .nav, .selectbar';
      const sopraControllo = !sopra.closest(STRATI) && Boolean(sopra.closest(CONTROLLO));
      return { chi: nome(node), testo: testo(node), sopra: nome(sopra), z: style.zIndex, pos: style.position, sopraControllo };
    }).filter(Boolean);

  const zeta = {};
  for (const node of document.querySelectorAll('body *')) {
    const style = getComputedStyle(node);
    if (style.zIndex === 'auto' || style.position === 'static') continue;
    const chiave = style.zIndex + ' · ' + style.position;
    (zeta[chiave] ??= []).push(nome(node));
  }

  const attivo = document.activeElement;
  const fuoco = attivo && attivo !== document.body
    ? { chi: nome(attivo), contorno: getComputedStyle(attivo).outlineWidth, ombra: getComputedStyle(attivo).boxShadow.slice(0, 50) }
    : null;

  const strati = {
    menu: [...document.querySelectorAll('#menu-layer .menu')].filter(visibile).length,
    dialoghi: [...document.querySelectorAll('#dialog-layer .dialog-backdrop')].filter(visibile).length,
    avvisi: [...document.querySelectorAll('#toast')].filter(visibile).length,
    chi: [...document.querySelectorAll('#menu-layer .menu, #dialog-layer .dialog, #toast')].filter(visibile)
      .map((node) => nome(node.parentElement) + ' > ' + nome(node)),
  };

  // «Piccolo» vuol dire due cose diverse a due larghezze diverse. Su uno schermo largo una riga
  // di elenco alta 38px è densità, ed è voluta: si clicca con un mouse. Su un telefono è un
  // bersaglio che si manca col pollice, ed è un difetto. piccoli conta tutto (il numero grezzo,
  // che non si nasconde); dito conta solo dove il dito c'è, ed è quello che entra nei problemi.
  const dito = innerWidth <= 960 ? piccoli.map((voce) => ({ chi: voce.chi, testo: voce.testo, h: voce.h })) : [];
  const testo_tutto = document.body.innerText || '';
  return { orizzontale, fuori, piccoli, dito, coperti, zeta, fuoco, strati, viewport: { w: innerWidth, h: innerHeight }, lunghezza: testo_tutto.length };
})()`;

/** Quanto è dentro la finestra uno strato che galleggia. */
const STRATO = `(() => {
  const nodo = document.querySelector('#menu-layer .menu, #dialog-layer .dialog');
  if (!nodo) return null;
  const r = nodo.getBoundingClientRect();
  return {
    chi: nodo.className, sopra: Math.round(r.top), sotto: Math.round(r.bottom), sinistra: Math.round(r.left), destra: Math.round(r.right),
    fuoriDallAlto: r.top < 0, fuoriDalBasso: r.bottom > innerHeight, fuoriDaSinistra: r.left < 0, fuoriDaDestra: r.right > innerWidth,
    altezza: Math.round(r.height), viewport: { w: innerWidth, h: innerHeight },
  };
})()`;

async function misura(nome, scatta = true) {
  const dati = await evaluate(MISURA);
  report.misure[nome] = dati;
  if (scatta) await shot(nome);
  const copertiDaAltro = dati.coperti.filter((voce) => voce.sopraControllo);
  if (dati.orizzontale.documento > 1 || dati.fuori.length || copertiDaAltro.length || dati.dito.length) problemi += 1;
  const dito = dati.dito.length ? ` · dito ${String(dati.dito.length).padStart(2)}` : "";
  console.log(`  ${nome.padEnd(32)} overflow ${String(dati.orizzontale.documento).padStart(3)}px · fuori ${String(dati.fuori.length).padStart(2)} · piccoli ${String(dati.piccoli.length).padStart(3)}${dito} · coperti ${String(dati.coperti.length).padStart(2)} · strati ${dati.strati.menu}/${dati.strati.dialoghi}/${dati.strati.avvisi}`);
  return dati;
}

async function vaiA(pagina) {
  await closeOverlays();
  await evaluate(`(() => { location.hash = ''; return true; })()`);
  await click('#nav-tabs .nav-tab', { text: pagina, what: `la voce ${pagina}` });
  await wait(pagina === 'Amministrazione' ? 900 : 500);
}

/** Una sezione: se si ferma, le altre arrivano lo stesso. */
async function passo(nome, lavoro) {
  try {
    await lavoro();
  } catch (errore) {
    report.errori.push({ sezione: nome, errore: errore.message });
    console.log(`  [${nome}] non è andata a termine: ${errore.message}`);
  } finally {
    await closeOverlays().catch(() => {});
  }
}

await goto({ waitFor: `document.querySelectorAll('${RIGHE}').length > 0` });
await wait(400);

// ── A. Le superfici, a sei larghezze ────────────────────────────────────────────────────────
console.log('\nA. le superfici, a sei larghezze');
await passo('A', async () => {
  for (const larghezza of LARGHEZZE) {
    await setViewport(larghezza, larghezza <= 390 ? 844 : larghezza >= 1440 ? 900 : 1024, { dark: false });
    await wait(450);
    for (const pagina of ['Conversazioni', 'Progetti', 'Amministrazione']) {
      await vaiA(pagina);
      await misura(`${larghezza}-${pagina.toLowerCase()}`);
    }
  }
});

// ── B. Dentro una conversazione: chat, permessi, terminale ──────────────────────────────────
console.log('\nB. dentro una conversazione');
await passo('B', async () => {
  await setViewport(1440, 900, { dark: false });
  await vaiA('Conversazioni');
  await click(RIGHE, { what: 'la prima conversazione' });
  await wait(900);
  await misura('1440-conversazione');

  await click('#conv-auth', { what: 'il modo di autorizzare' });
  await wait(700);
  await misura('1440-permessi');
  await closeOverlays();
  await wait(300);

  await click('#tab-terminal', { what: 'la scheda Terminale' });
  await wait(900);
  await misura('1440-terminale');
  await click('#tab-chat', { what: 'la scheda Chat' });
  await wait(400);
});

// ── C. I menu: riga, data — anche vicino al bordo ───────────────────────────────────────────
console.log('\nC. i menu, anche vicino al bordo');
await passo('C', async () => {
  await evaluate(`document.getElementById('conv-back').click()`);
  await wait(600);
  const righe = await evaluate(`document.querySelectorAll('${RIGHE}').length`);
  await click(MENU_RIGA, { what: 'il menu della prima riga' });
  await wait(400);
  await misura('1440-menu-riga');
  report.menuRiga = {
    voci: await evaluate(`[...document.querySelectorAll(${JSON.stringify(VOCI)})].map((n) => n.textContent)`),
    strato: await evaluate(STRATO),
  };

  await vaiA('Conversazioni');
  await click('#when-btn', { what: 'il filtro per data' });
  await wait(400);
  await misura('1440-menu-data');
  report.menuData = await evaluate(STRATO);
  console.log(`  menu della data: ${JSON.stringify(report.menuData)}`);

  // L'ultima riga visibile a 390: un menu che si apre verso il basso lì esce dallo schermo.
  await setViewport(390, 844, { dark: false });
  await wait(400);
  await vaiA('Conversazioni');
  await click(MENU_RIGA, { index: Math.max(0, righe - 1), what: 'il menu dell\'ultima riga' });
  await wait(400);
  report.menuUltima = await evaluate(STRATO);
  console.log(`  menu dell'ultima riga a 390: ${JSON.stringify(report.menuUltima)}`);
  await misura('390-menu-ultima-riga');
});

// ── D. Il pannello: le sue sezioni, aperture ripetute, cambio rapido ──────────────────────────
// Le sezioni si prendono **per nome**, non per indice: la navigazione secondaria è passata da
// quattro voci a cinque (M9 ha aggiunto «Conversazioni»), e un indice scritto a mano avrebbe
// continuato a cliccare la voce sbagliata senza dirlo.
console.log('\nD. il pannello');
await passo('D', async () => {
  await setViewport(1440, 900, { dark: false });
  await wait(300);
  await vaiA('Amministrazione');
  for (const nome of ['stato', 'accesso', 'copie', 'impostazioni']) {
    await click('#pane-admin .admin-tab', { text: maiuscola(nome), what: `la sezione ${nome}` });
    await wait(700);
    await misura(`1440-admin-${nome}`);
  }

  for (let giro = 1; giro <= 4; giro += 1) {
    await vaiA('Conversazioni');
    await vaiA('Amministrazione');
  }
  await misura('1440-admin-dopo-4-aperture');

  for (const nome of ['accesso', 'copie', 'impostazioni']) {
    await click('#pane-admin .admin-tab', { text: maiuscola(nome) });
  }
  await wait(900);
  await misura('1440-admin-cambio-rapido');
});

// ── E. Il fuoco e i valori attraverso il ridisegno ──────────────────────────────────────────
// Il pannello si aggiorna da sé ogni cinque secondi: si scrive, si aspetta **che il ridisegno sia
// passato**, e si guarda se testo e fuoco sono ancora lì.
console.log('\nE. fuoco e valori attraverso il ridisegno');
await passo('E', async () => {
  // `ridisegno` dice se quel campo lo ricostruisce il pannello aggiornandosi da sé. Vale per
  // quelli dentro `#pane-admin`; la ricerca dell'elenco sta fuori, e lì quello che conta è che
  // **niente** la tocchi.
  const CAMPI = [
    ['impostazioni: cartella', '#pane-admin input[data-bozza="cartella-dei-progetti"]', 'impostazioni', true],
    ['accesso: hostname', '#pane-admin .mode input', 'accesso', true],
    ['elenco: ricerca', CAMPO_CERCA, null, false],
  ];
  for (const [etichetta, selettore, scheda, ridisegno] of CAMPI) {
    if (selettore.includes('pane-admin')) {
      await vaiA('Amministrazione');
      await wait(700);
      if (scheda !== null) {
        await click('#pane-admin .admin-tab', { text: maiuscola(scheda), what: `la sezione ${scheda}` });
        await wait(600);
      }
    } else {
      await vaiA('Conversazioni');
      await wait(400);
    }
    const marcato = await evaluate(`(() => {
      const nodo = document.querySelector(${JSON.stringify(selettore)});
      if (!nodo) return false;
      nodo.focus();
      nodo.value = 'prova-audit-m9';
      nodo.dispatchEvent(new Event('input', { bubbles: true }));
      nodo.dataset.marchio = 'audit';
      return true;
    })()`);
    if (!marcato) {
      report.fuoco.push({ etichetta, trovato: false });
      console.log(`  ${etichetta}: campo non trovato`);
      problemi += 1;
      continue;
    }
    const scaduto = Date.now() + 9_000;
    let ridisegnato = false;
    while (Date.now() < scaduto && !ridisegnato) {
      ridisegnato = await evaluate(`document.querySelector(${JSON.stringify(selettore)})?.dataset.marchio !== 'audit'`);
      if (!ridisegnato) await wait(200);
    }
    const esito = await evaluate(`(() => {
      const nodo = document.querySelector(${JSON.stringify(selettore)});
      return { valore: nodo?.value ?? null, fuoco: nodo === document.activeElement, attivo: (document.activeElement?.tagName ?? '') + (document.activeElement?.getAttribute?.('aria-label') ?? '') };
    })()`);
    report.fuoco.push({ etichetta, selettore, ridisegnato, ...esito });
    if ((ridisegno && !ridisegnato) || esito.valore !== 'prova-audit-m9' || !esito.fuoco) problemi += 1;
    console.log(`  ${etichetta}: ridisegnato=${ridisegnato} (atteso: ${ridisegno}) valore=${JSON.stringify(esito.valore)} fuoco=${esito.fuoco} (attivo: ${esito.attivo})`);
  }
});

// ── F. Gli strati insieme: dialogo sopra un avviso, Escape, clic fuori, tastiera ────────────
console.log('\nF. strati, Escape, clic fuori');
await passo('F', async () => {
  await setViewport(1440, 900, { dark: false });
  await vaiA('Conversazioni');
  await click(RIGHE, { what: 'una conversazione' });
  await wait(800);

  // Un avviso a schermo e poi un dialogo: i due devono convivere senza coprirsi a vicenda.
  await evaluate(`(() => { const nodo = document.getElementById('toast'); if (nodo) { nodo.hidden = false; nodo.textContent = 'avviso di prova'; } return true; })()`);
  await click(MENU_CONV, { what: 'il menu della conversazione' });
  await wait(400);
  const voci = await evaluate(`[...document.querySelectorAll(${JSON.stringify(VOCI)})].map((n) => n.textContent)`);
  // Una voce che apra **davvero** una finestra di conferma. «Archivia» non ne apre una —
  // archiviare è reversibile e si disfa dalla stessa voce — e chiederla a un comando che non la
  // apre faceva leggere `dialogo: null` come se la finestra non si disegnasse. «Rinomina» la apre,
  // ed è quella col campo di testo: il caso più difficile da disegnare sopra un avviso.
  const conFinestra = voci.find((voce) => /Rinomina/i.test(voce));
  if (conFinestra) {
    await click(VOCI.replace('.label', ''), { text: conFinestra, what: `la voce ${conFinestra}` });
    await wait(500);
  } else {
    await click('#conv-close', { what: 'un comando che chiede conferma' }).catch(() => {});
    await wait(400);
  }
  report.dialogoConAvviso = await evaluate(`(() => {
    const avviso = document.getElementById('toast');
    const dialogo = document.querySelector('#dialog-layer .dialog');
    const dove = (nodo) => { if (!nodo) return null; const r = nodo.getBoundingClientRect(); const s = getComputedStyle(nodo); return { sopra: Math.round(r.top), sotto: Math.round(r.bottom), z: s.zIndex, visibile: !nodo.hidden && s.display !== 'none' }; };
    return { avviso: dove(avviso), dialogo: dove(dialogo) };
  })()`);
  console.log(`  dialogo + avviso: ${JSON.stringify(report.dialogoConAvviso)}`);
  await misura('1440-dialogo-con-avviso');
  await closeOverlays();
  await wait(400);

  // Escape e clic fuori: un menu deve chiudersi in tutti e due i modi.
  await evaluate(`document.getElementById('conv-back')?.click()`);
  await wait(500);
  const chiusure = {};
  await click(MENU_RIGA, { what: 'il menu della riga' });
  await wait(300);
  chiusure.primaAperto = await evaluate(`document.querySelectorAll('#menu-layer .menu').length`);
  await press('Escape');
  await wait(300);
  chiusure.conEscape = await evaluate(`document.querySelectorAll('#menu-layer .menu').length`);
  await click(MENU_RIGA, { what: 'il menu della riga' });
  await wait(300);
  chiusure.riaperto = await evaluate(`document.querySelectorAll('#menu-layer .menu').length`);
  await click('#page-conversations', { what: 'un punto fuori dal menu' }).catch(async () => {
    await evaluate(`document.body.click()`);
  });
  await wait(300);
  chiusure.conClicFuori = await evaluate(`document.querySelectorAll('#menu-layer .menu').length`);
  report.chiusure = chiusure;
  console.log(`  chiusura: ${JSON.stringify(chiusure)}`);
});

report.console = consoleErrors.slice(0, 10);
if (report.console.length) problemi += 1;

fs.mkdirSync(shotDir, { recursive: true });
fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
console.log(`\nschermate in ${shotDir}`);
console.log(`relazione in ${jsonFile}`);
console.log(`problemi: ${problemi}${report.errori.length ? ` · sezioni fermate: ${report.errori.map((e) => e.sezione).join(', ')}` : ''}`);
await page.close();
await bench?.stop();
