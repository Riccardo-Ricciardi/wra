// «Questa conversazione»: cosa può fare l'agente, chi può parlare con la conversazione, e cosa si
// sta accettando.
//
// Era in `app.js`, 320 righe in mezzo alle altre. Qui è una **fabbrica**: riceve quello che le
// serve — lo stato, i nodi, le azioni — e restituisce le sue funzioni. Non importa niente dal
// resto dell'applicazione, e il resto dell'applicazione non sa come è fatta dentro.
//
// Il commento originale, che vale la pena tenere perché spiega **perché** questa schermata esiste:
//
// Quello che l'agente può fare in una conversazione è la decisione più pesante di questa
// interfaccia, e stava in tre interruttori dentro il menu ⋯, alla stessa altezza di «copia l'id».
// Qui diventa due cose: un **contrassegno** sempre visibile in testata — che è quello che si
// guarda — e una **schermata** dove si cambia e si legge cosa si sta accettando.

export function createPermissions({
  state, el, h, fill, icon, api, ask, toast,
  authorizationOf, projectNameOf, projectKeyOf, stateOf,
  currentSession, refresh, rememberOpen, setSelecting,
  renderChrome, renderHead, renderChat, closeMenus, autoApproveOf,
}) {
//
// Quello che l'agente può fare in una conversazione è la decisione più pesante di questa
// interfaccia, e stava in tre interruttori dentro il menu ⋯, alla stessa altezza di «copia l'id».
// Qui diventa due cose: un **contrassegno** sempre visibile in testata — che è quello che si
// guarda — e una **schermata** dove si cambia e si legge cosa si sta accettando.

const projectOf = (session) => (session
  ? state.projects.find((entry) => entry.key === projectKeyOf(session)) ?? null
  : null);

/** Lo stato di autorizzazione di una conversazione, progetto compreso. */
const authOf = (session) => stateOf(session, projectOf(session));

/** Il contrassegno in testata, e la dichiarazione quando lo stato la pretende. */
function renderAuthBar() {
  const session = currentSession();
  const show = Boolean(session) && !state.admin;
  el.convAuth.hidden = !show;
  el.authBar.hidden = true;
  if (!show) return;

  const auth = authOf(session);
  el.convAuth.dataset.tone = auth.tone;
  el.convAuth.setAttribute('aria-pressed', String(state.auth));
  el.convAuth.title = `${auth.name}: ${auth.sentence}`;
  el.convAuth.setAttribute('aria-label', `permessi e accesso di questa conversazione: ${auth.name}. Apri per cambiare.`);
  const cautela = auth.tone === 'bypass' || auth.tone === 'combined' || auth.tone === 'other';
  fill(el.convAuth,
    icon(cautela ? 'alert' : 'shield', { size: 12, className: 'glyph' }),
    h('span.long', { text: auth.name }),
    h('span.short', { text: auth.mode === 'normal' ? 'normale' : auth.short }),
    auth.reach.on ? icon('plug', { size: 11, className: 'glyph' }) : null,
  );

  // La striscia **solo** per gli stati che vanno visti per forza: il bypass, il caso peggiore, e
  // una modalità che questa schermata non sa descrivere — perché lì la cosa da dire è proprio che
  // non lo sappiamo, e una cosa così non può stare in un suggerimento che si legge passandoci
  // sopra. Una striscia sempre accesa è una striscia che dopo due giorni nessuno legge più.
  const loud = auth.tone === 'bypass' || auth.tone === 'combined' || auth.tone === 'other';
  if (!loud) return;
  el.authBar.dataset.tone = auth.tone;
  el.authBar.hidden = false;
  fill(el.authBar,
    icon('alert', { size: 15, className: 'mark' }),
    h('span.what', {},
      h('b', {
        text: auth.combined ? 'Salta i permessi ed è esposta a ChatGPT. '
          : auth.mode === 'other' ? `Modalità «${auth.name}». `
            : 'Salta i permessi. ',
      }),
      h('span', { text: auth.sentence }),
    ),
    h('button.btn', { type: 'button', text: 'cambia', onclick: () => openAuth() }),
  );
}

/**
 * «Questa conversazione»: cosa può fare l'agente, chi può parlarci, e cosa si sta accettando.
 *
 * Prende il posto della chat invece di stare in una finestra: sono tre scelte con un paragrafo di
 * conseguenze ciascuna, e in un dialogo da 26rem quel paragrafo diventa una nota a piè di pagina.
 */
function openAuth() {
  if (!currentSession()) return;
  state.auth = true;
  state.admin = false;
  setSelecting(false);
  renderChrome();
  renderAuth();
  renderHead();
  closeMenus();
  rememberOpen(state.open, 'permessi');
}

function closeAuth() {
  if (!state.auth) return;
  state.auth = false;
  rememberOpen(state.open);
  renderChrome();
  renderHead();
  renderChat();
  renderAuthBar();
}

/**
 * Un cambio di modo.
 *
 * I tre modi dell'interfaccia sono **due cose nel registro** — la modalità della conversazione e
 * l'automatico — e il server non ammette che stiano accese insieme: `bypass` con l'automatico
 * acceso viene rifiutato, e l'automatico su una chat in bypass pure. Quindi si passa sempre per
 * lo stato spento, e l'ordine conta. Farlo qui, in un posto solo, invece che in tre punti
 * dell'interfaccia che devono ricordarsene.
 */
async function setMode(mode) {
  const session = currentSession();
  if (!session) return;
  const auth = authOf(session);
  if (auth.mode === mode) return;

  if (mode === 'bypass') {
    const ok = await ask({
      title: 'Saltare i permessi?',
      danger: true,
      message: 'Da qui in avanti, in questa conversazione, l\'agente eseguirà comandi e modificherà '
        + 'file senza chiedere. Nessuna richiesta arriverà qui, né sul telefono.\n\n'
        + 'Vale solo per questa conversazione, si disfa da questa stessa schermata, e vale dalla '
        + 'richiesta successiva.',
      confirmLabel: 'salta i permessi',
    });
    if (!ok) return;
  } else if (mode === 'auto') {
    const ok = await ask({
      title: 'Accendere l\'automatico controllato?',
      message: `${authorizationOf({ ...session, permissionMode: null, autoApprove: true }, projectOf(session)).accept}\n\n`
        + 'Restano da approvare: i comandi, i percorsi fuori dal progetto, le credenziali, '
        + '`.claude/` e `.git/`. Si spegne da qui in qualsiasi momento.',
      confirmLabel: 'accendi',
    });
    if (!ok) return;
  }

  const post = (route, body) => api(`/local/sessions/${session.sessionId}/${route}`, { method: 'POST', body });
  try {
    // Prima si smonta quello che c'è, poi si monta quello che si vuole: mai i due insieme, e
    // **nell'ordine che non passa da uno stato peggiore di quello che si è chiesto**.
    //
    // L'ordine conta davvero, e non è lo stesso per tutti e tre i bersagli:
    // - verso `normale`: prima `auto false` sulla **conversazione**, poi la modalità. Al contrario
    //   ci sarebbe un istante in cui la chat è `default` e quindi **eredita** l'automatico del
    //   progetto: si è chiesta la modalità più stretta e per un momento se ne ha una più larga.
    // - verso `automatico`: prima la modalità, perché `setAutoApprove(true)` è rifiutato su una
    //   chat in bypass — e giustamente: in bypass il criterio non deciderebbe niente.
    // - verso `bypass`: prima si spegne l'automatico, che è la condizione perché il server accetti.
    //
    // E `permissions {mode:'default'}` si manda **sempre** quando il bersaglio non è il bypass:
    // serve a uscire dal bypass *e* da una modalità che questa schermata non conosce
    // (`acceptEdits` e compagne). Senza, scegliere «Normale» su una di quelle non cambierebbe
    // niente — e la schermata direbbe «Normale» a una chat che continua a modificare file da sola.
    if (mode === 'bypass') {
      if (autoApproveOf(session)) await post('auto', { enabled: false });
      await post('permissions', { mode: 'bypassPermissions' });
    } else if (mode === 'auto') {
      await post('permissions', { mode: 'default' });
      await post('auto', { enabled: true });
    } else {
      await post('auto', { enabled: false });
      await post('permissions', { mode: 'default' });
    }
  } catch (error) {
    toast(error.message, 'danger');
    // Il pannello non deve restare a mostrare il bersaglio quando il server non ci è arrivato: la
    // scelta si è già segnata nel radio al clic, e senza questo la schermata direbbe «Bypass» a
    // una conversazione che è rimasta normale. Si rilegge e si ridisegna, e si vede com'è andata.
    await refresh();
    renderAuth();
    renderAuthBar();
    return;
  }
  await refresh();
  renderAuth();
  renderAuthBar();
}

/** L'esposizione a ChatGPT. Su una chat che salta i permessi è un'altra cosa, e si chiede per esteso. */
async function setReach(allowed) {
  const session = currentSession();
  if (!session) return;
  const auth = authOf(session);
  let confirm = null;
  if (allowed && auth.mode === 'bypass') {
    confirm = await ask({
      title: 'Dare a ChatGPT una chat che salta i permessi?',
      danger: true,
      message: 'In questa conversazione l\'agente non chiede il permesso: non c\'è nessuna '
        + 'richiesta da approvare, né qui né sul telefono. Dandola a ChatGPT, a scrivere i '
        + 'messaggi sarà un modello remoto e a eseguire sarà un agente con i tuoi privilegi '
        + 'su questo PC: potrà leggere e cancellare file, leggere credenziali, usare la rete, '
        + 'installare software. Non è una sandbox e non c\'è niente, qui dentro, che fermi un '
        + 'comando. Se il testo che l\'agente legge contiene istruzioni — un file, una pagina, '
        + 'un transcript — nessuno se ne accorge. Si revoca da qui in qualsiasi momento.\n\n'
        + `Per confermare, scrivi il nome della conversazione: ${session.name}`,
      input: { label: 'nome della conversazione', value: '' },
      confirmLabel: 'espongo',
    });
    if (confirm === null) return;
  }
  try {
    await api(`/local/sessions/${session.sessionId}/mcp`, { method: 'POST', body: { allowed, confirm } });
  } catch (error) {
    toast(error.message, 'danger');
    return;
  }
  await refresh();
  renderAuth();
  renderAuthBar();
}

let authSignature = null;

function renderAuth() {
  const session = currentSession();
  if (!session || !state.auth) {
    authSignature = null;
    return;
  }
  const auth = authOf(session);
  const project = projectOf(session);
  // La schermata si ridisegna a ogni messaggio del server, che arriva a ogni pezzo di output del
  // terminale: si firma quello che si vede. Ridisegnarla davvero vorrebbe dire togliere il fuoco
  // dalla scelta che si sta per premere.
  const signature = [session.sessionId, auth.mode, auth.inherited, auth.reach.on, auth.reach.expired,
    session.mcpAllowed, session.name, session.autoApprove === true, project?.name ?? ''].join('|');
  if (signature === authSignature) return;
  authSignature = signature;

  const choice = (mode, title, why, extra = []) => {
    const id = `mode-${mode}`;
    return h(`label.auth-choice`, { dataset: { tone: mode === 'normal' ? 'normal' : mode } },
      h('input', {
        type: 'radio', name: 'auth-mode', id, value: mode,
        checked: auth.mode === mode,
        onchange: () => setMode(mode),
      }),
      h('span.text', {},
        h('span.title', {}, h('span', { text: title }), ...extra),
        h('span.why', { text: why }),
      ),
    );
  };

  fill(el.paneAuth,
    h('div.auth-body', {},
      h('header', {},
        h('h2', { text: 'Questa conversazione' }),
        h('div.who', {},
          h('span', { text: session.name }),
          ' · ',
          h('code', { text: project?.name ?? projectNameOf(session) }),
        ),
      ),

      h('section.auth-group', {},
        h('h3', { text: 'Cosa può fare l\'agente' }),
        h('p.lead', { text: 'Vale solo per questa conversazione. Il default è che chieda.' }),
        // La conversazione è in una modalità che questa schermata non offre e non sa descrivere.
        // Si dice, e **non** si sceglie niente al posto suo: nessuno dei tre radio è acceso,
        // perché accendere «Normale» qui sarebbe la stessa bugia che questa schermata esiste per
        // non dire. Scegliendone una, quella sostituisce questa.
        auth.mode === 'other'
          ? h('div.auth-other', {},
            icon('alert', { size: 16 }),
            h('span.text', {},
              h('span.title', {},
                h('span', { text: `Questa conversazione è in «${auth.name}»` }),
                h('span.tag.here', { text: 'non descritta qui' }),
              ),
              h('span.why', { text: auth.sentence }),
              auth.accept ? h('span.why.accept', { text: auth.accept }) : null,
            ),
          )
          : null,
        choice('normal', 'Normale',
          'Chiede il permesso prima di agire: ogni comando e ogni modifica passa da una richiesta che approvi tu.'),
        choice('auto', 'Automatico controllato',
          authorizationOf({ ...session, permissionMode: null, autoApprove: true }, project).sentence,
          [
            auth.mode === 'auto' && auth.inherited ? h('span.tag.from', { text: 'dal progetto' }) : null,
            session.autoApprove === true ? h('span.tag.here', { text: 'accesa qui' }) : null,
          ]),
        choice('bypass', 'Bypass',
          authorizationOf({ ...session, permissionMode: 'bypassPermissions' }).sentence,
          [h('span.tag.here', { text: 'alto privilegio' })]),
        auth.mode === 'bypass'
          ? h('p.auth-note.danger', { text: auth.accept })
          : null,
      ),

      h('section.auth-group', {},
        h('h3', { text: 'Chi può parlare con questa conversazione' }),
        h('p.lead', { text: 'Un asse diverso da quello sopra: non cambia cosa fa l\'agente, cambia chi può chiederglielo.' }),
        h('div.auth-reach', {
          dataset: { on: String(auth.reach.on), expired: String(auth.reach.expired) },
        },
          icon('plug', { size: 16 }),
          h('span.text', {},
            h('span.title', {},
              h('span', { text: 'ChatGPT, via MCP' }),
              auth.reach.on && auth.mode === 'bypass' ? h('span.tag.here', { text: 'con i permessi saltati' }) : null,
            ),
            h('span.why', { text: auth.reach.sentence }),
          ),
          // L'etichetta e l'azione vengono dalla **stessa** sorgente. Prima l'etichetta veniva
          // dallo stato efficace (`reach.on`) e l'azione dall'interruttore scritto
          // (`mcpAllowed`): con un consenso scaduto il pulsante diceva «ridai il consenso» e
          // faceva `setReach(false)` — cioè revocava, senza nemmeno la finestra di conferma,
          // e cancellava la data del consenso. Il primo clic faceva il contrario di quello che
          // c'era scritto sopra.
          h('button.btn.switch-btn', {
            type: 'button',
            'aria-pressed': String(auth.reach.on),
            text: auth.reach.on ? 'togli' : auth.reach.expired || auth.reach.archived ? 'ridai il consenso' : 'consenti',
            onclick: () => setReach(!auth.reach.on),
          }),
        ),
      ),

      h('footer.auth-foot', {},
        h('p.note', { text: 'Le tre modalità e l\'esposizione sono indipendenti: si possono cambiare una per volta, e ognuna si disfa da qui.' }),
        h('p.note', { text: 'Cosa significano davvero, rischi compresi, sta in docs/SECURITY.md — è la fonte, e questa schermata non promette niente di più.' }),
        h('p.note', {}, h('button.link-btn', { type: 'button', text: 'torna alla conversazione', onclick: () => closeAuth() })),
      ),
    ),
  );
}

  // Il contrassegno in testata è l'interruttore: apre la schermata, e la richiude.
  el.convAuth.addEventListener('click', () => {
    if (state.auth) closeAuth();
    else openAuth();
  });

  return { authOf, projectOf, renderAuth, renderAuthBar, openAuth, closeAuth, setMode, setReach };
}
