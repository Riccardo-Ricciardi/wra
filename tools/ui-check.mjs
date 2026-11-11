#!/usr/bin/env node
// Verifica dell'interfaccia in un browser **vero**: Chrome pilotato via CDP, senza aggiungere
// dipendenze (`ws` c'è già). Non è una suite di unit test e non la si esegue a ogni commit:
// serve a rispondere a «funziona davvero, premendo i pulsanti?» — e a lasciare le schermate.
//
// Il banco si porta il proprio mondo: registro appena seminato, server suo su una porta effimera,
// cartella usa e getta (`tools/bench.mjs`). Non c'è niente da preparare prima e niente da pulire
// dopo, e il giro non tocca né il registro vero né `~/.cc-remote`.
//
//   node tools/ui-check.mjs                       (520 conversazioni in 24 progetti)
//   node tools/ui-check.mjs --sessions 120        (o --url http://127.0.0.1:4399 --token <token>)
//
// I clic sono eventi **veri** del mouse (Input.dispatchMouseEvent), non `element.click()`: è
// l'unico modo di accorgersi di quello che sta sopra a un pulsante — la lezione di quel `[hidden]`
// che batteva un `display` esplicito e rendeva la pagina inutilizzabile senza dire niente.
import path from 'node:path';
import { startBench } from './bench.mjs';
import { argsOf, launch, sleep } from './cdp.mjs';

const { arg, has } = argsOf();
const shotDir = path.resolve(arg('shot', path.join('docs', 'screenshots', 'm5')));

// Il mondo su cui gira il banco: registro appena seminato, server suo, cartella usa e getta.
// Prima si puntava a un server acceso a mano, e il giro **modificava il registro su cui girava**
// — archivia, fissa, rinomina — quindi il secondo giro partiva da dati diversi e cadeva su
// controlli diversi. Adesso si riparte da zero a ogni esecuzione, e `--url` resta solo per
// puntare a un server che c'è già (e non deve essere quello vero).
const fornito = arg('url', null);
const bench = fornito ? null : await startBench({
  name: 'interfaccia',
  sessions: Number(arg('sessions', 520)),
  projects: Number(arg('projects', 24)),
});
const base = (fornito ?? bench.base).replace(/\/$/, '');
const token = arg('token', bench?.token ?? process.env.CR_TOKEN ?? '');
if (!token) {
  console.error('serve un token: nessun banco avviato e `--token` (o CR_TOKEN) non è stato dato.');
  process.exit(2);
}

// Il banco (Chrome, i clic veri, le schermate, i controlli) sta in `tools/cdp.mjs`: lo usano anche
// i controlli del pannello, e due modi di cliccare divergono — il secondo smette di accorgersi
// delle cose che il primo trova.
const page = await launch({
  base, token, shotDir, name: 'cc-remote — verifica in un browser vero',
  headful: has('headful'), port: Number(arg('port', 9333)), keepOpen: has('keep'),
});
const {
  send, once, boxOf, evaluate, js, click, press, typeIn, closeOverlays, shot, goto, check, assert, attendi, uiFetch, redact,
} = page;
const viewport = page.setViewport;

// I selettori del guscio, in un posto solo.
const RIGHE = '#conversations-body .list .row[data-id]';
const PROGETTI = '#projects-body .list .row';
const CAMPO = '#conversations-body input[type="search"]';
const VOCE = (pagina) => `#nav-tabs .nav-tab[data-page="${pagina}"]`;
const FILTRO = (facet) => `#conversations-body .seg button[data-facet="${facet}"]`;

/**
 * L'indice dell'n-esima riga dell'elenco delle conversazioni.
 *
 * Era una somma sulle righe dei progetti aperti — l'elenco era raggruppato per progetto e chiuso
 * per default. Adesso le conversazioni sono una pagina sola, in ordine di attività: l'indice è
 * quello della riga. Il primo argomento resta perché le prove lo passano ancora, e il senso è lo
 * stesso: «una conversazione qualsiasi, scelta in modo stabile».
 */
const convIndex = (_projectIndex, rowIndex = 0) => Promise.resolve(rowIndex);

/** Il pulsante «⋯» di un progetto, nella pagina Progetti. */
const projectMenuButton = '#projects-body .list li .icon-btn[aria-haspopup="menu"]';

/** Va su una pagina della testata. Da qui passa tutto: la navigazione è una sola. */
async function vaiA(pagina) {
  await closeOverlays();
  const pannello = pagina === 'admin' ? 'pane-admin' : `page-${pagina}`;
  if (await evaluate(`!document.getElementById('${pannello}').hidden`)) return;
  await click(VOCE(pagina), { what: `la voce ${pagina}` });
  await sleep(320);
}

/**
 * Apre l'i-esima conversazione dell'elenco, **sulla scheda Chat**.
 *
 * La scheda è una preferenza che si ricorda, e un controllo che lascia il terminale aperto fa
 * fallire il successivo per un elemento che misura zero perché è dentro una scheda nascosta — un
 * fallimento che non c'entra niente con quello che quel controllo stava provando. È il mestiere
 * dell'aiutante: aprire una conversazione *pronta da leggere*.
 */
async function apriConversazione(index = 0) {
  await vaiA('conversations');
  await click(RIGHE, { index, what: `la conversazione ${index}` });
  await sleep(700);
  if (await evaluate(`document.getElementById('pane-chat').hidden`)) {
    await click('#tab-chat', { what: 'la scheda Chat' });
    await sleep(400);
  }
}

/**
 * Lo stato di partenza: **pagina delle conversazioni**, nessuna conversazione aperta, nessun
 * filtro, nessuna parola cercata, nessuna selezione.
 *
 * Ogni prova parte da qui, e non è pignoleria: con quattro pagine e tre modalità (conversazione,
 * permessi, selezione) una prova che lascia aperta una schermata fa fallire la successiva per un
 * elemento «non visibile» che non c'entra niente con quello che quella stava provando. Ripartire
 * da uno stato noto è quello che rende leggibile il fallimento.
 */
async function resetList() {
  await closeOverlays();
  // La selezione multipla è una modalità, non uno stato che si eredita.
  if (await evaluate(`!document.getElementById('selectbar').hidden || document.querySelectorAll('${RIGHE} .pick').length > 0`)) {
    await press('Escape');
    await sleep(200);
  }
  // La schermata dei permessi vive dentro la conversazione: chiuderla vuol dire tornare indietro.
  if (!(await evaluate(`document.getElementById('pane-auth').hidden`))) {
    await click('#conv-back', { what: 'chiudi i permessi' });
    await sleep(300);
  }
  // E la conversazione aperta si chiude: la pagina delle conversazioni **è** l'elenco, e con una
  // conversazione aperta non c'è.
  if (!(await evaluate(`document.getElementById('page-session').hidden`))) {
    await click('#conv-back', { what: 'torna alle conversazioni' });
    await sleep(350);
  }
  // Il filtro di un progetto si toglie: è uno stato che si vede (il titolo della pagina cambia)
  // ma che non si toglie da sé, e un controllo che lo lascia acceso fa fallire il successivo per
  // righe che non ci sono — un fallimento che non c'entra con quello che quel controllo provava.
  if (await evaluate(`Boolean(document.getElementById('clear-project'))`)) {
    await click('#clear-project', { what: 'tutte le conversazioni' });
    await sleep(350);
  }
  await vaiA('conversations');
  // Sempre sulla scheda chat: un controllo che lascia il terminale aperto fa fallire il prossimo
  // per un elemento «non visibile», che non c'entra niente con quello che si stava provando.
  await typeIn(CAMPO, '');
  if (!(await evaluate(`document.querySelector('${FILTRO('all')}').getAttribute('aria-pressed') === 'true'`))) {
    await click(FILTRO('all'), { what: 'il filtro tutte' });
  }
  await sleep(220);
}

/**
 * Aspetta che il **registro** dica qualcosa di una conversazione, e la restituisce com'è allora.
 * È la stessa idea di `attendi`, un piano più sotto: quello che si deve avverare sta sul server.
 */
async function attendiRegistro(nome, predicato, what, { timeoutMs = 8_000 } = {}) {
  const scaduto = Date.now() + timeoutMs;
  let ultima = null;
  while (Date.now() < scaduto) {
    ultima = (await uiFetch('/local/sessions')).sessions.find((entry) => entry.name === nome) ?? null;
    if (ultima && predicato(ultima)) return ultima;
    await sleep(200);
  }
  throw new Error(`${what} — il registro dice ${JSON.stringify(ultima)}`);
}

/** Le voci del menu aperto adesso, per testo: un controllo che cerca una voce deve poter dire quali ci sono. */
const vociMenu = () => evaluate(`[...document.querySelectorAll('#menu-layer .menu .row .label')].map((node) => node.textContent)`);

/**
 * Dove è finito il menu rispetto al pulsante che l'ha aperto.
 *
 * `scarto` è la distanza fra il bordo destro del menu e quello dell'ancora: zero vuol dire che il
 * menu è **attaccato al suo pulsante**. È la misura che il difetto di M9 sbagliava di 1000px — i
 * menu si aprivano tutti a `left: 8px`, e nessuna asserzione se ne accorgeva.
 *
 * @param {string} selettoreAncora
 */
const menuAttaccato = (selettoreAncora) => evaluate(`(() => {
  const menu = document.querySelector('#menu-layer .menu');
  const ancora = document.querySelector(${JSON.stringify(selettoreAncora)});
  if (!menu || !ancora) return null;
  const m = menu.getBoundingClientRect();
  const a = ancora.getBoundingClientRect();
  return {
    scarto: Math.round(Math.abs(m.right - a.right)),
    tocca: Math.round(Math.min(Math.abs(m.top - (a.bottom + 6)), Math.abs(a.top - 6 - m.bottom))) <= 1,
    dentro: m.top >= -1 && m.left >= -1 && m.bottom <= innerHeight + 1 && m.right <= innerWidth + 1,
    altezza: Math.round(m.height), larghezza: Math.round(m.width), viewport: [innerWidth, innerHeight],
  };
})()`);

/**
 * I gruppi **disegnati**: titolo → i nomi delle conversazioni che ci stanno dentro.
 *
 * Serve a dire due cose insieme, che una riga sola non dice: che la sezione c'è, e che la
 * conversazione sta **lì** e non anche altrove. Le righe di una scheda senza intestazioni (la
 * scheda «Adesso») finiscono sotto `(senza intestazione)` — ed è il modo di accorgersi che una
 * conversazione accesa è finita là invece che nella sua sezione.
 */
const gruppiDisegnati = () => evaluate(`(() => {
  const gruppi = {};
  for (const lista of document.querySelectorAll('#conversations-body .list')) {
    let titolo = '(senza intestazione)';
    for (const node of lista.children) {
      if (node.classList.contains('group-head')) {
        titolo = node.textContent;
        gruppi[titolo] ??= [];
        continue;
      }
      // La riga è un <li> che avvolge il pulsante (e il suo menu): si cerca dentro, non sul figlio.
      const row = node.querySelector('.row[data-id]');
      if (!row) continue;
      (gruppi[titolo] ??= []).push(row.querySelector('.title').textContent);
    }
  }
  return gruppi;
})()`);

await viewport(1440, 900);
// La pagina è pronta quando l'elenco delle conversazioni ha le sue righe. Il valore di partenza
// del banco cercava i progetti nell'elenco a colonna, che non c'è più.
await goto({ waitFor: `document.querySelectorAll('${RIGHE}').length > 0` });

await check('le quattro sezioni si aprono, ognuna col suo titolo e il suo numero', async () => {
  // La verifica che il guscio nuovo rende necessaria, e che prima non aveva senso: non c'erano
  // sezioni. Guarda tre cose per ognuna — che si veda, che abbia un titolo, e che la voce sia
  // segnata come corrente — perché una navigazione che apre la pagina sbagliata o che non dice
  // dove sei è peggio di una navigazione che non c'è.
  const attese = [
    ['conversations', 'Conversazioni'],
    ['projects', 'Progetti'],
    ['activity', 'Attività'],
    ['admin', 'Amministrazione'],
  ];
  const viste = [];
  for (const [pagina, nome] of attese) {
    await click(VOCE(pagina), { what: `la voce ${nome}` });
    await sleep(pagina === 'admin' ? 900 : 380);
    const stato = await evaluate(`({
      visibile: !document.getElementById('${pagina === 'admin' ? 'pane-admin' : `page-${pagina}`}').hidden,
      titolo: document.querySelector('${pagina === 'admin' ? '#pane-admin' : `#page-${pagina}`} h1')?.textContent ?? null,
      corrente: document.querySelector('${VOCE(pagina)}').getAttribute('aria-current'),
    })`);
    assert(stato.visibile, `la sezione ${nome} non si vede`);
    assert(stato.titolo === nome, `la sezione ${nome} ha per titolo «${stato.titolo}»`);
    assert(stato.corrente === 'page', `la voce ${nome} non è segnata come quella corrente`);
    viste.push(`${nome} (${stato.titolo})`);
  }

  // Il numero accanto a una voce è un dato, quindi si controlla che lo sia: quello delle
  // conversazioni deve essere il numero delle conversazioni non archiviate, che è la stessa cosa
  // che dice il filtro «tutte» nella pagina.
  await click(VOCE('conversations'), { what: 'la voce Conversazioni' });
  await sleep(380);
  const numeri = await evaluate(`(() => {
    const leggi = (p) => Number(document.querySelector('#nav-tabs .nav-tab[data-page="' + p + '"] .n')?.textContent ?? -1);
    const filtro = document.querySelector('.seg button[data-facet="all"] .n')?.textContent ?? '';
    return { nav: leggi('conversations'), filtro };
  })()`);
  assert(numeri.nav > 0, `la sezione non dichiara quante conversazioni ci sono: ${numeri.nav}`);
  assert(String(numeri.nav) === numeri.filtro, `la testata dice ${numeri.nav} e il filtro dice ${numeri.filtro}`);
  return `${viste.length} sezioni, e il numero della testata è quello del filtro (${numeri.nav})`;
});

await check('le conversazioni sono una pagina, i progetti un\'altra', async () => {
  // Prima questo controllo guardava i progetti nell'elenco a colonna, chiusi per default: era la
  // forma di allora. Adesso l'elenco **è** la pagina delle conversazioni — piatto, in ordine di
  // attività — e i progetti stanno in una pagina loro. Si controlla che siano davvero due pagine,
  // e che una non dipenda dall'altra per esistere.
  await resetList();
  const conversazioni = await evaluate(`({
    righe: document.querySelectorAll('${RIGHE}').length,
    nodi: document.querySelectorAll('#conversations-body *').length,
    progettiVisibili: !document.getElementById('page-projects').hidden,
  })`);
  assert(conversazioni.righe > 100, `righe nell'elenco: ${conversazioni.righe}`);
  assert(!conversazioni.progettiVisibili, 'la pagina dei progetti è visibile insieme a quella delle conversazioni');
  assert(conversazioni.nodi < 12_000, `troppi nodi per un elenco: ${conversazioni.nodi}`);

  await vaiA('projects');
  const progetti = await evaluate(`({
    righe: document.querySelectorAll('${PROGETTI}').length,
    conversazioniVisibili: !document.getElementById('page-conversations').hidden,
  })`);
  assert(progetti.righe > 10, `progetti resi: ${progetti.righe}`);
  assert(!progetti.conversazioniVisibili, 'la pagina delle conversazioni resta visibile sotto quella dei progetti');
  return `${conversazioni.righe} conversazioni in una pagina, ${progetti.righe} progetti nell'altra`;
});

await check('i filtri dichiarano quante conversazioni prendono', async () => {
  const facets = await evaluate(`[...document.querySelectorAll('#conversations-body .seg button')].map((node) => node.textContent.trim())`);
  assert(facets.length === 5, `filtri resi: ${facets.join(' | ')}`);
  const data = await uiFetch('/local/sessions');
  const counts = {
    tutte: data.sessions.filter((session) => !session.archived).length,
    archiviate: data.sessions.filter((session) => session.archived).length,
    preferite: data.sessions.filter((session) => session.favorite && !session.archived).length,
  };
  const shown = facets.join(' ');
  for (const [name, value] of Object.entries(counts)) {
    assert(shown.includes(String(value)), `«${name}» non mostra ${value}: ${shown}`);
  }
  return facets.join(' · ');
});

await check('filtro «archiviate»: solo quelle, con l\'archivio che le riconosce', async () => {
  await resetList();
  const data = await uiFetch('/local/sessions');
  const archived = new Set(data.sessions.filter((session) => session.archived).map((session) => session.name));
  await click(FILTRO('archived'), { what: 'il filtro archiviate' });
  await sleep(250);
  const rows = await evaluate(`[...document.querySelectorAll('${RIGHE} .title')].map((node) => node.textContent)`);
  assert(rows.length > 0, 'il filtro archiviate non ha mostrato niente');
  const strays = rows.filter((name) => !archived.has(name));
  assert(strays.length === 0, `righe non archiviate nel filtro: ${strays.slice(0, 3).join(', ')}`);
  await click(FILTRO('all'), { what: 'il filtro tutte' });
  return `${rows.length} righe, tutte nell'archivio`;
});

await check('una riga di progetto apre le sue conversazioni, e si torna indietro', async () => {
  // Era «un progetto si apre e si chiude»: il progetto non si apre più, si **entra**. La riga dice
  // quante conversazioni ha, e aprirla deve mostrarne esattamente quelle — né una in più né una in
  // meno. Il numero che dichiara è un dato, quindi si confronta col dato.
  await resetList();
  await vaiA('projects');
  const voce = await evaluate(`({
    nome: document.querySelector('${PROGETTI} .title').textContent,
    quante: Number(document.querySelector('${PROGETTI} .count').textContent),
    path: document.querySelector('${PROGETTI}').title,
  })`);
  assert(voce.quante > 0, `il primo progetto dichiara ${voce.quante} conversazioni`);

  await click(PROGETTI, { index: 0, what: 'il primo progetto' });
  await sleep(450);
  const dentro = await evaluate(`({
    titolo: document.querySelector('#conversations-body h1')?.textContent ?? null,
    righe: document.querySelectorAll('${RIGHE}').length,
    progetti: [...new Set([...document.querySelectorAll('${RIGHE} .where')].map((n) => n.textContent))],
  })`);
  assert(dentro.titolo === voce.nome, `la pagina dice «${dentro.titolo}» invece di «${voce.nome}»`);
  assert(dentro.righe === voce.quante, `mostrate ${dentro.righe} conversazioni, il progetto ne dichiara ${voce.quante}`);
  assert(dentro.progetti.length === 1 && dentro.progetti[0] === voce.nome,
    `sono comparse righe di altri progetti: ${dentro.progetti.slice(0, 3).join(', ')}`);

  await click('#conversations-body .page-head .btn', { what: 'tutte le conversazioni' });
  await sleep(400);
  assert(await evaluate(`document.querySelector('#conversations-body h1')?.textContent === 'Conversazioni'`),
    'non si torna a tutte le conversazioni');
  return `«${voce.nome}»: ${dentro.righe} conversazioni, e si torna indietro`;
});

await check('aprire una conversazione: la chat si apre, e la testata dice dove sei', async () => {
  await resetList();
  const name = await evaluate(`document.querySelector('${RIGHE} .title').textContent`);
  await click(RIGHE, { index: 0, what: 'la prima conversazione' });
  await sleep(450);
  const head = await evaluate(`({
    nome: document.getElementById('conv-name').textContent,
    progetto: document.getElementById('conv-project').textContent,
    vista: !document.getElementById('page-session').hidden,
    elenco: document.getElementById('page-conversations').hidden,
    indirizzo: location.hash,
    ritorno: !document.getElementById('conv-back').hidden,
  })`);
  assert(head.vista, 'la conversazione non si è aperta');
  assert(head.elenco, 'l\'elenco resta visibile sotto la conversazione aperta');
  assert(head.nome === name, `la testata dice «${head.nome}», la riga diceva «${name}»`);
  assert(head.progetto.length > 3, `la testata non dice in che progetto è: «${head.progetto}»`);
  assert(/#c=/.test(head.indirizzo), `la conversazione aperta non è scritta nell'indirizzo: «${head.indirizzo}»`);
  assert(head.ritorno, 'non c\'è il modo di tornare indietro dalla conversazione');
  return `«${name}» aperta, scritta nell'indirizzo, con il ritorno`;
});

await check('il menu della conversazione ha le sue voci, e i permessi non stanno più qui', async () => {
  // Il controllo apre **da sé** la conversazione. Prima si reggeva su quella lasciata aperta dal
  // controllo precedente, e da solo cadeva su `#conv-menu-btn` «non trovato o invisibile» — cioè
  // per un motivo che non c'entrava niente con le voci del menu. È la stessa famiglia del passo che
  // saltava in silenzio: un controllo che dipende da dove ha lasciato la pagina quello prima.
  await apriConversazione(0);
  await click('#conv-menu-btn');
  const items = await evaluate(`[...document.querySelectorAll('#menu-layer .menu .row .label')].map((node) => node.textContent)`);
  for (const wanted of ['Sposta in una sezione…', 'Permessi e accesso…', 'Archivia', 'Rinomina', 'Copia l\'id', 'Togli dall\'elenco']) {
    assert(items.includes(wanted), `manca «${wanted}»: ${items.join(' | ')}`);
  }
  // Le tre voci che decidevano i permessi stavano **qui**, in mezzo a «copia l'id», ognuna
  // spiegata in un suggerimento che da telefono non esiste. Adesso c'è una porta sola, e questo
  // controllo lo tiene: se qualcuno le rimette, il banco se ne accorge.
  for (const gone of ['Salta i permessi (bypass)', 'Consenti a ChatGPT', 'MCP automatico controllato',
    'Rimetti i permessi normali', 'Togli a ChatGPT']) {
    assert(!items.includes(gone), `«${gone}» è tornata nel menu: la decisione sui permessi deve stare nella sua schermata`);
  }
  assert(items.includes('Fissa in alto') || items.includes('Togli dalla cima'),
    `manca la voce della stella: ${items.join(' | ')}`);
  // Il dato di prova ha gia' delle conversazioni fissate: prima si toglie, poi si rimette, cosi'
  // si prova il giro completo invece di dipendere da com'era.
  if (items.includes('Togli dalla cima')) {
    await click('#menu-layer .menu .row', { text: 'Togli dalla cima' });
    await sleep(450);
    await click('#conv-menu-btn');
  }
  await click('#menu-layer .menu .row', { text: 'Fissa in alto' });
  await sleep(450);
  const starred = await evaluate(`({
    riga: document.querySelector('#conversations-body .list .row[data-id][data-favorite="true"] .title')?.textContent ?? null,
    testata: document.getElementById('conv-star').getAttribute('aria-pressed'),
  })`);
  assert(starred.riga, 'la stella non è comparsa sulla riga');
  assert(starred.testata === 'true', 'la stella in testata non si è accesa');
  return `${items.length} voci, stella su «${starred.riga}»`;
});

await check('la stella mette la conversazione in cima all\'elenco', async () => {
  // Con l'elenco raggruppato per progetto la stella voleva dire «davanti alle altre **del suo
  // progetto**»; adesso l'elenco è piatto e vuol dire in cima. Il controllo guarda la prima riga
  // dell'elenco, che è l'unica cosa che «fissa in alto» può voler dire.
  await resetList();
  const order = await evaluate(`[...document.querySelectorAll('${RIGHE}')].slice(0, 3).map((row) => ({ nome: row.querySelector('.title').textContent, preferita: row.dataset.favorite }))`);
  assert(order[0].preferita === 'true', `la prima riga non è una fissata: ${JSON.stringify(order)}`);
  const fissate = await evaluate(`[...document.querySelectorAll('${RIGHE}')].filter((r) => r.dataset.favorite === 'true').length`);
  const primaNonFissata = order.findIndex((r) => r.preferita !== 'true');
  assert(primaNonFissata === -1 || primaNonFissata >= 1, `una non fissata sta davanti a una fissata: ${JSON.stringify(order)}`);
  return `prima riga «${order[0].nome}», ${fissate} fissate in cima`;
});

await check('una sezione raggruppa, e il progetto fisico non si sposta', async () => {
  await apriConversazione(0);
  const label = 'm5-verifica';
  const nome = await evaluate(`document.getElementById('conv-name').textContent`);
  const prima = await attendiRegistro(nome, () => true, `«${nome}» non è nel registro`);

  // La stella vince sulla sezione: un preferito sta nel gruppo «fissate», non in quello della sua
  // etichetta — e non in tutt'e due. È la regola che questo controllo verifica qui sotto, e per
  // vederla bisogna prima togliere la stella.
  //
  // E la voce di menu **deve** esserci. Prima questo passo era un `if`: quando la voce non c'era
  // proseguiva in silenzio, e il controllo cadeva tre righe dopo per un motivo che non c'entrava
  // niente. Un controllo che salta un passo senza dirlo è un controllo che mente — ed è il modo in
  // cui questa prova è rimasta rossa per un giro intero senza dire perché.
  await click('#conv-menu-btn');
  const voci = await vociMenu();
  const perLaStella = prima.favorite ? 'Togli dalla cima' : 'Fissa in alto';
  assert(voci.includes(perLaStella), `il registro dice favorite=${prima.favorite}, ma il menu offre: ${voci.join(' | ')}`);
  if (prima.favorite) {
    await click('#menu-layer .menu .row', { text: 'Togli dalla cima' });
    await attendiRegistro(nome, (s) => !s.favorite, 'la stella non si è tolta');
    await click('#conv-menu-btn');
  }

  await click('#menu-layer .menu .row', { text: 'Sposta in una sezione' });
  await typeIn('#dialog-layer .dialog input', label);
  await click('#dialog-layer .dialog .btn-primary', { what: 'conferma la sezione' });
  const session = await attendiRegistro(nome, (s) => s.label === label, `l'etichetta non è arrivata al registro: ${nome}`);
  assert(session, `l'etichetta non è arrivata al registro: ${nome}`);

  // Aprire una conversazione ne accende il processo, ed è voluto: la chat si apre viva. Ma una
  // conversazione accesa si disegna nella scheda «Adesso», che **non ha sezioni** — lì il titolo è
  // «Adesso» e basta — e allora la sezione non comparirebbe per un motivo che non c'entra niente
  // con quello che questo controllo prova. (È esattamente il motivo per cui era rossa: la
  // conversazione era accesa, e nell'elenco raggruppato non c'era.)
  // Quindi il processo si spegne, dalla voce di menu che userebbe una persona, e si **pretende**
  // che sia spento prima di guardare: senza questo, l'assert qui sotto accuserebbe il
  // raggruppamento per un fatto che sta da un'altra parte.
  await attendi(`!document.querySelector('#dialog-layer .dialog')`, 'la finestra della sezione è rimasta aperta');
  await click('#conv-menu-btn');
  const dopoLaSezione = await vociMenu();
  assert(dopoLaSezione.includes('Spegni il processo'),
    `aprire la conversazione non ha acceso nessun processo: il menu offre ${dopoLaSezione.join(' | ')}`);
  await click('#menu-layer .menu .row', { text: 'Spegni il processo' });
  await attendiRegistro(nome, (s) => !['ready', 'starting', 'busy'].includes(s.state), 'il processo non si è spento');

  // La sezione si vede nell'elenco: un titolo di gruppo, con dentro la conversazione. Le sezioni
  // si erano perse passando dall'elenco a colonna alla pagina — si poteva ancora dare un'etichetta
  // e non si vedeva più da nessuna parte — e questo controllo è quello che se ne accorge.
  await resetList();
  // L'etichetta è già nel registro (l'assert qui sopra), ma l'elenco si ridisegna quando il server
  // rimanda lo stato: fra la scrittura e il disegno c'è un giro di rete. Si aspetta **quello che
  // deve comparire**, non un tempo fisso.
  await attendi(
    `[...document.querySelectorAll('#conversations-body .group-head')].some((n) => n.textContent === ${js(label)})`,
    `la sezione «${label}» non compare nell'elenco`,
  ).catch(async (error) => {
    throw new Error(`${error.message} — gruppi disegnati: ${JSON.stringify(await gruppiDisegnati())}`);
  });

  const gruppi = await gruppiDisegnati();
  const sezioni = Object.keys(gruppi).filter((titolo) => titolo !== '(senza intestazione)');
  assert(gruppi[label], `nessuna sezione «${label}» nell'elenco: ${sezioni.join(', ') || 'nessuna'}`);
  assert(gruppi[label].includes(nome), `«${nome}» non sta nella sezione «${label}»: ${JSON.stringify(gruppi[label])}`);
  // E non è in doppia copia: la stella l'avrebbe portato fra le fissate, e la stella **sposta**,
  // non duplica. Una conversazione in due gruppi diversi è la prima cosa che fa sembrare rotto un
  // elenco raggruppato.
  assert(!(gruppi.fissate ?? []).includes(nome), `«${nome}» è anche fra le fissate: la stella lo sposta, non lo duplica`);

  // E la cartella non si è spostata: l'etichetta è organizzazione, non un trasloco.
  const dopo = await uiFetch('/local/sessions');
  const riga = dopo.sessions.find((entry) => entry.name === nome);
  assert(riga.label === label, `l'etichetta è cambiata: ${riga.label}`);
  assert(riga.projectPath === prima.projectPath, 'il progetto fisico è cambiato: non doveva');
  assert(riga.sessionId === prima.sessionId, 'la conversazione è cambiata: non doveva');
  return `«${nome}» in «${label}», e non fra le fissate: cartella invariata`;
});

await check('il menu del progetto rinomina senza toccare la cartella', async () => {
  // Il menu di un progetto si trova **nella sua pagina**: prima era un comando dentro l'elenco a
  // colonna, che stava in vista insieme alle conversazioni.
  await resetList();
  await vaiA('projects');
  await click(projectMenuButton, { what: 'menu del progetto' });
  const items = await evaluate(`[...document.querySelectorAll('#menu-layer .menu .row .label')].map((node) => node.textContent)`);
  for (const wanted of ['Apri la cartella sul PC', 'Copia il percorso', 'Rinomina il progetto', 'Progetto preferito',
    'Nascondi dall\'elenco', 'Dimentica il progetto']) {
    assert(items.includes(wanted), `manca «${wanted}»: ${items.join(' | ')}`);
  }
  await click('#menu-layer .menu .row', { text: 'Rinomina il progetto' });
  await typeIn('#dialog-layer .dialog input', 'Cliente Rossi');
  await click('#dialog-layer .dialog .btn-primary', { what: 'rinomina il progetto' });
  await sleep(500);
  const renamed = await evaluate(`(() => {
    const project = document.querySelector('${PROGETTI}');
    return { nome: project.querySelector('.title').textContent, percorso: project.title };
  })()`);
  assert(renamed.nome === 'Cliente Rossi', `il nome mostrato è «${renamed.nome}»`);
  assert(renamed.percorso.includes('progetto-'), `il percorso non è più quello vero: ${renamed.percorso}`);
  return `«${renamed.nome}» sopra ${renamed.percorso}`;
});

await check('stella e «nascondi» sul progetto, con il modo di farlo tornare', async () => {
  await vaiA('projects');
  const path = await evaluate(`document.querySelector('${PROGETTI}').title`);
  const stellaDi = (p) => `Boolean([...document.querySelectorAll('${PROGETTI}')].find((r) => r.title === ${js(p)})?.querySelector('.star'))`;
  const starredBefore = await evaluate(stellaDi(path));
  await click(projectMenuButton);
  await click('#menu-layer .menu .row', { text: 'Progetto preferito' });
  await sleep(450);
  const starredAfter = await evaluate(stellaDi(path));
  assert(starredAfter !== starredBefore, 'la stella del progetto non è cambiata');

  await click(projectMenuButton);
  const before = await evaluate(`document.querySelectorAll('#projects-body .list .row').length`);
  await click('#menu-layer .menu .row', { text: 'Nascondi dall\'elenco' });
  await sleep(450);
  const after = await evaluate(`document.querySelectorAll('${PROGETTI}').length`);
  assert(after === before - 1, `nascosto: i progetti sono passati da ${before} a ${after}`);

  // Il modo di farli tornare. Prima era un collegamento in fondo a una colonna; adesso è un
  // interruttore dichiarato, con il numero accanto — che è meglio: dice **quanti** sono prima di
  // premerlo.
  const contaNascosti = await evaluate(`[...document.querySelectorAll('#projects-body button[data-show]')].map((b) => b.textContent.trim())`);
  assert(contaNascosti.some((t) => t.startsWith('anche i nascosti')), `l'interruttore dei nascosti non c'è: ${contaNascosti.join(' · ')}`);
  await click('#projects-body button[data-show]', { text: 'anche i nascosti', what: 'anche i nascosti' });
  await sleep(350);
  const back = await evaluate(`document.querySelectorAll('${PROGETTI}[data-hidden="true"]').length`);
  assert(back > 0, 'i progetti messi via non si rivedono');
  await click('#projects-body button[data-show]', { text: 'nascondi i nascosti', what: 'solo i visibili' });
  await sleep(250);
  return `via e di nuovo qui (${back} con l\'etichetta «nascosto»)`;
});

await check('le voci di prova non occupano la schermata dei progetti', async () => {
  // Il difetto più grosso dell'audit: nel registro vero 64 metadati di prova stavano **davanti** alle
  // 9 cartelle vere — nove dei quali con lo stesso nome e lo stesso percorso troncato, cioè
  // indistinguibili — e i progetti veri finivano sotto la piega. Il banco ne semina otto della
  // stessa forma (`tools/seed-demo.mjs`: nessuna conversazione, nome che il codice di produzione
  // non scrive).
  await vaiA('projects');
  const forma = await evaluate(`(() => {
    const righe = [...document.querySelectorAll('#projects-body .list .row')].map((node) => node.title);
    const nota = document.querySelector('#projects-body .note.tests');
    const card = document.querySelector('#projects-body .card');
    const sotto = nota ? nota.getBoundingClientRect().top > card.getBoundingClientRect().bottom - 1 : false;
    const interruttore = [...document.querySelectorAll('#projects-body button[data-tests]')].map((b) => b.textContent.trim());
    return {
      righe,
      finte: righe.filter((p) => /cc-remote-e2e-/.test(p)).length,
      testoNota: nota?.textContent ?? null,
      sotto,
      interruttore,
      scelteFinte: document.querySelectorAll('#projects-body .seg button[data-tests]').length,
    };
  })()`);
  assert(forma.finte === 0, `le voci di prova sono in elenco: ${forma.righe.filter((p) => /cc-remote-e2e-/.test(p)).join(', ')}`);
  assert(forma.testoNota, 'le voci di prova non sono nemmeno nominate: si nascondono e basta, e chi non sa non lo scopre');
  assert(/8 voci di prova nascoste/.test(forma.testoNota), `la riga non dice quante sono e che sono nascoste: «${forma.testoNota}»`);
  // **In fondo**, non in testa: è il punto del difetto — un blocco sopra spinge i progetti veri
  // sotto la piega.
  assert(forma.sotto, 'la riga delle voci di prova non sta sotto l\'elenco dei progetti');
  // E non si legge come una scelta fra tre: era un filtro e due conteggi nella forma di tre pillole.
  assert(forma.scelteFinte === 0, 'le voci di prova tornano a essere un filtro a segmenti');

  await shot('progetti-voci-di-prova');
  await click('#projects-body button[data-tests]', { what: 'mostra le voci di prova' });
  await sleep(350);
  const mostrate = await evaluate(`[...document.querySelectorAll('#projects-body .list .row')].filter((n) => /cc-remote-e2e-/.test(n.title)).length`);
  assert(mostrate === 8, `«mostrale» ne ha mostrate ${mostrate} invece di 8`);
  await click('#projects-body button[data-tests]', { what: 'nascondi di nuovo le voci di prova' });
  await sleep(350);
  assert(
    await evaluate(`[...document.querySelectorAll('#projects-body .list .row')].every((n) => !/cc-remote-e2e-/.test(n.title))`),
    'non si sono più nascoste',
  );
  // E il numero accanto a «Progetti» nella testata è quello che si vede: era 29 con 21 righe in
  // pagina, perché il conto della testata non sapeva delle voci di prova.
  const conti = await evaluate(`({
    testata: Number(document.querySelector('#nav-tabs .nav-tab[data-page="projects"] .n')?.textContent ?? NaN),
    pagina: Number(document.querySelector('#projects-body .toolbar .count')?.textContent.match(/\\d+/)?.[0] ?? NaN),
    righe: document.querySelectorAll('#projects-body .list .row').length,
  })`);
  assert(conti.testata === conti.righe, `la testata dice ${conti.testata} progetti, la pagina ne mostra ${conti.righe}`);
  assert(conti.pagina === conti.righe, `il conteggio in pagina dice ${conti.pagina} e le righe sono ${conti.righe}`);
  return `8 voci di prova fuori dall'elenco, in una riga sotto i progetti, e si mostrano a richiesta — testata e pagina dicono ${conti.testata}`;
});

await check('una riga con un nome lungo tiene dentro i suoi comandi', async () => {
  // Il difetto trovato guardando i **dati veri**, non il banco: le conversazioni del proprietario
  // hanno nomi lunghi («Accensione automatica del computer»), quelle del seme no. Su 30 righe su 84,
  // a 320px, il pulsante «⋯» finiva a x=328 — fuori da uno schermo largo 320, e tagliato via senza
  // che la pagina scorresse (ci pensa l'`overflow: hidden` della scheda a nasconderlo). La causa: la
  // riga è un elemento flessibile con `width: 100%` e `min-width: auto`, quindi non poteva
  // rimpicciolirsi per fare posto al pulsante.
  //
  // Il nome lungo lo mette il controllo, con gli stessi comandi che userebbe una persona: nel banco
  // non c'è, e senza questo caso il difetto non si sarebbe mai visto.
  // Sessanta caratteri: è il tetto del nome, e sono comunque il doppio di quelli del seme.
  const LUNGO = 'Accensione automatica del computer e spegnimento';
  await resetList();
  await click('#conversations-body .list li .menu-btn', { index: 0, what: 'il menu della prima riga' });
  await click('#menu-layer .menu .row', { text: 'Rinomina', what: 'la voce Rinomina' });
  await typeIn('#dialog-layer .dialog input', LUNGO);
  await click('#dialog-layer .dialog .btn-primary', { what: 'rinomina' });
  await attendi(
    `document.querySelector('#conversations-body .list .row[data-id] .title')?.textContent ?? ''`,
    'la conversazione non è stata rinominata',
    { ok: (nome) => nome === LUNGO },
  );

  const misure = [];
  for (const [larghezza, altezza, mobile] of [[320, 844, true], [390, 844, true], [768, 900, false], [1440, 900, false]]) {
    await viewport(larghezza, altezza, { mobile });
    await sleep(250);
    const fuori = await evaluate(`(() => {
      const righe = [...document.querySelectorAll('#conversations-body .list li')].filter((li) => li.querySelector('.row[data-id]'));
      const oltre = [];
      for (const li of righe) {
        const r = li.getBoundingClientRect();
        for (const nodo of li.children) {
          const b = nodo.getBoundingClientRect();
          if (b.right > r.right - 15) oltre.push({ chi: nodo.className, destra: Math.round(b.right), li: Math.round(r.right) });
        }
      }
      return { quante: righe.length, oltre: oltre.slice(0, 4), documento: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    })()`);
    assert(fuori.quante > 0, 'l\'elenco è vuoto: il controllo non sta guardando niente');
    assert(fuori.oltre.length === 0, `a ${larghezza}px i comandi di una riga escono dalla riga: ${JSON.stringify(fuori.oltre)}`);
    assert(fuori.documento <= 1, `a ${larghezza}px la pagina scorre di lato di ${fuori.documento}px`);
    misure.push(`${larghezza}px ${fuori.quante} righe`);
  }
  await viewport(1440, 900);
  return `un nome di ${LUNGO.length} caratteri: comandi dentro la riga a ${misure.join(' · ')}`;
});

await check('a nessuna larghezza la pagina scorre in orizzontale', async () => {
  // Il controllo che c'era prima misurava il trascinamento della colonna laterale, che non esiste
  // più. Questo misura la cosa che conta adesso, ed è più severo: **cinque** larghezze, i due temi,
  // e la pagina delle conversazioni e quella dei progetti — perché una pagina a tutta larghezza ha
  // più modi di sbordare di una colonna da 296px.
  const misure = [];
  for (const [larghezza, altezza] of [[320, 720], [390, 844], [768, 1024], [1024, 768], [1440, 900]]) {
    await viewport(larghezza, altezza);
    await sleep(250);
    for (const pagina of ['conversations', 'projects', 'activity']) {
      await vaiA(pagina);
      const sborda = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
      misure.push({ larghezza, pagina, sborda });
    }
  }
  await viewport(1440, 900);
  const peggio = misure.filter((m) => m.sborda > 1);
  assert(peggio.length === 0, `sborda: ${peggio.map((m) => `${m.pagina}@${m.larghezza}px +${m.sborda}`).join(' · ')}`);
  return `${misure.length} misure su 5 larghezze × 3 pagine, tutte dentro`;
});

await check('la ricerca filtra mentre si scrive, e il fuoco resta nel campo', async () => {
  await resetList();
  const total = await evaluate(`document.querySelectorAll('${RIGHE}').length`);
  await click(CAMPO, { what: 'il campo di ricerca' });

  // Si scrive **lettera per lettera**, come farebbe una persona. È l'unico modo di accorgersi di un
  // difetto che nessun altro controllo vedeva: il campo veniva ricostruito a ogni tasto, quindi
  // perdeva il fuoco, e la seconda lettera finiva nel vuoto. Con `typeIn` tutto in una volta il
  // fuoco non serve, e il difetto resta invisibile.
  for (const lettera of 'restyling') {
    const attuale = await evaluate(`document.querySelector('${CAMPO}').value`);
    await typeIn(CAMPO, attuale + lettera);
    await sleep(90);
  }
  const filtrato = await evaluate(`(() => {
    const campo = document.querySelector('${CAMPO}');
    return {
      valore: campo.value,
      fuoco: document.activeElement === campo,
      righe: [...document.querySelectorAll('${RIGHE} .title')].map((node) => node.textContent),
    };
  })()`);
  assert(filtrato.fuoco, 'il campo di ricerca perde il fuoco mentre si scrive');
  assert(filtrato.valore === 'restyling', `nel campo c'è «${filtrato.valore}» invece di «restyling»`);
  assert(filtrato.righe.length < total, `la ricerca non ha filtrato: ${filtrato.righe.length} righe su ${total}`);
  assert(filtrato.righe.every((name) => name.toLowerCase().includes('restyling')),
    `la ricerca ha lasciato righe che non c'entrano: ${filtrato.righe.slice(0, 3).join(', ')}`);

  // E svuotandola l'elenco torna intero: un filtro che non si toglie è una conversazione persa.
  await typeIn(CAMPO, '');
  await sleep(400);
  const dopo = await evaluate(`document.querySelectorAll('${RIGHE}').length`);
  assert(dopo === total, `svuotando la ricerca le righe sono ${dopo} invece di ${total}`);
  return `${filtrato.righe.length} su ${total}, e il fuoco resta nel campo`;
});

await check('la ricerca dentro i messaggi si chiede, e trova', async () => {
  await typeIn('#conversations-body input[type="search"]', 'riordiniamo');
  await sleep(350);
  await click('.side-note .link-btn', { what: 'cerca nei messaggi' });
  const trovati = Date.now() + 10_000;
  while (Date.now() < trovati && await evaluate(`document.querySelectorAll('.search-hits .hit').length === 0`)) {
    await sleep(200);
  }
  const result = await evaluate(`({
    intestazione: document.querySelector('.search-hits .section-head')?.textContent ?? null,
    risultati: [...document.querySelectorAll('.search-hits .hit')].map((node) => node.textContent),
    nota: document.querySelector('#projects .side-note')?.textContent ?? null,
  })`);
  assert(result.intestazione, `la ricerca nel contenuto non ha mostrato niente (${result.nota})`);
  assert(result.risultati.length > 0, `nessun risultato dal transcript (${JSON.stringify(await uiFetch('/local/search?q=riordiniamo'))})`);
  assert(result.risultati[0].toLowerCase().includes('riordiniamo'), `il risultato non contiene la parola: ${result.risultati[0]}`);
  await shot('desktop-chiaro-ricerca-nei-messaggi');
  return result.intestazione;
});

await check('dalla ricerca si apre la conversazione trovata', async () => {
  // La si rifà da capo: un risultato che resta a schermo da un controllo all'altro è comodo,
  // ma qui si vuole provare il giro intero (parola → ricerca → clic → chat).
  await resetList();
  await typeIn('#conversations-body input[type="search"]', 'riordiniamo');
  await sleep(350);
  await click('.side-note .link-btn', { what: 'cerca nei messaggi' });
  const trovati = Date.now() + 10_000;
  while (Date.now() < trovati && await evaluate(`document.querySelectorAll('.search-hits .hit').length === 0`)) {
    await sleep(200);
  }
  const origin = await evaluate(`performance.timeOrigin`);
  await click('.search-hits .hit', { what: 'un risultato' });
  await sleep(300);
  const dopoOrigin = await evaluate(`performance.timeOrigin`);
  if (dopoOrigin !== origin) throw new Error(`la pagina si è ricaricata cliccando un risultato (${await evaluate(`location.href`)}`);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && await evaluate(`document.querySelectorAll('#messages .turn').length === 0`)) {
    await sleep(200);
  }
  const head = await evaluate(`({ nome: document.getElementById('conv-name').textContent, messaggi: document.querySelectorAll('#messages .turn').length })`);
  assert(head.nome, 'la conversazione non si è aperta');
  if (head.messaggi === 0) {
    const dump = await evaluate(`JSON.stringify({
      titolo: document.title,
      testata: document.getElementById('conv-name').textContent,
      progetti: document.querySelectorAll('#projects-body .list .row').length,
      filtri: [...document.querySelectorAll('#conversations-body .seg button[aria-pressed="true"]')].map((n) => n.textContent),
      avviso: document.getElementById('toast').hidden ? null : document.getElementById('toast').textContent,
      riquadro: document.querySelector('#messages li')?.className ?? null,
      connesso: document.getElementById('conn-text').textContent,
      indirizzo: location.href,
    })`);
    throw new Error(`la chat non ha mostrato i suoi messaggi: ${dump}`);
  }
  await resetList();
  return `«${head.nome}» con ${head.messaggi} turni`;
});

await check('archiviare toglie dall\'elenco, e l\'archivio lo ritrova', async () => {
  await resetList();
  await click('#conversations-body .list .row[data-id]', { index: await convIndex(1, 0), what: 'una conversazione da archiviare' });
  await sleep(300);
  const name = await evaluate(`document.getElementById('conv-name').textContent`);
  await click('#conv-menu-btn');
  await click('#menu-layer .menu .row', { text: 'Archivia' });
  await sleep(450);
  // Si torna all'elenco **prima** di guardarlo: archiviando dal menu della conversazione la chat
  // resta aperta, e la pagina delle conversazioni è ferma a com'era prima — leggerla lì vuol dire
  // leggere un disegno vecchio e dichiarare che l'archiviazione non ha funzionato.
  await resetList();
  const stillHere = await evaluate(`[...document.querySelectorAll('${RIGHE} .title')].some((node) => node.textContent === ${js(name)})`);
  assert(!stillHere, `«${name}» è ancora in «tutte»`);
  await click(FILTRO('archived'), { what: 'il filtro archiviate' });
  await sleep(350);
  const inArchive = await evaluate(`[...document.querySelectorAll('#conversations-body .list .row[data-id] .title')].some((node) => node.textContent === ${js(name)})`);
  assert(inArchive, `«${name}» non è finita nell'archivio`);
  await click(FILTRO('all'), { what: 'il filtro tutte' });
  return `«${name}» archiviata e ritrovata`;
});

await check('i filtri si combinano, e il numero che resta è quello giusto', async () => {
  // Prende il posto di «solo il progetto aperto», che era un modo di restringere l'elenco a un
  // progetto: adesso quel mestiere lo fa la pagina dei progetti. Quello che mancava, e che serve,
  // è la prova che i filtri si **moltiplicano** invece di sostituirsi — stato, data e progetto —
  // e che il numero mostrato sia quello vero, calcolato dal registro e non dalla pagina.
  await resetList();
  const dati = await uiFetch('/local/sessions');
  const trenta = Date.now() - 30 * 86_400_000;

  await click('#when-btn', { what: 'il filtro per data' });
  await click('#menu-layer .menu .row', { text: 'ultimi 30 giorni' });
  await sleep(450);
  const conData = await evaluate(`document.querySelectorAll('${RIGHE}').length`);
  const atteseData = dati.sessions.filter((s) => !s.archived
    && Date.parse(s.lastActivityAt ?? s.createdAt) >= trenta).length;
  assert(conData === atteseData, `con la data accesa le righe sono ${conData}, il registro ne ha ${atteseData}`);

  // E sopra la data si accende un filtro di stato: devono restringere, non allargare.
  const inData = new Set(dati.sessions.filter((s) => !s.archived
    && Date.parse(s.lastActivityAt ?? s.createdAt) >= trenta).map((s) => s.name));
  await click(FILTRO('favorite'), { what: 'il filtro preferite' });
  await sleep(450);
  const { righe, data } = await evaluate(`({
    righe: [...document.querySelectorAll('${RIGHE} .title')].map((n) => n.textContent),
    data: document.querySelector('#when-btn') !== null,
  })`);
  assert(righe.length <= conData, `combinando i filtri le righe sono aumentate: ${conData} → ${righe.length}`);
  assert(righe.every((name) => inData.has(name)), `sono comparse righe fuori dai 30 giorni: ${righe.slice(0, 3).join(', ')}`);
  assert(data, 'il filtro per data si è spento da solo combinando con un altro');

  await click(FILTRO('all'), { what: 'il filtro tutte' });
  await click('#when-btn', { what: 'il filtro per data' });
  await click('#menu-layer .menu .row', { text: 'qualsiasi data' });
  await sleep(450);
  const dopo = await evaluate(`document.querySelectorAll('${RIGHE}').length`);
  assert(dopo > conData, `togliendo il filtro per data l'elenco non è tornato: ${dopo} righe`);
  return `30 giorni: ${conData} righe · con le preferite: ${righe.length} · senza data: ${dopo}`;
});

await check('Ctrl+K apre la ricerca da qualunque punto, e Esc la svuota', async () => {
  await resetList();
  await press('k', { ctrl: true });
  assert(await evaluate(`document.activeElement.id`) === 'filter', 'Ctrl+K non ha portato il fuoco sulla ricerca');
  await typeIn('#conversations-body input[type="search"]', 'qualcosa');
  await press('Escape');
  assert(await evaluate(`document.getElementById('filter').value`) === '', 'Esc non ha svuotato la ricerca');
  await press('Escape');
  return 'fuoco sulla ricerca, il primo Esc svuota e il secondo non rompe niente';
});

await check('Ctrl+K col terminale a fuoco: apre la ricerca e non finisce nel TUI', async () => {
  await resetList();
  await click('#conversations-body .list .row[data-id]', { index: await convIndex(0, 0), what: 'una conversazione' });
  await sleep(400);
  await click('#tab-terminal');
  await sleep(800);
  // Il fuoco dove sta xterm: è lì che i tasti finiscono quando si usa il terminale.
  await evaluate(`document.querySelector('#screen .xterm-helper-textarea')?.focus()`);

  // Controllo: un tasto normale **deve** arrivare al terminale remoto, altrimenti non si sta
  // provando niente (la TUI finta risponde `ECHO "..."` a ogni cosa che riceve).
  const read = `document.querySelector('#screen .xterm-rows')?.textContent ?? ''`;
  // Il controllo: qualunque traccia nel riquadro va bene — la TUI finta risponde `ECHO "..."`, e
  // il suo conhost (che non è in raw mode) rilancia il carattere. Quello che conta è che il tasto
  // sia *arrivato*, cioè che il riquadro sia cambiato.
  // Il controllo che rende questa prova non vuota: **un tasto normale deve arrivare** al terminale
  // remoto. Si preme e si aspetta che il riquadro cambi — non si pretende che ci fosse già qualcosa
  // scritto: quello dipende da cosa è successo prima nella sessione, e legare la prova a
  // quell'intreccio è il modo di farla fallire per un motivo che non c'entra.
  const diagnosis = `(async () => {
    const data = await fetch('/local/sessions', { headers: { 'x-cc-remote-token': ${js(token)} } }).then((response) => response.json());
    const name = document.getElementById('conv-name').textContent;
    const found = data.sessions.find((session) => session.name === name);
    return JSON.stringify({ aperta: name, stato: found?.state, importata: found?.imported, righe: document.querySelectorAll('#screen .xterm-rows div').length });
  })()`;

  const quiet = await evaluate(read);
  await press('x');
  let control = quiet;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && control === quiet) {
    await sleep(300);
    control = await evaluate(read);
  }
  assert(control !== quiet, `il terminale non riceve più i tasti: nel riquadro c'è ${JSON.stringify(control.slice(-120))} — ${await evaluate(diagnosis)}`);

  const kills = (text) => (text.match(/u000b|u000B/g) ?? []).length;
  const before = kills(await evaluate(read));
  await press('k', { ctrl: true });
  const focused = await evaluate(`document.activeElement.id`);
  assert(focused === 'filter', `col terminale a fuoco Ctrl+K non apre la ricerca (fuoco su «${focused}»)`);
  await sleep(400);
  const after = kills(await evaluate(read));
  assert(after === before, 'Ctrl+K è finito nel terminale remoto (nel TUI sarebbe «cancella riga»)');
  // Ctrl+K porta alla ricerca, che è una **pagina**: quindi la conversazione si chiude, ed è il
  // comportamento voluto — una scorciatoia che porta dove si cerca. Non si torna alla scheda Chat
  // perché non c'è più niente a cui tornare; la riga resta segnata, e riaprirla è un clic.
  assert(await evaluate(`!document.getElementById('page-conversations').hidden`),
    'Ctrl+K non ha portato alla pagina delle conversazioni');
  assert(await evaluate(`document.getElementById('page-session').hidden`),
    'Ctrl+K ha lasciato la conversazione aperta sotto la ricerca');
  return 'si apre la ricerca, il TUI non vede il tasto, e si è sulla pagina delle conversazioni';
});

await check('«/» apre la ricerca, e non ruba il tasto a chi sta scrivendo', async () => {
  // Due mestieri, e adesso sono due contesti diversi invece di uno solo. Fuori da una
  // conversazione la barra apre la ricerca (all\'altezza di Ctrl+K). Dentro, la barra **è** un
  // carattere: portare via la pagina a chi sta scrivendo per aprire una ricerca sarebbe il modo di
  // far perdere un messaggio a metà. Il controllo prova tutti e due, e prova che il carattere
  // arriva davvero nel campo invece di sparire.
  await resetList();
  await click(CAMPO, { what: 'il campo di ricerca' });
  await evaluate(`document.querySelector('${CAMPO}').blur()`);
  await press('/');
  assert(await evaluate(`document.activeElement.id`) === 'filter', '«/» non ha aperto la ricerca');

  await apriConversazione(0);
  const prima = await evaluate(`document.getElementById('composer-text').value`);
  await evaluate(`(() => { const field = document.getElementById('composer-text'); field.focus(); return true })()`);
  await press('/', { shift: true });
  const dopo = await evaluate(`({
    fuoco: document.activeElement.id,
    testo: document.getElementById('composer-text').value,
    sessione: !document.getElementById('page-session').hidden,
  })`);
  assert(dopo.sessione, 'la barra ha chiuso la conversazione: chi stava scrivendo ha perso il messaggio');
  assert(dopo.fuoco === 'composer-text', `la barra ha portato via il fuoco dal campo di scrittura (fuoco su «${dopo.fuoco}», conversazione aperta: ${dopo.sessione}, visore del campo: ${await evaluate(`(() => { const r = document.getElementById('composer-text').getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })()`)}`);
  assert(dopo.testo.includes('/'), `la barra non è finita nel messaggio: «${dopo.testo}»`);
  assert(dopo.testo.length >= prima.length, `il campo è stato svuotato: «${prima}» → «${dopo.testo}»`);
  await evaluate(`(() => { document.getElementById('composer-text').value = ''; return true })()`);
  return 'fuori apre la ricerca, dentro scrive la barra e non chiude la conversazione';
});

await check('se la sessione finisce, il terminale lo dice invece di restare muto', async () => {
  await resetList();
  await click('#conversations-body .list .row[data-id]', { index: await convIndex(1, 0), what: 'una conversazione' });
  await sleep(400);
  const id = await evaluate(`(async () => {
    const data = await fetch('/local/sessions', { headers: { 'x-cc-remote-token': ${js(token)} } }).then((response) => response.json());
    return data.sessions.find((session) => session.name === document.getElementById('conv-name').textContent)?.sessionId ?? null;
  })()`);
  assert(id, 'non ho trovato la sessione aperta');

  // La TUI finta esce quando riceve «exit»: da fuori è un processo che muore.
  await typeIn('#composer-text', 'exit');
  await click('#send', { what: 'invia' });
  await click('#tab-terminal');
  await sleep(500);

  const deadline = Date.now() + 20_000;
  let shown = '';
  while (Date.now() < deadline) {
    shown = await evaluate(`document.querySelector('#screen .xterm-rows')?.textContent ?? ''`);
    if (shown.includes('la sessione è finita')) break;
    await sleep(300);
  }
  assert(shown.includes('la sessione è finita'), 'il terminale è rimasto muto su una sessione finita');
  const state = await evaluate(`(async () => (await fetch('/local/sessions', { headers: { 'x-cc-remote-token': ${js(token)} } }).then((response) => response.json())).sessions.find((session) => session.sessionId === ${js(id)})?.state ?? null)()`);
  assert(state === 'exited', `lo stato dice «${state}» invece di «exited»`);
  // E la scheda Terminale lo dice anche fuori dal riquadro: un terminale vuoto senza spiegazione
  // è la cosa che fa sembrare rotta un'applicazione che sta funzionando.
  const note = await evaluate(`({ visibile: !document.getElementById('term-note').hidden, testo: document.getElementById('term-note').textContent })`);
  assert(note.visibile, 'il terminale non dice che il processo di questa conversazione è finito');
  assert(/accendi il processo/i.test(note.testo), `la nota non dice cosa fare: «${note.testo}»`);
  await shot('terminale-spento');
  await click('#tab-chat');
  return 'la finestra lo dice, lo stato è «exited», e la nota dice come riaccenderla';
});

await check('i temi chiaro e scuro sono due progetti, non un\'inversione', async () => {
  await viewport(1440, 900, { dark: false });
  await shot('desktop-chiaro');
  await viewport(1440, 900, { dark: true });
  await shot('desktop-scuro');
  const colors = await evaluate(`(() => {
    const style = getComputedStyle(document.documentElement);
    return { bg: style.getPropertyValue('--bg').trim(), surface: style.getPropertyValue('--surface').trim() };
  })()`);
  assert(colors.bg !== 'oklch(98.6% 0.003 260)', `il tema scuro non è stato applicato: --bg è ${colors.bg}`);
  return `scuro: --bg ${colors.bg} · --surface ${colors.surface}`;
});

await check('il terminale resta raggiungibile', async () => {
  // Le schede chat/terminale sono **di una conversazione**: senza una aperta non esistono, e da solo
  // questo controllo cadeva su `#tab-terminal` «non trovato o invisibile».
  await apriConversazione(0);
  await click('#tab-terminal');
  await sleep(700);
  const term = await evaluate(`({ visibile: !document.getElementById('pane-term').hidden, chat: document.getElementById('pane-chat').hidden, righe: document.querySelectorAll('#screen .xterm-rows > div').length })`);
  assert(term.visibile, 'la scheda terminale non si apre');
  assert(term.chat, 'la chat non si è tolta di mezzo');
  await click('#tab-chat');
  return `xterm con ${term.righe} righe disegnate`;
});

await check('da telefono: le quattro sezioni ci sono, e niente è più piccolo di un dito', async () => {
  // Il controllo che c'era prima apriva il **cassetto**, che non esiste più. Quello che conta
  // adesso è la cosa che il cassetto sostituiva: da un telefono si arriva a tutte le sezioni. La
  // prima versione del guscio le schiacciava a larghezza zero su una riga sola, e da telefono il
  // prodotto aveva una pagina sola — ecco perché questa prova guarda la **larghezza** delle voci,
  // non solo che esistano.
  await viewport(390, 844, { mobile: true, dark: false });
  await goto({ waitFor: `document.querySelectorAll('${RIGHE}').length > 0` });
  await sleep(600);
  const atStart = await evaluate(`({
    conversazioni: !document.getElementById('page-conversations').hidden,
    righe: document.querySelectorAll('${RIGHE}').length,
    voci: [...document.querySelectorAll('.nav-tab')].map((b) => ({ testo: b.textContent.trim(), largo: Math.round(b.getBoundingClientRect().width) })),
  })`);
  assert(atStart.righe > 0, 'da telefono l\'elenco è vuoto');
  assert(atStart.conversazioni, 'da telefono non si atterra sulle conversazioni');
  const strette = atStart.voci.filter((v) => v.largo < 44);
  assert(strette.length === 0, `voci della testata troppo strette per un dito: ${strette.map((v) => `${v.testo} ${v.largo}px`).join(', ')}`);

  const small = await evaluate(`(() => [...document.querySelectorAll('.nav button, #conversations-body .list .row, #conversations-body .seg button, #conv-back')]
    .filter((node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.height < 40; })
    .map((node) => node.getAttribute('aria-label') ?? node.textContent.trim().slice(0, 24)))()`);
  assert(small.length === 0, `bersagli troppo piccoli per un dito: ${small.slice(0, 4).join(', ')}`);
  await shot('telefono-chiaro-conversazioni');

  await apriConversazione(0);
  assert(await evaluate(`!document.getElementById('page-session').hidden`), 'da telefono una conversazione non si apre');
  await shot('telefono-chiaro-chat');

  await vaiA('projects');
  assert(await evaluate(`document.querySelectorAll('${PROGETTI}').length > 0`), 'da telefono la pagina dei progetti è vuota');
  await shot('telefono-chiaro-progetti');

  await viewport(390, 844, { mobile: true, dark: true });
  await vaiA('conversations');
  await sleep(250);
  await shot('telefono-scuro-conversazioni');
  return `quattro sezioni raggiungibili (${atStart.voci.map((v) => v.testo.split(' ')[0]).join(', ')}), bersagli da 44px`;
});

// ── Il menu si apre dove sta il suo pulsante ────────────────────────────────────────────────
// Il difetto numero uno dell'audit di M9, misurato: **ogni** menu si apriva a `left: 8px`, largo
// quanto il contenuto ma posizionato con la misura della pagina. Qui si asserisce la causa, a tre
// larghezze e su due menu diversi — quello di una riga dell'elenco e quello della testata: il bordo
// destro del menu sta su quello del pulsante, e il menu non esce dallo schermo.
await check('il menu sta attaccato al suo pulsante, a tre larghezze', async () => {
  const misure = [];
  for (const [larghezza, altezza, mobile, dove] of [[1440, 900, false, 'schermo largo'], [768, 900, false, 'tablet'], [390, 844, true, 'telefono']]) {
    await viewport(larghezza, altezza, { mobile, dark: false });
    await goto({ waitFor: `document.querySelectorAll('${RIGHE}').length > 0` });
    await click('#conversations-body .list li .menu-btn', { index: 0, what: 'il menu della prima riga' });
    await sleep(350);
    const posto = await menuAttaccato('#conversations-body .list li .menu-btn');
    assert(posto, `a ${larghezza}px il menu non si è aperto`);
    assert(posto.dentro, `a ${larghezza}px il menu esce dallo schermo: ${JSON.stringify(posto)}`);
    assert(posto.scarto <= 1, `a ${larghezza}px il menu non sta sotto il suo pulsante: ${JSON.stringify(posto)}`);
    assert(posto.tocca, `a ${larghezza}px il menu è staccato dal suo pulsante: ${JSON.stringify(posto)}`);
    assert(posto.larghezza < larghezza, `a ${larghezza}px il menu è largo quanto la pagina: ${JSON.stringify(posto)}`);
    misure.push(`${dove} ${posto.larghezza}×${posto.altezza} a ${posto.scarto}px dal bordo`);
    await press('Escape');
    await sleep(200);
    assert(await evaluate(`document.getElementById('menu-layer').childElementCount === 0`), `a ${larghezza}px Escape non chiude il menu`);
  }
  await viewport(1440, 900);
  return misure.join(' · ');
});

// ── Fase 2A: la home, la selezione, i filtri, la navigazione che regge il refresh ───────────
const openName = `document.getElementById('conv-name').textContent`;const selectables = (count) => `[...document.querySelectorAll('#conversations-body .list .row[data-id]')].slice(0, ${count}).map((row) => row.dataset.id)`;
const pickFromMenu = (text) => click('#menu-layer .menu .row', { text });
const sessionsById = (ids) => evaluate(`(async () => {
  const data = await fetch('/local/sessions', { headers: { 'x-cc-remote-token': ${js(token)} } }).then((response) => response.json());
  const wanted = ${js(ids)};
  return wanted.map((id) => data.sessions.find((session) => session.sessionId === id)).filter(Boolean)
    .map((session) => ({ id: session.sessionId, favorite: session.favorite, archived: session.archived, label: session.label }));
})()`);

await check('a pagina nuova si sa cosa gira e cosa si è usato per ultimo', async () => {
  // Era «la home dice cosa gira, cosa si è usato e dove sono i progetti»: la home non c'è più, le
  // sue tre domande le risponde la pagina delle conversazioni. Le prime due con le righe — quelle
  // accese in cima, quelle recenti sotto — e la terza con la pagina dei progetti, che è a un clic.
  await viewport(1440, 900, { dark: false });
  await goto({ waitFor: `document.querySelectorAll('${RIGHE}').length > 0` });
  const shape = await evaluate(`({
    pagina: !document.getElementById('page-conversations').hidden,
    titolo: document.querySelector('#conversations-body h1')?.textContent ?? null,
    righe: document.querySelectorAll('${RIGHE}').length,
    adesso: document.querySelector('#conversations-body .now-block') !== null,
    campo: document.getElementById('composer-wrap').hidden,
    schede: document.querySelector('.tabs-seg').hidden,
    testata: document.getElementById('page-session').hidden,
  })`);
  assert(shape.pagina, 'a pagina nuova non si atterra sulle conversazioni');
  assert(shape.titolo === 'Conversazioni', `il titolo è «${shape.titolo}»`);
  assert(shape.righe > 0, 'la pagina non mostra nessuna conversazione');
  assert(shape.campo, 'senza una conversazione aperta c\'è ancora il campo di scrittura');
  assert(shape.schede, 'senza una conversazione aperta ci sono ancora le schede chat/terminale');
  assert(shape.testata, 'senza una conversazione aperta c\'è ancora la sua testata');
  await shot('conversazioni-desktop');

  // E da lì si apre: la pagina non è una vetrina, è la porta.
  const nome = await evaluate(`document.querySelector('${RIGHE} .title').textContent`);
  await click(RIGHE, { index: 0, what: 'la prima conversazione' });
  await sleep(700);
  assert(await evaluate(`!document.getElementById('page-session').hidden`), 'dall\'elenco non si è aperta nessuna conversazione');
  assert(await evaluate(`${openName} === ${js(nome)}`), 'la testata non è quella della riga che si è aperta');
  return `«${shape.titolo}»: ${shape.righe} righe${shape.adesso ? ', con la scheda «Adesso»' : ''}`;
});

await check('la conversazione aperta sopravvive a un aggiornamento della pagina', async () => {
  // Il controllo apre **da sé** la conversazione da far sopravvivere al refresh: prima dava per
  // scontato che ne fosse rimasta aperta una dal controllo precedente, e da solo cadeva con «la
  // conversazione aperta non è scritta nell'indirizzo» — che è vero, ma non è quello che prova.
  await apriConversazione(0);
  const before = await evaluate(openName);
  assert(before && before !== 'cc-remote', `nessuna conversazione aperta: la testata dice «${before}»`);
  const inUrl = await evaluate(`decodeURIComponent(location.hash.replace('#c=', ''))`);
  assert(inUrl, 'la conversazione aperta non è scritta nell\'indirizzo: un refresh la perderebbe');
  const loaded = once('Page.loadEventFired');
  await send('Page.reload');
  await loaded;
  await sleep(1_200);
  const after = await evaluate(openName);
  assert(after === before, `dopo il refresh la conversazione è «${after}» invece di «${before}»`);
  return `«${before}» ancora aperta`;
});

await check('la pagina scelta regge il refresh, e cambiare sezione esce dalla conversazione', async () => {
  // Prende il posto del controllo che comprimeva l'elenco: quella maniglia non c'è più, e queste
  // sono le due cose che il guscio a pagine ha **al suo posto**. La seconda è un difetto vero
  // trovato in M8 — la navigazione in alto non usciva dalla conversazione, e cliccare «Progetti»
  // sembrava non fare niente.
  await vaiA('projects');
  assert(await evaluate(`document.querySelectorAll('${PROGETTI}').length > 0`), 'la pagina dei progetti è vuota');

  const loaded = once('Page.loadEventFired');
  await send('Page.reload');
  await loaded;
  await sleep(1_100);
  assert(await evaluate(`!document.getElementById('page-projects').hidden`),
    'al refresh non si torna dove si era: la pagina non sta nell\'indirizzo');

  await apriConversazione(0);
  assert(await evaluate(`!document.getElementById('page-session').hidden`), 'la conversazione non si apre');
  await click(VOCE('projects'), { what: 'la voce Progetti' });
  await sleep(400);
  assert(await evaluate(`document.getElementById('page-session').hidden`),
    'cambiando sezione la conversazione resta aperta: la testata è la navigazione e deve navigare');
  assert(await evaluate(`!document.getElementById('page-projects').hidden`), 'la pagina Progetti non si apre');
  return 'la pagina regge il refresh, e cambiare sezione esce dalla conversazione';
});

await check('scegliere più conversazioni e fissarle tutte insieme', async () => {
  await resetList();
  // La voce sta nel menu ⋯ della testata: era in fondo al menu «ordina e filtra» dell'elenco, che
  // non c'è più. È lo stesso comando, in un posto che si trova da tutte le pagine.
  await click('#nav-more');
  await pickFromMenu('Seleziona più conversazioni');
  await sleep(400);
  assert(await evaluate(`document.querySelectorAll('#conversations-body .list .row[data-id] .pick').length > 0`), 'la selezione non mostra le caselle');
  // La barra c'è anche a mani vuote, coi pulsanti spenti: è lì che sta il modo di uscirne.
  const empty = await evaluate(`({
    visibile: !document.getElementById('selectbar').hidden,
    testo: document.querySelector('#selectbar strong')?.textContent ?? '',
    spenti: [...document.querySelectorAll('#selectbar .act')].every((node) => node.disabled),
  })`);
  assert(empty.visibile && empty.spenti, `la barra con la selezione accesa e niente scelto: ${JSON.stringify(empty)}`);

  for (const row of [0, 1, 2]) await click('#conversations-body .list .row[data-id]', { index: await convIndex(0, row) });
  const bar = await evaluate(`document.querySelector('#selectbar strong')?.textContent ?? ''`);
  assert(bar.startsWith('3'), `la barra dice «${bar}» invece di 3 selezionate`);
  const ids = await evaluate(selectables(3));
  await shot('selezione-multipla');

  await click('#selectbar .act', { text: 'fissa' });
  await sleep(1_000);
  const after = await sessionsById(ids);
  assert(after.length === 3, `non ho ritrovato le tre conversazioni scelte (${after.length})`);
  assert(after.every((session) => session.favorite), `non tutte sono state fissate: ${JSON.stringify(after)}`);
  // Finita l'azione la selezione si chiude: una modalità che resta accesa dopo aver fatto
  // quello che serviva è il modo di archiviare per sbaglio la prossima cosa che si clicca.
  assert(await evaluate(`document.getElementById('selectbar').hidden`), 'la selezione resta accesa dopo l\'azione');
  assert(await evaluate(`document.querySelectorAll('#conversations-body .list .row[data-id] .pick').length === 0`), 'le caselle restano nell\'elenco');
  return `3 conversazioni fissate in un colpo`;
});

await check('archiviare in blocco: dice quante, chiede conferma, e non cancella niente', async () => {
  await resetList();
  // La voce sta nel menu ⋯ della testata: era in fondo al menu «ordina e filtra» dell'elenco, che
  // non c'è più. È lo stesso comando, in un posto che si trova da tutte le pagine.
  await click('#nav-more');
  await pickFromMenu('Seleziona più conversazioni');
  await sleep(400);
  for (const row of [0, 1]) await click('#conversations-body .list .row[data-id]', { index: await convIndex(0, row) });
  const ids = await evaluate(selectables(2));
  await click('#selectbar .act', { text: 'archivia' });
  // Il dialogo si guarda **subito** e poi ancora dopo: se c'è al primo colpo e non al secondo, il
  // difetto è che qualcosa lo chiude; se non c'è mai, il difetto è che non si apre. Sono due
  // difetti diversi e si aggiustano in due posti diversi.
  const subito = await evaluate(`document.getElementById('dialog-layer').childElementCount`);
  await sleep(900);
  const dialog = await evaluate(`document.querySelector('#dialog-layer .dialog h2')?.textContent ?? null`);
  const indizi = await evaluate(`JSON.stringify({ subito: ${subito}, barra: document.querySelector('#selectbar strong')?.textContent ?? null, azione: [...document.querySelectorAll('#selectbar .act')].map((b) => b.textContent.trim() + (b.disabled ? '(spento)' : '')), strato: document.getElementById('dialog-layer').childElementCount, avviso: document.getElementById('toast').hidden ? null : document.getElementById('toast').textContent })`);
  assert(dialog?.includes('2'), `la conferma non dice quante ne prende: «${dialog}» — ${indizi}`);
  await shot('conferma-blocco');
  await click('#dialog-layer .dialog .btn-primary', { what: 'conferma' });
  await sleep(1_200);
  const after = await sessionsById(ids);
  assert(after.length === 2 && after.every((session) => session.archived), `non sono state archiviate: ${JSON.stringify(after)}`);
  // «Archiviata» vuol dire fuori dall'elenco, non cancellata: si ritrovano nel filtro archiviate.
  await click(FILTRO('archived'), { what: 'il filtro archiviate' });
  await sleep(400);
  const found = await evaluate(selectables(2));
  assert(found.every((id) => ids.includes(id)), 'le archiviate non si ritrovano nell\'archivio');
  await click(FILTRO('all'), { what: 'il filtro tutte' });
  await sleep(300);
  return '2 archiviate, con l\'anteprima del numero e senza perdere niente';
});

await check('il filtro per data: una scelta fra poche, che si accende, si vede e si toglie', async () => {
  await resetList();
  const before = await evaluate(`document.querySelectorAll('#conversations-body .list .row[data-id]').length`);
  await click('#when-btn');
  // Prima di scegliere: il menu dichiara che è una **scelta fra poche** — pallini, non interruttori
  // — e ne ha esattamente uno acceso. Il difetto che questo controllo tiene fermo: erano quattro
  // interruttori indipendenti, tutti spenti, di una cosa mutuamente esclusiva.
  const forma = await evaluate(`(() => {
    const righe = [...document.querySelectorAll('#menu-layer .menu .row')];
    return {
      righe: righe.length,
      ruoli: [...new Set(righe.map((r) => r.getAttribute('role')))],
      pallini: righe.filter((r) => r.querySelector('.radio')).length,
      interruttori: righe.filter((r) => r.querySelector('.switch')).length,
      accesi: righe.filter((r) => r.getAttribute('aria-checked') === 'true').length,
    };
  })()`);
  assert(forma.ruoli.length === 1 && forma.ruoli[0] === 'menuitemradio', `la scelta fra poche non si dichiara come tale: ${JSON.stringify(forma)}`);
  assert(forma.interruttori === 0, `una scelta esclusiva disegnata come interruttori: ${JSON.stringify(forma)}`);
  // **Ogni** voce ha il suo pallino, e uno solo è quello acceso: è quello che dice quale sia scelto,
  // ed è la cosa che quattro interruttori spenti non dicevano.
  assert(forma.pallini === forma.righe, `non tutte le voci hanno il pallino: ${JSON.stringify(forma)}`);
  assert(forma.accesi === 1, `accesi ${forma.accesi} invece di uno: ${JSON.stringify(forma)}`);
  await pickFromMenu('ultimi 7 giorni');
  await sleep(600);
  const chip = await evaluate(`document.querySelector('#conversations-body .seg button.when')?.textContent ?? null`);
  assert(chip?.includes('7 giorni'), `il filtro per data non si vede da nessuna parte: «${chip}»`);
  const after = await evaluate(`document.querySelectorAll('#conversations-body .list .row[data-id]').length`);
  assert(after <= before, `il filtro per data non ha ridotto niente: ${before} → ${after}`);
  await click('#conversations-body .seg button.when', { what: 'togli il filtro per data' });
  await sleep(400);
  assert(!(await evaluate(`document.querySelector('#conversations-body .seg button.when')`)), 'il filtro per data non si toglie');
  assert(await evaluate(`localStorage.getItem('cc-remote-when') === 'any'`), 'il filtro per data è rimasto scritto nella preferenza');
  return `un pallino acceso su ${forma.pallini} · righe ${before} → ${after} → ${await evaluate("document.querySelectorAll('#conversations-body .list .row[data-id]').length")}`;
});

await check('il menu ⋯ offre le stesse cose da ogni pagina, e si chiude con Escape', async () => {
  // Prende il posto di «aprire e chiudere tutti i progetti in un colpo»: quel comando non esiste
  // più, perché i progetti non si aprono — si entra nella loro pagina. Quello che c'è adesso, e
  // che va provato, è che il menu della testata sia lo **stesso** da tutte le pagine: è il posto
  // dove sono finite le voci che stavano sparse.
  const attese = ['Amministrazione', 'Aggiungi un progetto', 'Seleziona più conversazioni', 'Quando: oggi'];
  for (const pagina of ['conversations', 'projects', 'activity']) {
    await resetList();
    await vaiA(pagina);
    await click('#nav-more', { what: 'il menu della testata' });
    await sleep(300);
    const voci = await evaluate(`[...document.querySelectorAll('#menu-layer .menu .row .label')].map((n) => n.textContent)`);
    for (const voce of attese) assert(voci.includes(voce), `da «${pagina}» manca «${voce}»: ${voci.join(' | ')}`);
    await press('Escape');
    await sleep(250);
    assert(await evaluate(`document.getElementById('menu-layer').childElementCount === 0`), `Escape non chiude il menu da «${pagina}»`);
  }

  // E una voce del menu fa davvero quello che dice: da qui si accende la selezione multipla.
  await resetList();
  await click('#nav-more', { what: 'il menu della testata' });
  await pickFromMenu('Seleziona più conversazioni');
  await sleep(450);
  assert(await evaluate(`!document.getElementById('selectbar').hidden`), 'dal menu la selezione non si accende');
  await press('Escape');
  await sleep(250);
  return `le stesse ${attese.length} voci da tre pagine, e la selezione si accende`;
});

await check('da telefono: il menu sta attaccato al suo pulsante, e la selezione si tocca', async () => {
  await viewport(390, 844, { mobile: true, dark: false });
  await goto({ waitFor: `document.querySelectorAll('${RIGHE}').length > 0` });
  // Il menu della testata: era in fondo alla colonna, adesso è in alto a destra come tutto il resto.
  await click('#nav-more', { what: 'il menu della testata' });
  await sleep(450);
  // La regola è la stessa a ogni larghezza, telefono compreso: il bordo destro del menu sta su
  // quello del pulsante che l'ha aperto, e il menu non esce dallo schermo. Prima qui si pretendeva
  // un **foglio dal basso** — e il foglio c'era perché il menu, misurato largo quanto la pagina,
  // finiva sempre incollato al bordo sinistro: si curava il sintomo. Adesso si asserisce la causa.
  const posto = await menuAttaccato('#nav-more');
  assert(posto.dentro, `il menu esce dallo schermo: ${JSON.stringify(posto)}`);
  assert(posto.scarto <= 1, `il menu non sta sopra il suo pulsante: ${JSON.stringify(posto)}`);
  assert(posto.larghezza < 330, `il menu è largo quanto la pagina: ${JSON.stringify(posto)}`);
  await shot('telefono-menu-ancorato');

  await click('#menu-layer .menu .row', { text: 'Seleziona più conversazioni' });
  await sleep(450);
  await click(RIGHE, { index: 0 });
  await click(RIGHE, { index: 1 });
  const told = await evaluate(`document.querySelector('#selectbar strong')?.textContent ?? ''`);
  assert(told.startsWith('2'), `la barra dice «${told}» invece di 2`);
  const small = await evaluate(`(() => [...document.querySelectorAll('#selectbar .act')]
    .filter((node) => node.getBoundingClientRect().height < 40).map((node) => node.textContent.trim()))()`);
  assert(small.length === 0, `azioni troppo piccole per un dito: ${small.join(', ')}`);
  // La barra galleggia dentro lo schermo: con l'elenco che è una pagina intera, una barra in fondo
  // al documento sarebbe fuori dalla vista proprio quando serve.
  const barra = await evaluate(`(() => { const r = document.getElementById('selectbar').getBoundingClientRect();
    return { dentro: r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1 }; })()`);
  assert(barra.dentro, 'la barra delle azioni esce dallo schermo');
  await shot('telefono-selezione');
  await press('Escape');
  await sleep(300);
  assert(await evaluate(`document.getElementById('selectbar').hidden`), 'Escape non esce dalla selezione');
  await viewport(1440, 900);
  return 'menu ancorato dentro lo schermo, barra da dito che galleggia, Escape esce';
});

await check('i tre modi di autorizzare: si vedono, si cambiano, e il peggiore si dichiara', async () => {
  // Il cuore della milestone. Prima le tre modalità erano tre interruttori in un menu, e si
  // distinguevano per il colore di una targhetta da 11px: per sapere cosa può fare l'agente
  // bisognava **leggere una parola**. Qui si prova che si vedano senza leggerla — tinta, forma,
  // posizione — e che il caso peggiore sia impossibile da confondere con gli altri.
  await resetList();
  await click('#conversations-body .list .row[data-id]', { index: 0 });
  await sleep(400);
  const name = await evaluate(`document.querySelector('#conversations-body .list .row[aria-current="true"] .title')?.textContent ?? null`);
  const id = await evaluate(`location.hash.replace('#c=', '').split('&')[0]`);
  assert(name, 'non si è aperta nessuna conversazione');

  /** Il modo come lo vede chi guarda: il pulsante in testata, la riga, e la striscia. */
  const look = () => evaluate(`(() => {
    const btn = document.getElementById('conv-auth');
    const row = document.querySelector('#conversations-body .list .row[aria-current="true"]');
    const bar = document.getElementById('auth-bar');
    return {
      pulsante: btn?.dataset.tone ?? null,
      riga: row?.dataset.tone ?? null,
      segno: row?.querySelector('.auth-mark')?.textContent ?? null,
      presa: Boolean(row?.querySelector('.reach')),
      striscia: bar?.hidden === false ? bar.textContent : null,
      dichiara: bar?.hidden === false,
    };
  })()`);

  const apri = async () => {
    // Se è già aperta non si riclicca: il pulsante è un interruttore, e un secondo clic la
    // chiuderebbe — è il modo in cui un controllo che fallisce a metà fa fallire anche il dopo.
    if (await evaluate(`document.getElementById('pane-auth').hidden`)) {
      await click('#conv-auth');
      await sleep(500);
    }
    const stato = await evaluate(`({
      aperta: !document.getElementById('pane-auth').hidden,
      pulsanteNascosto: document.getElementById('conv-auth').hidden,
      chatNascosta: document.getElementById('pane-chat').hidden,
      hash: location.hash,
    })`);
    assert(stato.aperta, `la schermata dei permessi non si è aperta: ${JSON.stringify(stato)}`);
  };
  // Il pulsante si cerca per **testo** e non per classe: la conferma del bypass è `danger` e
  // quella dell'automatico no, e legare il controllo alla classe vorrebbe dire che cambiare il
  // colore di un pulsante rompe un test che non c'entra.
  const conferma = async (testo) => {
    await click('#dialog-layer .dialog .actions button', { text: testo, what: testo });
    await sleep(1_200);
  };
  const scegli = async (modo, testo = null) => {
    await evaluate(`document.getElementById('mode-${modo}').click()`);
    await sleep(350);
    if (testo) await conferma(testo);
  };
  /** L'esposizione, dalla schermata: è l'altro asse, e ha il suo pulsante. */
  const esponi = async (testo) => {
    await click('#pane-auth .auth-reach .btn', { what: testo });
    await sleep(400);
  };

  // La schermata si apre **da chiusa**: se fosse già aperta, il clic la chiuderebbe e il
  // controllo passerebbe senza aver provato niente.
  assert(await evaluate(`document.getElementById('pane-auth').hidden`), 'la schermata dei permessi era già aperta');

  // 1. si parte da «normale», e normale non ha **nessun** contrassegno: è il default, e il
  //    default deve sembrare il default.
  await apri();
  await scegli('normal');
  await closeOverlays();
  const normale = await look();
  assert(normale.pulsante === 'normal', `il pulsante non è in normale: ${normale.pulsante}`);
  assert(normale.riga === 'normal' && !normale.segno, `una chat normale porta un segno: ${normale.segno}`);
  assert(!normale.dichiara, 'una chat normale dichiara qualcosa: il default non deve urlare');
  await shot('modo-normale');

  // 2. l'automatico: ambra, e la riga lo prende. La striscia **no** — è uno stato che si vede,
  //    non uno che va dichiarato a ogni sguardo.
  await apri();
  await scegli('auto', 'accendi');
  await closeOverlays();
  const auto = await look();
  assert(auto.pulsante === 'auto', `il pulsante non è in automatico: ${auto.pulsante}`);
  assert(auto.riga === 'auto' && auto.segno === 'auto', `la riga non dice «auto»: ${auto.riga} / ${auto.segno}`);
  assert(!auto.dichiara, 'l\'automatico controllato non deve mostrare la striscia');
  await shot('modo-auto');

  // 3. il bypass: rosso, e **dichiarato** con la frase per esteso. Le tre modalità si
  //    distinguono per tinta, per forma e per posizione, non per una parola da conoscere.
  await apri();
  await scegli('bypass', 'salta i permessi');
  await closeOverlays();
  const bypass = await look();
  assert(bypass.pulsante === 'bypass', `il pulsante non è in bypass: ${bypass.pulsante}`);
  assert(bypass.riga === 'bypass' && bypass.segno === 'bypass', `la riga non dice «bypass»: ${bypass.riga} / ${bypass.segno}`);
  assert(bypass.dichiara, 'il bypass non si dichiara: è lo stato che va visto per forza');
  assert(/non chiede mai/i.test(bypass.striscia), `la striscia non dice cosa succede: «${bypass.striscia}»`);
  await shot('modo-bypass');

  // 3b. e la schermata dice **cosa si sta accettando**, con le parole che servono
  await apri();
  const accettando = await evaluate(`document.querySelector('#pane-auth .auth-note.danger')?.textContent ?? ''`);
  assert(/privilegi/i.test(accettando) && /senza chiedere/i.test(accettando), `non dice cosa si accetta: «${accettando}»`);
  assert(/che lo fermi/i.test(accettando), 'non dice che non c\'è niente che lo fermi');
  assert(!/sandbox/i.test(accettando), 'promette una sicurezza che non esiste');
  await shot('modo-permessi-bypass');

  // 4. l'esposizione: un asse **diverso**, quindi una forma diversa — una presa, non un modo
  await esponi('consenti');
  const avviso = await evaluate(`({
    titolo: document.querySelector('#dialog-layer .dialog h2')?.textContent ?? null,
    testo: document.querySelector('#dialog-layer .dialog p')?.textContent ?? '',
    campo: Boolean(document.querySelector('#dialog-layer .dialog input')),
  })`);
  assert(avviso.titolo, 'la finestra di consenso non è comparsa');
  assert(/salta i permessi/i.test(avviso.titolo), `il titolo non dice cosa si sta facendo: «${avviso.titolo}»`);
  assert(/privilegi/i.test(avviso.testo) && /cancellare file/i.test(avviso.testo), 'l\'avviso non dice cosa diventa possibile');
  assert(/non è una sandbox/i.test(avviso.testo), 'l\'avviso non dice che non è una sandbox');
  assert(/istruzioni/i.test(avviso.testo), 'l\'avviso non nomina il rischio di istruzioni dentro il testo');
  assert(avviso.testo.includes(name), `l'avviso non dice cosa scrivere: manca «${name}»`);
  assert(avviso.campo, 'manca il campo dove scrivere il nome: un pulsante non è una decisione');
  await shot('modo-avviso-esposizione');

  // 4b. l'avviso è lungo di proposito: da telefono deve starci, e i pulsanti essere da pollice
  await viewport(390, 844);
  await sleep(300);
  const telefono = await evaluate(`(() => {
    const dialog = document.querySelector('#dialog-layer .dialog');
    if (!dialog) return null;
    const box = dialog.getBoundingClientRect();
    return {
      dentro: box.top >= 0 && box.bottom <= window.innerHeight + 1,
      alto: Math.round(box.height),
      piccoli: [...dialog.querySelectorAll('.actions button')].filter((b) => b.getBoundingClientRect().height < 40).length,
      puoScorrere: dialog.scrollHeight > dialog.clientHeight,
    };
  })()`);
  await viewport(1440, 900);
  await sleep(300);
  assert(telefono, 'la finestra è sparita cambiando misura');
  assert(telefono.dentro || telefono.puoScorrere,
    `l'avviso esce dallo schermo e non si può scorrere (alto ${telefono.alto}px)`);
  assert(telefono.piccoli === 0, `${telefono.piccoli} pulsanti sotto i 40px: non si toccano con il pollice`);

// 5. Qui il caso peggiore **non esiste**, ed è il server a dirlo: esporre a un client esterno
  //    una conversazione che salta i permessi è rifiutato con un 400 (`BYPASS_NOT_EXPOSABLE`).
  //    Quindi non si prova lo stato — si prova il **rifiuto**, che è la garanzia vera. La finestra
  //    di conferma compare lo stesso (il client non sa cosa risponderà il server, e non deve
  //    saperlo: la regola sta sul server), e dopo la conferma la conversazione resta com'era.
  //
  //    Si prova **da Node e non dalla pagina**: un 400 fatto partire dal browser finirebbe nel
  //    registro di rete della pagina, e il controllo finale «nessuna richiesta caduta» lo
  //    segnalerebbe — allentare quello per far posto a un rifiuto voluto vorrebbe dire non
  //    accorgersi più dei 400 veri. Il rifiuto è una garanzia del **server**, e si prova sul server.
  const rifiuto = await fetch(`${base}/local/sessions/${id}/mcp`, {
    method: 'POST',
    // L'`Origin` che manda un browser: senza, il rifiuto arriverebbe prima — dal lock, che non sa
    // distinguere «da questa macchina» e non deve indovinare. Qui si vuole provare la regola del
    // **registro** (la conferma che ripete il nome), quindi si parla come parla la pagina.
    headers: { 'content-type': 'application/json', 'x-cc-remote-token': token, origin: base },
    // Il nome **sbagliato** di proposito: è la conferma vuota-di-significato che deve fermarsi.
    body: JSON.stringify({ allowed: true, confirm: `non-e-il-nome-${name}` }),
  }).then(async (response) => ({ status: response.status, body: await response.text() }));
  // La conferma **sbagliata** si rifiuta. Prima qui si pretendeva che *qualsiasi* conferma fosse
  // rifiutata — cioè che una chat in bypass non si potesse esporre mai; adesso si può, con la
  // conferma che ripete il nome della chat, e quello che il server deve garantire è che non si
  // possa fare **senza dirlo**.
  assert(rifiuto.status === 400, `con la conferma sbagliata doveva essere rifiutato, non ${rifiuto.status}`);
  assert(/conferma esplicita che ripete il nome/.test(rifiuto.body),
    `il rifiuto non dice perché: ${rifiuto.body.slice(0, 140)}`);
  await closeOverlays();
  await sleep(800);
  const dopoRifiuto = await look();
  assert(dopoRifiuto.riga === 'bypass', `il rifiuto ha cambiato il modo: ${dopoRifiuto.riga}`);
  assert(!dopoRifiuto.presa, 'il rifiuto ha lasciato acceso il segno dell\'esposizione');

  // 6. l'esposizione invece **funziona** su una conversazione normale, ed è un asse suo: si
  //    accende e si spegne senza toccare il modo, e il modo si cambia senza toccare lei.
  await apri();
  await scegli('normal');
  await closeOverlays();
  await sleep(800);
  await apri();
  await esponi('consenti');
  await closeOverlays();
  await sleep(1_200);
  const esposta = await look();
  assert(esposta.riga === 'normal' && !esposta.segno, `esporre ha toccato il modo: ${esposta.riga}`);
  assert(esposta.presa, 'la presa non è comparsa: l\'esposizione non si vede');

  await apri();
  await esponi('togli');
  await closeOverlays();
  await sleep(1_000);
  const revocata = await look();
  assert(!revocata.presa, 'la revoca non ha spento la presa');
  assert(revocata.riga === 'normal' && !revocata.segno, `la revoca ha toccato il modo: ${revocata.riga}`);

  // 7. e si rimette la chat com'era: il banco non lascia dati cambiati dietro di sé
  await apri();
  await scegli('normal');
  await closeOverlays();
  const ripristinata = await look();
  assert(ripristinata.riga === 'normal' && !ripristinata.segno && !ripristinata.dichiara,
    `la modalità normale non è tornata: ${JSON.stringify(ripristinata)}`);
  return `«${name}»: normale senza segno, auto ambra, bypass dichiarato, e l'esposizione di una chat in bypass rifiutata dal server`;
});

await check('una modalità che la schermata non sa descrivere non si traveste da «Normale»', async () => {
  // Il difetto che una revisione di sicurezza ha trovato in questo lavoro, e che è esattamente
  // quello che la milestone esiste per non avere. `acceptEdits` è nella lista chiusa del server e,
  // per `docs/SECURITY.md`, approva da sé letture, modifiche di file e i comandi di filesystem
  // comuni (`mkdir`, `touch`, `mv`, `cp`) dentro la cartella del progetto. La prima versione la
  // leggeva come «normale» — quindi la riga non portava nessun segno, la testata diceva
  // «Normale», e la schermata diceva «ogni comando chiede» a una conversazione che modificava file
  // da sola. Il caso peggiore mostrato come il meno allarmante di tutti.
  await resetList();
  await click('#conversations-body .list .row[data-id]', { index: 0 });
  await sleep(400);
  const id = await evaluate(`location.hash.replace('#c=', '').split('&')[0]`);
  assert(id, 'non si è aperta nessuna conversazione');

  const modo = (mode) => evaluate(`fetch('/local/sessions/${id}/permissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cc-remote-token': ${js(token)} },
    body: JSON.stringify({ mode: ${js(mode)} }),
  }).then((response) => response.status)`);

  const look = () => evaluate(`(() => {
    const btn = document.getElementById('conv-auth');
    const row = document.querySelector('#conversations-body .list .row[aria-current="true"]');
    const bar = document.getElementById('auth-bar');
    return {
      pulsante: btn?.dataset.tone ?? null,
      riga: row?.dataset.tone ?? null,
      segno: row?.querySelector('.auth-mark')?.textContent ?? null,
      dichiara: bar?.hidden === false,
      striscia: bar?.hidden === false ? bar.textContent : '',
    };
  })()`);

  assert(await modo('acceptEdits') === 200, 'il server non ha accettato `acceptEdits`');
  await sleep(1_200);
  const altro = await look();
  assert(altro.pulsante === 'other', `la testata non dice che è una modalità non descritta: ${altro.pulsante}`);
  assert(altro.riga === 'other', `la riga non lo dice: ${altro.riga}`);
  assert(altro.segno === 'acceptEdits', `la riga non porta il nome della modalità: ${altro.segno}`);
  // Non deve somigliare né al default né all'automatico: non sappiamo quale delle due sia.
  assert(altro.pulsante !== 'normal', 'una modalità non descritta non può avere l\'aspetto del default');
  assert(altro.pulsante !== 'auto', 'una modalità non descritta non può avere l\'aspetto dell\'automatico');
  assert(altro.dichiara, 'una modalità non descritta deve dichiararsi: è una cosa che non si sa');
  assert(/approva da sé/.test(altro.striscia), `la striscia non dice cosa fa davvero: «${altro.striscia.slice(0, 90)}»`);
  assert(!/chiede il permesso prima di agire/.test(altro.striscia), 'la striscia usa la frase della modalità normale, che qui è falsa');
  await shot('modo-non-descritto');

  // E la schermata: nessuno dei tre radio acceso, e un avviso che lo dice.
  await click('#conv-auth');
  await sleep(500);
  assert(await evaluate(`[...document.querySelectorAll('#pane-auth input[name="auth-mode"]')].every((node) => !node.checked)`),
    'la schermata accende una delle tre modalità su una conversazione che non è in nessuna delle tre');
  const avviso = await evaluate(`document.querySelector('#pane-auth .auth-other')?.textContent ?? ''`);
  assert(/acceptEdits/.test(avviso), `l'avviso non nomina la modalità: «${avviso.slice(0, 80)}»`);
  assert(/non sa descrivere|approva da sé/.test(avviso), 'l\'avviso non dice cosa sappiamo e cosa no');
  await shot('modo-non-descritto-pannello');

  // E si deve poterne **uscire**: scegliendo «Normale» la modalità non descritta sparisce davvero.
  // (Nella prima versione il clic non faceva niente: `acceptEdits` veniva letto come «normale», e
  //  la schermata usciva subito perché «è già quella che hai scelto».)
  await evaluate(`document.getElementById('mode-normal').click()`);
  await sleep(1_500);
  await closeOverlays();
  const dopo = await evaluate(`fetch('/local/sessions', { headers: { 'x-cc-remote-token': ${js(token)} } })
    .then((response) => response.json())
    .then((data) => data.sessions.find((session) => session.sessionId === ${js(id)})?.permissionMode)`);
  assert(dopo === 'default', `scegliere «Normale» non ha cambiato la modalità sul server: ${dopo}`);
  const ripristinata = await look();
  assert(ripristinata.pulsante === 'normal' && !ripristinata.segno && !ripristinata.dichiara,
    `la modalità normale non è tornata: ${JSON.stringify(ripristinata)}`);
  return '`acceptEdits` non è «Normale»: si dichiara, non accende nessuna delle tre, e se ne esce';
});

await check('nessun errore in console, nessuna richiesta caduta', async () => {
  assert(page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).map(redact).join(' | '));
  const broken = page.requests.filter((response) => response.status >= 400 && !response.url.includes('/local/detach'));
  assert(broken.length === 0, broken.slice(0, 3).map((response) => `${response.status} ${redact(response.url)}`).join(' | '));
  assert(page.failedRequests.length === 0, `richieste fallite: ${page.failedRequests.slice(0, 3).map(redact).join(' | ')}`);
  return `${page.requests.length} richieste, nessun errore`;
});


page.report();
await page.close();
await bench?.stop();
process.exit(page.results.failures.length ? 1 : 0);
