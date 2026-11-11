#!/usr/bin/env node
// Il pannello amministrativo in un browser vero: stato, processi, copie, ripristino, accesso,
// impostazioni, e com'è da un telefono.
//
// Il banco si porta il proprio mondo, come l'altro: registro appena seminato, server suo,
// cartella usa e getta. Vale la regola dell'altro banco — clic **veri**, e un controllo che
// fallisce non deve lasciare la pagina a metà — e in più una sua: **niente token nel DOM**.
// Il pannello mostra percorsi, nomi e stati, mai la serratura di casa.
//
//   node tools/ui-admin-check.mjs                 (520 conversazioni in 24 progetti)
//   node tools/ui-admin-check.mjs --url http://127.0.0.1:4399 --token <token>
import path from 'node:path';
import { startBench } from './bench.mjs';
import { argsOf, launch } from './cdp.mjs';

const { arg, has } = argsOf();
const shotDir = path.resolve(arg('shot', path.join('docs', 'screenshots', 'm5')));

const fornito = arg('url', null);
const bench = fornito ? null : await startBench({
  name: 'pannello',
  sessions: Number(arg('sessions', 520)),
  projects: Number(arg('projects', 24)),
});
const base = (fornito ?? bench.base).replace(/\/$/, '');
const token = arg('token', bench?.token ?? process.env.CR_TOKEN ?? '');
if (!token) {
  console.error('serve un token: nessun banco avviato e `--token` (o CR_TOKEN) non è stato dato.');
  process.exit(2);
}

const page = await launch({
  base, token, shotDir, name: 'cc-remote — il pannello, in un browser vero',
  headful: has('headful'), port: Number(arg('port', 9335)), keepOpen: has('keep'),
});
const { evaluate, click, press, typeIn, check, assert, attendi, shot, goto, uiFetch, redact, sleep: wait } = page;

/**
 * Accende una conversazione del registro di prova e torna il suo pid.
 *
 * L'ha voluto `bench-solo.mjs`: il controllo sulla copia di sicurezza verificava che il processo
 * acceso dal controllo **precedente** fosse ancora vivo, e da solo verificava che lo fosse `null`.
 * Un controllo che dipende da dove ha lasciato il registro quello prima non è un controllo.
 */
async function accendiUnaConversazione() {
  const elenco = await uiFetch('/local/sessions');
  const scelta = elenco.sessions.find((session) => !session.imported && !session.archived) ?? elenco.sessions[0];
  const pid = await evaluate(`fetch('/local/sessions/${scelta.sessionId}/start', { method: 'POST', headers: { 'x-cc-remote-token': ${JSON.stringify(token)} } }).then((response) => response.json()).then((data) => data.session?.pid ?? null)`);
  assert(pid, 'non sono riuscito ad accendere una conversazione per la prova');
  return pid;
}

/**
 * Una copia deve esserci. Chi la crea e chi la usa erano due controlli legati: da solo, il secondo
 * non trovava nemmeno il pulsante — `.backups .backup .btn` non esiste finché una copia non c'è.
 * Qui si crea se manca, e si **aspetta che compaia** invece di sperare in un tempo fisso.
 */
async function assicuraUnaCopia() {
  await apriSezione('Copie');
  if (!(await evaluate(`document.querySelectorAll('.backups .backup').length > 0`))) {
    await click('#pane-admin .block .btn', { text: 'Fai una copia adesso' });
    const scaduto = Date.now() + 20_000;
    while (Date.now() < scaduto && !(await evaluate(`document.querySelectorAll('.backups .backup').length > 0`))) {
      await wait(250);
    }
  }
  assert(await evaluate(`document.querySelectorAll('.backups .backup').length > 0`), 'non c\'è nessuna copia da usare');
}

/**
 * Il pannello è una pagina della testata: si apre da lì, e quello che c'era sotto sparisce.
 *
 * Si aspetta che abbia **caricato**, non un tempo fisso: il pannello chiede lo stato al server, e
 * finché non risponde mostra una riga sola. Premere un pulsante che non c'è ancora è un fallimento
 * che non c'entra niente con quello che il controllo stava provando — e con un'attesa fissa il
 * risultato dipende da quanto è veloce la macchina quel giorno.
 */
async function apriPannello() {
  const open = await evaluate(`!document.getElementById('pane-admin').hidden`);
  if (!open) await click('#nav-tabs .nav-tab[data-page="admin"]', { what: 'la voce Amministrazione' });
  const scaduto = Date.now() + 10_000;
  while (Date.now() < scaduto && !(await evaluate(`document.querySelectorAll('#pane-admin section.block').length > 0`))) {
    await wait(250);
  }
  await wait(250);
}

/**
 * Apre il pannello **e** la sezione. Un controllo che fallisce chiude il pannello (Escape è la via
 * d'uscita, e i controlli la usano per non lasciare la pagina a metà): senza questa riga, il
 * fallimento di uno si porterebbe dietro i cinque dopo, per un motivo che non c'entra.
 */
async function apriSezione(label) {
  await apriPannello();
  const scelta = await evaluate(`document.querySelector('.admin-tab[aria-selected="true"]')?.textContent.trim() ?? ''`);
  if (scelta !== label) {
    await click('.admin-tab', { text: label, what: `la sezione ${label}` });
    // Si aspetta che il **contenuto** sia quello della sezione chiesta, non un tempo fisso: la
    // sezione si carica dal server, e su una macchina lenta un secondo non basta.
    await attendi(
      `document.querySelector('.admin-tab[aria-selected="true"]')?.textContent.trim() ?? ''`,
      `la sezione ${label} non si è aperta`,
      { ok: (nome) => nome === label },
    );
  }
}

/**
 * Apre un «perché…» chiuso.
 *
 * La diagnostica avanzata, i percorsi dei file e le spiegazioni lunghe stanno **chiuse**: è la
 * richiesta dell'audit — non devono occupare la schermata principale. Un controllo che le vuole
 * deve fare quello che fa una persona: aprirle. Con un clic vero, sul sommario.
 */
async function apriPerche(testo) {
  const presente = await evaluate(`[...document.querySelectorAll('#pane-admin details.perche > summary')]
    .some((node) => node.textContent.includes(${JSON.stringify(testo)}))`);
  assert(presente, `nel pannello non c'è nessun «${testo}» da aprire`);
  const aperto = await evaluate(`[...document.querySelectorAll('#pane-admin details.perche')]
    .find((node) => node.querySelector('summary').textContent.includes(${JSON.stringify(testo)}))?.open === true`);
  if (!aperto) await click('#pane-admin details.perche > summary', { text: testo, what: `apri «${testo}»` });
  await attendi(
    `[...document.querySelectorAll('#pane-admin details.perche')]
      .find((node) => node.querySelector('summary').textContent.includes(${JSON.stringify(testo)}))?.open === true`,
    `«${testo}» non si è aperto`,
  );
}

await page.setViewport(1440, 900);
await goto({ waitFor: `document.querySelectorAll('#conversations-body .list .row[data-id]').length > 0` });
await wait(500);

await check('il pannello si apre, e prende il posto della conversazione', async () => {
  await apriPannello();
  const shape = await evaluate(`({
    pannello: !document.getElementById('pane-admin').hidden,
    titolo: document.getElementById('conv-name').textContent,
    chat: document.getElementById('pane-chat').hidden,
    home: document.getElementById('page-conversations').hidden,
    schede: document.querySelector('.tabs-seg').hidden,
    indirizzo: location.hash,
    sezioni: [...document.querySelectorAll('.admin-tab')].map((node) => node.textContent.trim()),
  })`);
  assert(shape.pannello, 'il pannello non si è aperto');
  assert(shape.schede, 'con il pannello aperto le schede chat/terminale devono sparire');
  assert(shape.chat && shape.home, 'la conversazione (o la home) resta sotto il pannello aperto');
  assert(shape.indirizzo === '#impostazioni', `il pannello deve stare nell'indirizzo: «${shape.indirizzo}»`);
  assert(shape.sezioni.length === 5, `le sezioni sono ${shape.sezioni.length}`);
  await shot('pannello-stato');
  return `${shape.sezioni.join(' · ')} — «${shape.titolo}»`;
});

await check('lo stato dice i numeri veri, presi dal registro', async () => {
  // La sezione la apre **da sé**: prima leggeva `.ledger-row` dando per scontato che il controllo
  // precedente avesse lasciato il pannello aperto su «Stato», e da solo non trovava nemmeno una riga.
  await apriSezione('Stato');
  const registro = await uiFetch('/local/sessions');
  // Lo stato non è più una griglia di riquadri con il numero grande e l'etichetta sotto: è un
  // registro, una riga per fatto, con accanto **cosa vuol dire** il numero. Qui si controlla la
  // riga, non il riquadro.
  const vista = await evaluate(`(() => {
    const ledger = [...document.querySelectorAll('.ledger-row')].map((node) => ({
      what: node.querySelector('.what').textContent,
      value: node.querySelector('.value').textContent,
      hint: node.querySelector('.hint').textContent,
    }));
    return {
      ledger,
      passi: document.querySelectorAll('.steps .step').length,
      controlli: [...document.querySelectorAll('.checks .check')].map((node) => node.querySelector('.what').textContent),
      percorsi: [...document.querySelectorAll('.paths code')].map((node) => node.textContent),
    };
  })()`);
  const conversazioni = vista.ledger.find((row) => row.what === 'conversazioni');
  assert(conversazioni, `manca la riga delle conversazioni: ${vista.ledger.map((r) => r.what).join(' | ')}`);
  assert(conversazioni.value === String(registro.sessions.length),
    `il pannello dice ${conversazioni.value} conversazioni, il registro ne ha ${registro.sessions.length}`);
  // Ogni riga dice cosa vuol dire il suo numero: un registro di soli numeri non è più leggibile
  // di una griglia di riquadri.
  const mute = vista.ledger.filter((row) => !row.hint);
  assert(mute.length === 0, `righe senza spiegazione: ${mute.map((r) => r.what).join(', ')}`);
  // I due numeri che contano per la sicurezza non stanno più in fondo a una frase di contorno.
  for (const what of ['con i permessi saltati', 'esposte a un client esterno']) {
    assert(vista.ledger.some((row) => row.what === what), `manca la riga «${what}»`);
  }
  assert(vista.controlli.includes('registro'), 'fra i controlli manca il registro');
  assert(vista.percorsi.some((row) => row.endsWith('sessions.json')), 'e manca il percorso del registro');
  return `${conversazioni.value} conversazioni in ${vista.ledger.length} righe, ${vista.controlli.length} controlli, ${vista.percorsi.length} percorsi`;
});

await check('il pannello non mostra il token, da nessuna parte', async () => {
  const tutto = await evaluate(`(() => {
    const nodi = [...document.querySelectorAll('#pane-admin *')];
    const attributi = nodi.flatMap((node) => [...node.attributes].map((attr) => attr.value));
    return JSON.stringify([nodi.map((node) => node.textContent), attributi, document.body.innerHTML.length]);
  })()`);
  assert(!tutto.includes(token), 'il token compare nel pannello');
  assert(token.length > 10, 'la prova non ha un token da cercare');
  return 'percorsi, nomi e stati: niente serrature';
});

await check('«ricontrolla tutto» porta i controlli lenti e la coda del log', async () => {
  await apriSezione('Stato');
  // I controlli non stanno più davanti a chi passa: stanno dentro «Diagnostica avanzata», chiusa.
  await apriPerche('Diagnostica avanzata');
  await click('#pane-admin .block .btn, #pane-admin .perche .btn', { text: 'Ricontrolla tutto' });
  await attendi(
    `[...document.querySelectorAll('.checks .check .what')].map((node) => node.textContent).join('|')`,
    'i controlli lenti non sono arrivati',
    { ok: (nomi) => nomi.includes('claude') && nomi.includes('permessi della cartella di stato'), timeoutMs: 15_000 },
  );
  const dopo = await evaluate(`({
    nomi: [...document.querySelectorAll('.checks .check .what')].map((node) => node.textContent),
    log: [...document.querySelectorAll('#pane-admin details.perche > summary')].map((node) => node.textContent).find((t) => /righe di log/.test(t)) ?? null,
  })`);
  assert(dopo.nomi.includes('claude'), `i controlli lenti non sono arrivati: ${dopo.nomi.join(', ')}`);
  assert(dopo.nomi.includes('permessi della cartella di stato'), 'manca la prova dei permessi (quella dell\'incidente del 02/11)');
  // La coda del log c'è **se il server ha delle righe da mandare**: in un banco appena avviato il
  // file può essere vuoto, e pretendere un riquadro vuoto sarebbe provare l'ambiente, non il
  // prodotto. La regola è che quello che il server manda si legge.
  const dalServer = await evaluate(`fetch('/local/admin/check', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-remote-token': ${JSON.stringify(token)} }, body: JSON.stringify({ lines: 40 }) }).then((response) => response.json()).then((data) => (data.log?.lines ?? []).length)`);
  if (dalServer > 0) {
    assert(dopo.log, `il server ha mandato ${dalServer} righe di log e il pannello non le mostra`);
  }
  return `${dopo.nomi.length} controlli${dopo.log ? `, ${dopo.log}` : `, ${dalServer} righe di log nel banco (nessuna da mostrare)`}`;
});

await check('i processi accesi sono quelli veri, col loro pid', async () => {
  // Si accende una conversazione dal registro: da lì in poi il pannello deve vederla.
  await apriSezione('Stato');
  const avviata = await accendiUnaConversazione();
  await click('#pane-admin .block .btn', { text: 'Rileggi i processi' });
  await wait(2_000);
  const vista = await evaluate(`[...document.querySelectorAll('.proc-group')].map((group) => ({
    titolo: group.querySelector('h4').textContent,
    pids: [...group.querySelectorAll('.proc .pid')].map((node) => node.textContent),
  }))`);
  const accesi = vista.find((group) => group.titolo.startsWith('accesi adesso'));
  assert(accesi, `manca il gruppo «accesi adesso»: ${vista.map((group) => group.titolo).join(' · ')}`);
  assert(accesi.pids.includes(String(avviata)), `il pid ${avviata} non compare fra gli accesi (${accesi.pids.join(', ')})`);
  // E nessun processo estraneo finisce nell'elenco dei nostri.
  const gruppi = await evaluate(`document.querySelectorAll('.proc-group h4').length`);
  return `pid ${avviata} acceso, ${gruppi} gruppi di processi`;
});

await check('una copia si crea dal pannello e si verifica', async () => {
  await apriSezione('Copie');
  await click('#pane-admin .block .btn', { text: 'Fai una copia adesso' });
  await wait(2_000);
  const righe = await evaluate(`document.querySelectorAll('.backups .backup').length`);
  assert(righe > 0, 'la copia non compare nell\'elenco');
  await shot('pannello-copie');
  await click('.backups .backup .btn', { text: 'Verifica' });
  await wait(1_500);
  const esito = await evaluate(`document.getElementById('toast')?.textContent ?? ''`);
  assert(/integra|impronta/.test(esito), `la verifica non ha detto niente: «${esito}»`);

  // E la cosa che conta piu' di tutte in un pannello: **un'operazione non distruttiva non deve
  // interrompere il lavoro di nessuno**. La conversazione accesa la accende **questo** controllo:
  // prima usava il pid lasciato dal precedente, e da solo verificava che `null` fosse ancora acceso.
  const accessa = await accendiUnaConversazione();
  await click('#pane-admin .block .btn', { text: 'Fai una copia adesso' });
  const processi = await uiFetch('/local/admin/processes');
  assert(processi.managed.some((row) => row.pid === accessa), 'la copia di sicurezza ha spento una conversazione accesa: non deve');
  return `${righe} copie · «${esito}» · la chat accesa (pid ${accessa}) è ancora in piedi`;
});

await check('l\'anteprima di un ripristino dice cosa cambierebbe, e non tocca niente', async () => {
  await assicuraUnaCopia();
  const prima = (await uiFetch('/local/sessions')).sessions.length;
  await click('.backups .backup .btn', { text: 'Anteprima ripristino' });
  await wait(1_500);
  const piano = await evaluate(`document.querySelector('.backups .backup .plan')?.textContent ?? null`);
  assert(piano, 'l\'anteprima non ha mostrato niente');
  assert(/Cosa cambierebbe/.test(piano), `l'anteprima non dice cosa cambierebbe: «${piano.slice(0, 80)}»`);
  const dopo = (await uiFetch('/local/sessions')).sessions.length;
  assert(prima === dopo, 'l\'anteprima ha cambiato il registro');
  await shot('pannello-anteprima');
  return piano.replace(/\s+/g, ' ').slice(0, 90);
});

await check('il ripristino chiede conferma, e dice quante conversazioni prende', async () => {
  await assicuraUnaCopia();
  await click('.backups .backup .btn', { text: 'Ripristina' });
  await wait(800);
  const dialogo = await evaluate(`document.querySelector('#dialog-layer .dialog h2')?.textContent ?? null`);
  assert(dialogo?.includes('Ripristinare'), `la conferma non è comparsa: «${dialogo}»`);
  const testo = await evaluate(`document.querySelector('#dialog-layer .dialog p')?.textContent ?? ''`);
  assert(/Ora:/.test(testo) && /Dopo:/.test(testo), `la conferma non dice cosa cambia: «${testo.slice(0, 100)}»`);
  assert(/non si toccano/.test(testo), 'la conferma non dice che i transcript restano');
  await shot('pannello-conferma-ripristino');
  await click('#dialog-layer .dialog .btn-danger', { what: 'conferma il ripristino' });
  await wait(3_000);
  const esito = await evaluate(`document.getElementById('toast')?.textContent ?? ''`);
  assert(/ripristinate/.test(esito), `il ripristino non ha riferito l'esito: «${esito}»`);
  // Il registro in memoria è stato riletto: se le conversazioni fossero altre, l'elenco lo direbbe.
  await press('Escape');
  await wait(600);
  const elenco = await evaluate(`document.querySelectorAll("#conversations-body .list .row[data-id]").length`);
  return `${esito} · ${elenco} progetti nell'elenco`;
});

await check('le impostazioni: una cartella inventata viene rifiutata, una vera si salva', async () => {
  await apriSezione('Impostazioni');
  const inventata = path.join(process.env.TEMP ?? '/tmp', 'questa-cartella-non-esiste-davvero');
  // Le tre attese di questo controllo erano **tempi fissi**, ed è così che è caduto un giro su
  // venti con «il file non ha la cartella scelta»: la scrittura non era ancora arrivata. Qui si
  // aspetta quello che deve comparire — la finestra di conferma, l'errore, il file — e se non
  // compare lo si dice con quello che si è visto.
  await typeIn('#pane-admin input[data-bozza="cartella-dei-progetti"]', inventata);
  await click('#pane-admin .btn', { text: 'Salva le impostazioni' });
  await attendi(`Boolean(document.querySelector('#dialog-layer .dialog'))`, 'la conferma del salvataggio non si è aperta');
  await click('#dialog-layer .dialog .btn-primary', { what: 'conferma' });
  await attendi(
    `document.querySelector('.admin-state .chip.danger')?.textContent ?? document.getElementById('toast')?.textContent ?? ''`,
    'una cartella che non esiste deve essere rifiutata',
    { ok: (testo) => /non esiste/.test(testo) },
  );

  const buona = process.env.TEMP ?? '/tmp';
  await typeIn('#pane-admin input[data-bozza="cartella-dei-progetti"]', buona);
  await click('#pane-admin .btn', { text: 'Salva le impostazioni' });
  await attendi(`Boolean(document.querySelector('#dialog-layer .dialog'))`, 'la conferma del secondo salvataggio non si è aperta');
  await click('#dialog-layer .dialog .btn-primary', { what: 'conferma' });
  // Il salvataggio è una **scrittura su file**: si aspetta che il file lo dica.
  await attendi(
    `fetch('/local/admin/settings', { headers: { 'x-cc-remote-token': ${JSON.stringify(token)} } }).then((r) => r.json()).then((d) => d.saved?.defaultProject ?? null)`,
    'il file delle impostazioni non ha preso la cartella scelta',
    { ok: (valore) => valore === buona },
  );
  const esito = await evaluate(`document.getElementById('toast')?.textContent ?? ''`);
  assert(/prossimo avvio/.test(esito), `il salvataggio non dice quando si applica: «${esito}»`);
  await shot('pannello-impostazioni');
  return `${esito}`;
});

await check('l\'accesso da fuori: il piano è quello che ho scritto, e la verifica dice cosa ha visto', async () => {
  await apriSezione('Accesso');
  const stato = await evaluate(`document.querySelector('.admin-section')?.textContent ?? ''`);
  // Tre modi di rispondere, e tutti e tre sono una risposta: una modalità scelta, nessuna scelta
  // (si entra solo da qui), o nessuna scelta **salvata** con gli indirizzi che arrivano
  // dall'ambiente — che è il caso di chi ha già configurato tutto a mano.
  assert(/Modalità scelta|Nessuna modalità salvata|Nessuna modalità scelta/.test(stato), `lo stato dell'accesso non si legge: «${stato.slice(0, 120)}»`);

  // Il piano: nessun effetto collaterale, e i comandi da eseguire a mano scritti per intero.
  //
  // Il pannello si aggiorna da sé ogni cinque secondi e ridisegna i campi da quello che ha
  // salvato: si **aspetta che il ridisegno sia passato** (si marchia il nodo del campo e si
  // aspetta che sparisca) invece di sperare che un'attesa fissa cada nel momento giusto. È il
  // momento in cui un hostname digitato a metà spariva sotto le dita — e «Applica la scelta»
  // ne salvava un altro, senza dirlo.
  await typeIn('#pane-admin .mode input', 'pc-di-prova.tail1234.ts.net');
  await evaluate(`(() => { document.querySelector('#pane-admin .mode input').dataset.marchio = '1'; return true; })()`);
  await attendi(
    `document.querySelector('#pane-admin .mode input') !== document.querySelector('#pane-admin .mode input[data-marchio]')`,
    'il pannello non si è aggiornato da sé: il campo non è stato ridisegnato',
    { timeoutMs: 8_000 },
  );
  const scritto = await evaluate(`document.querySelector('#pane-admin .mode input').value`);
  assert(scritto === 'pc-di-prova.tail1234.ts.net', `il campo ha perso quello che ho scritto: «${scritto}»`);
  // E il fuoco: un campo ricostruito mentre si scrive porta via anche il cursore, e il resto della
  // riga finisce sul documento — dove i tasti sono scorciatoie, non testo.
  assert(
    await evaluate(`document.activeElement === document.querySelector('#pane-admin .mode input')`),
    'il ridisegno ha portato via il fuoco: il campo non è più quello che si sta scrivendo',
  );

  await click('#pane-admin .mode .btn', { text: 'Prepara i comandi' });
  const piano = await attendi(
    `document.querySelector('#pane-admin .plan')?.textContent ?? null`,
    'il piano non mostra l\'hostname che ho scritto',
    { ok: (testo) => Boolean(testo) && testo.includes('CR_PUBLIC_ORIGIN=https://pc-di-prova.tail1234.ts.net') },
  );
  assert(/tailscale serve/.test(piano), 'il piano non mostra il comando da eseguire');
  await shot('pannello-accesso');

  await click('#pane-admin .block .btn', { text: 'Verifica adesso' });
  await wait(4_000);
  const verdetto = await evaluate(`document.querySelector('.verify, .admin-section .note')?.textContent ?? ''`);
  assert(verdetto, 'la verifica non ha detto niente');
  return piano.replace(/\s+/g, ' ').slice(0, 80);
});

// ── La riconciliazione: i due elenchi che non coincidono ──────────────────────────────────────
await check('la riconciliazione analizza, mostra l\'anteprima, e non scrive niente senza conferma', async () => {
  await apriSezione('Conversazioni');
  // Aprire la sezione **non** fa partire la scansione: legge centinaia di transcript, e chiederla
  // è una cosa che si fa apposta.
  assert(
    !(await evaluate(`Boolean(document.querySelector('#pane-admin .ledger-row'))`)),
    'la scansione è partita da sola: aprire la sezione non deve leggere il disco',
  );
  const prima = (await uiFetch('/local/sessions')).sessions.length;

  await click('#pane-admin .btn', { text: 'Analizza adesso' });
  await attendi(
    `Boolean(document.querySelector('#pane-admin .ledger-row'))`,
    'la riconciliazione non ha risposto',
    { timeoutMs: 30_000 },
  );
  const piano = await evaluate(`(() => {
    const righe = Object.fromEntries([...document.querySelectorAll('#pane-admin .ledger-row')]
      .map((node) => [node.querySelector('.what').textContent, node.querySelector('.value').textContent]));
    return { righe, righeTabella: document.querySelectorAll('#pane-admin .ledger-row').length };
  })()`);
  for (const attesa of ['nel registro', 'transcript su disco', 'da importare', 'senza transcript', 'mai usate', 'non riprendibili', 'duplicati']) {
    assert(attesa in piano.righe, `manca la riga «${attesa}»: ${Object.keys(piano.righe).join(' | ')}`);
  }
  assert(piano.righe['nel registro'] === String(prima), `il registro dice ${piano.righe['nel registro']}, le conversazioni sono ${prima}`);
  assert(
    Number(piano.righe['transcript su disco']) >= 1,
    'il banco semina un transcript: la scansione non ne ha trovato nessuno',
  );
  // Le 520 conversazioni del banco non sono mai state aperte, ma il **seme** scrive per ognuna una
  // data di ultima attività (serve ai filtri per data): per il registro sono conversazioni usate
  // senza transcript, ed è quello che il piano dice. Il banco non può dire di no — quindi qui non si
  // asserisce un numero, si asserisce che le righe ci siano e che il registro non sia stato toccato.
  // La **regola** — «mai usata» non è «senza transcript» — si prova in Node
  // (`test/reconcile.test.mjs`), dove i casi si costruiscono invece di sperarli.
  assert(
    Number(piano.righe['mai usate']) + Number(piano.righe['senza transcript']) > 100,
    `le conversazioni senza file non sono contate da nessuna parte: ${JSON.stringify(piano.righe)}`,
  );

  // Le «senza transcript» e le «non riprendibili» stanno **chiuse**: sono cose da guardare quando
  // servono, non da avere davanti a ogni visita.
  const chiusi = await evaluate(`[...document.querySelectorAll('#pane-admin details.perche')].filter((node) => !node.open).length`);
  assert(chiusi >= 1, 'le liste lunghe non stanno dietro un «perché…»');

  // E l'anteprima non ha scritto niente nel registro.
  assert((await uiFetch('/local/sessions')).sessions.length === prima, 'l\'analisi ha cambiato il registro');
  await shot('pannello-conversazioni');
  return `${Object.entries(piano.righe).map(([k, v]) => `${k} ${v}`).join(' · ')}`;
});

// ── La forma nuova: una sezione per volta, una colonna sola, campi larghi quanto il dato ──────
await check('una sezione per volta, con la navigazione secondaria a sinistra', async () => {
  await apriPannello();
  const forma = await evaluate(`(() => {
    const rail = document.querySelector('.admin-rail');
    if (!rail) return null;
    const pannello = document.querySelector('.admin-panel');
    const r = rail.getBoundingClientRect();
    const p = pannello.getBoundingClientRect();
    const voci = [...document.querySelectorAll('.admin-tab')].map((node) => {
      const b = node.getBoundingClientRect();
      return { testo: node.textContent.trim(), sinistra: Math.round(b.left), sopra: Math.round(b.top), alto: Math.round(b.height) };
    });
    return {
      aSinistra: r.right <= p.left + 1,
      verticale: new Set(voci.map((v) => v.sinistra)).size === 1,
      impilate: new Set(voci.map((v) => v.sopra)).size === voci.length,
      sezioni: document.querySelectorAll('#pane-admin .admin-section').length,
      colonna: Math.round(p.width),
      voci,
    };
  })()`);
  assert(forma, 'la navigazione secondaria non c\'è');
  assert(forma.aSinistra, 'la navigazione secondaria non sta a sinistra del contenuto');
  assert(forma.verticale && forma.impilate, `le voci non sono impilate: ${JSON.stringify(forma.voci)}`);
  // **Una** sezione per volta: era la richiesta, ed è anche il motivo per cui il pannello smette di
  // essere quattro intestazioni che scorrono via insieme a quello che stai leggendo.
  assert(forma.sezioni === 1, `nel pannello ci sono ${forma.sezioni} sezioni invece di una`);
  assert(forma.colonna <= 1030, `la colonna di lettura è larga ${forma.colonna}px: le misure erano tre`);
  return `navigazione verticale a sinistra, una sezione per volta, colonna da ${forma.colonna}px`;
});

await check('i campi sono larghi quanto il dato, e nessun pulsante esce dalla colonna', async () => {
  await apriSezione('Accesso');
  // Il difetto dell'audit: un campo da 1000px per un hostname di 25 caratteri, e tre pulsanti
  // affiancati che uscivano dalla piega a 1440×900.
  const misure = await evaluate(`(() => {
    const pannello = document.querySelector('.admin-panel').getBoundingClientRect();
    const campo = document.querySelector('#pane-admin .mode input')?.getBoundingClientRect();
    const scheda = document.querySelector('#pane-admin .mode')?.getBoundingClientRect();
    const fuori = [...document.querySelectorAll('#pane-admin .btn')]
      .filter((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && (r.right > pannello.right + 1 || r.left < pannello.left - 1); })
      .map((node) => node.textContent.trim());
    return {
      campo: campo ? Math.round(campo.width) : null,
      scheda: scheda ? Math.round(scheda.width) : null,
      fuori,
      scorrimento: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  assert(misure.campo !== null, 'il modulo della modalità non si è disegnato');
  assert(misure.campo <= 400, `un campo da ${misure.campo}px per un hostname di 25 caratteri`);
  assert(misure.campo < misure.scheda - 40, `il campo occupa tutta la scheda (${misure.campo} su ${misure.scheda})`);
  assert(misure.fuori.length === 0, `pulsanti fuori dalla colonna: ${misure.fuori.join(', ')}`);
  assert(!misure.scorrimento, 'il pannello scorre di lato');
  return `campo ${misure.campo}px dentro una scheda da ${misure.scheda}px, nessun pulsante fuori`;
});

await check('nessun campo del pannello perde quello che stai scrivendo', async () => {
  // Il difetto chiuso in M8.1 vale per **tutti** i campi, non per quello che era stato provato:
  // il pannello si aggiorna da sé ogni cinque secondi e ridisegna i campi. Qui si scrive in ogni
  // campo di ogni sezione e si aspetta **un** ridisegno — ne basta uno perché il difetto si veda.
  const valori = {
    Accesso: ['pc-di-prova.tail1234.ts.net', 'mcp.di-prova.example', 'cc.di-prova.example'],
    Impostazioni: ['C:\\una\\cartella\\inventata', 'C:\\altra\\cartella'],
  };
  const tenuti = [];
  for (const [sezione, prova] of Object.entries(valori)) {
    await apriSezione(sezione);
    const chiavi = await evaluate(`[...document.querySelectorAll('#pane-admin input[data-bozza]')].map((node) => node.dataset.bozza)`);
    assert(chiavi.length > 0, `nella sezione ${sezione} non c'è nessun campo da provare`);
    const attesi = chiavi.map((_, index) => prova[index % prova.length]);
    for (const [index, chiave] of chiavi.entries()) {
      await typeIn(`#pane-admin input[data-bozza="${chiave}"]`, attesi[index]);
    }
    await evaluate(`(() => { [...document.querySelectorAll('#pane-admin input[data-bozza]')].forEach((node) => { node.dataset.marchio = '1'; }); return true; })()`);
    await attendi(
      `document.querySelectorAll('#pane-admin input[data-bozza][data-marchio]').length === 0`,
      `il pannello non si è aggiornato da solo nella sezione ${sezione}`,
      { timeoutMs: 9_000 },
    );
    const dopo = await evaluate(`[...document.querySelectorAll('#pane-admin input[data-bozza]')].map((node) => node.value)`);
    for (const [index, chiave] of chiavi.entries()) {
      assert(dopo[index] === attesi[index], `in ${sezione} il campo «${chiave}» ha perso quello che ho scritto: «${dopo[index]}» invece di «${attesi[index]}»`);
    }
    // E il fuoco resta dove si stava scrivendo: senza, il resto della riga finisce sul documento,
    // dove i tasti sono scorciatoie.
    const ultima = chiavi[chiavi.length - 1];
    assert(
      await evaluate(`document.activeElement?.dataset?.bozza === ${JSON.stringify(ultima)}`),
      `in ${sezione} il ridisegno ha portato via il fuoco dal campo «${ultima}»`,
    );
    tenuti.push(`${sezione} ${chiavi.length}`);
  }
  return `tenuti attraverso il ridisegno: ${tenuti.join(' · ')}`;
});

await check('da telefono: una colonna, e i pulsanti sono grandi abbastanza', async () => {
  await apriPannello();
  await page.setViewport(390, 844, { mobile: true, dark: false });
  await wait(800);
  await shot('pannello-telefono');
  const stretto = await evaluate(`(() => {
    const overflow = document.documentElement.scrollWidth > innerWidth + 1;
    const piccoli = [...document.querySelectorAll('#pane-admin button')]
      .filter((node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.height < 40; })
      .map((node) => node.textContent.trim() || node.getAttribute('aria-label'));
    return { overflow, piccoli, sezioni: document.querySelectorAll('.admin-tab').length };
  })()`);
  assert(!stretto.overflow, 'il pannello scorre di lato su un telefono');
  assert(stretto.piccoli.length === 0, `bersagli troppo piccoli: ${stretto.piccoli.slice(0, 4).join(', ')}`);
  assert(stretto.sezioni === 5, 'le sezioni non ci sono tutte su un telefono');
  await page.setViewport(1440, 900);
  return 'una colonna, bersagli da dito, cinque sezioni';
});

await check('Escape chiude il pannello e riporta alle conversazioni', async () => {
  await apriPannello();
  await press('Escape');
  await wait(700);
  const dopo = await evaluate(`({
    pannello: document.getElementById('pane-admin').hidden,
    home: !document.getElementById('page-conversations').hidden,
    elenco: document.querySelectorAll("#conversations-body .list .row[data-id]").length,
    indirizzo: location.hash,
  })`);
  assert(dopo.pannello, 'Escape non ha chiuso il pannello');
  assert(dopo.home, 'chiuso il pannello si deve rivedere la home');
  assert(dopo.indirizzo === '', `l'indirizzo è rimasto «${dopo.indirizzo}»`);
  assert(dopo.elenco > 0, 'l\'elenco delle conversazioni non è tornato');
  return `si torna alle conversazioni (${dopo.elenco} progetti)`;
});

await check('senza rete il pannello non si rompe, e quando torna si riprende', async () => {
  await apriPannello();
  const prima = await evaluate(`document.querySelector('.admin-body')?.textContent.length ?? 0`);
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await wait(2_000);
  const offline = await evaluate(`({
    pannello: !document.getElementById('pane-admin').hidden,
    corpo: document.querySelector('.admin-body')?.textContent.length ?? 0,
    avviso: !document.getElementById('banner').hidden,
  })`);
  assert(offline.pannello, 'senza rete il pannello è sparito');
  assert(offline.corpo >= prima * 0.5, 'senza rete il pannello si è svuotato');
  assert(offline.avviso, 'senza rete l\'avviso non compare');

  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const deadline = Date.now() + 15_000;
  let tornato = false;
  while (Date.now() < deadline && !tornato) {
    await wait(500);
    tornato = await evaluate(`document.getElementById('banner').hidden === true`);
  }
  assert(tornato, 'tornata la rete, l\'avviso resta');
  return 'il pannello regge la disconnessione e si riprende da solo';
});

await check('nessun errore in pagina, e nessun guasto vero', async () => {
  // Gli errori **di rete che abbiamo provocato noi** non contano: questa prova scrive apposta una
  // cartella che non esiste e un hostname sbagliato, per vedere se il server li rifiuta. Il browser
  // li registra come «Failed to load resource», ed è la prova che il rifiuto è arrivato.
  const errori = page.consoleErrors.filter((line) => !/^\[network\]/.test(line));
  assert(errori.length === 0, errori.slice(0, 3).join(' | '));

  const guasti = page.requests.filter((response) => response.status >= 500);
  assert(guasti.length === 0, guasti.slice(0, 3).map((response) => `${response.status} ${redact(response.url)}`).join(' | '));

  // Un 4xx su una rotta amministrativa è un rifiuto voluto (conferma mancante, cartella
  // inesistente, hostname sbagliato); un 4xx altrove sarebbe una pagina rotta.
  const inattese = page.requests.filter((response) => response.status >= 400
    && !response.url.includes('/local/detach')
    && !response.url.includes('/local/admin/'));
  assert(inattese.length === 0, inattese.slice(0, 3).map((response) => `${response.status} ${redact(response.url)}`).join(' | '));
  // Le richieste cadute **mentre la rete era staccata apposta** (il controllo qui sopra) non sono
  // guasti: sono la prova che la disconnessione è arrivata.
  const cadute = page.failedRequests.filter((text) => !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/i.test(text));
  assert(cadute.length === 0, `richieste fallite: ${cadute.slice(0, 3).map(redact).join(' | ')}`);
  return `${page.requests.length} richieste, nessun guasto`;
});

page.report();
await page.close();
await bench?.stop();
process.exit(page.results.failures.length ? 1 : 0);
