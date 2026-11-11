// Il telaio: la testata con le sue quattro sezioni, cosa si vede in ogni momento, e come si passa
// da una schermata all'altra.
//
// Era l'ultimo pezzo grosso di `app.js` — `renderNav`, `renderHead`, `renderChrome`, il contatore
// della connessione e i quattro modi di cambiare pagina. Qui è una **fabbrica**, come le altre
// viste, ma è l'unica che *conosce tutte le altre*: è il suo mestiere. Sa che esistono una pagina
// conversazioni, una dei progetti, una dell'attività e un pannello; sa che una conversazione può
// essere aperta sopra di loro; e sa mostrare una schermata per volta.
//
// Le due regole che questo file tiene, e che è il motivo per cui è un file:
//
//   1. **Una schermata per volta.** I riquadri stanno uno sotto l'altro in `#main`, e nasconderne
//      uno solo vorrebbe dire vederlo ricomparire più in basso. Chi decide cosa si vede lo decide
//      *qui*, in un posto solo: scritto in due posti, prima o poi i due divergono.
//   2. **La testata non mente.** Dice «Impostazioni» quando c'è il pannello e «Permessi e accesso»
//      quando c'è quella schermata, perché il nome della conversazione che sta sotto sarebbe una
//      didascalia sbagliata. E si **firma** quello che mostra: arriva a ogni pezzo di output del
//      terminale, e ridisegnarla ogni volta per non cambiare niente è il modo di rendere lenta
//      un'interfaccia che non lo è.
import { h, fill } from '/ui/dom.mjs';
import { icon } from '/ui/icons.mjs';
import { STATE_LABEL } from '/core/format.mjs';
import { isRunning, projectKeyOf } from '/core/session-view.mjs';
import { testProjectKeys } from '/core/registry-hygiene.mjs';

// Quattro sezioni, una per volta. Prima erano tutte insieme in una colonna da 296px: l'elenco,
// i filtri, i progetti e il piè di pagina, sempre, anche quando serviva una sola di quelle cose.
const PAGES = [
  { id: 'conversations', label: 'Conversazioni' },
  { id: 'projects', label: 'Progetti' },
  { id: 'activity', label: 'Attività' },
  { id: 'admin', label: 'Amministrazione' },
];

/**
 * @param {object} input
 * @param {object} input.state
 * @param {object} input.el
 * @param {Function} input.refresh
 * @param {Function} input.remember
 * @param {Function} input.rememberOpen
 * @param {Function} input.closeMenus
 * @param {Function} input.renderPage       app.js: disegna la pagina che si sta guardando
 * @param {Function} input.renderChat
 * @param {Function} input.setSelecting
 * @param {Function} input.renderAuth       dai permessi
 * @param {Function} input.renderAuthBar    dai permessi
 * @param {Function} input.renderTermNote   dal terminale
 * @param {Function} input.connect          riapre il websocket
 * @param {Function} input.currentSession
 * @param {object}   input.admin            il pannello, per aprirlo
 * @param {string}   input.pageKey          dove si ricorda la pagina scelta
 */
export function createShell({
  state, el, refresh, remember, rememberOpen, closeMenus, renderPage, renderChat,
  setSelecting, renderAuth, renderAuthBar, renderTermNote, connect, currentSession, admin, pageKey,
}) {
  // ── la testata ─────────────────────────────────────────────────────────────
  let headSignature = null;

  function renderHead() {
    // Col pannello aperto la testata parla del pannello: il nome della conversazione che sta sotto
    // sarebbe una didascalia sbagliata.
    if (state.admin) {
      headSignature = 'admin';
      el.convName.textContent = 'Impostazioni';
      el.convProject.textContent = 'stato, accesso, copie, impostazioni';
      el.convProject.title = '';
      el.convState.textContent = '';
      fill(el.convChips);
      el.busy.hidden = true;
      renderAuthBar();
      document.title = 'Impostazioni · WRA';
      return;
    }

    if (state.auth) {
      headSignature = 'auth';
      el.convName.textContent = 'Permessi e accesso';
      el.convProject.textContent = currentSession()?.name ?? '';
      el.convProject.title = '';
      el.convState.textContent = '';
      fill(el.convChips);
      el.busy.hidden = true;
      renderAuthBar();
      document.title = 'Permessi e accesso · WRA';
      return;
    }

    const session = currentSession();
    const project = session ? state.projects.find((entry) => entry.key === projectKeyOf(session)) : null;
    // La testata si ridisegna a ogni messaggio del server, che arriva a ogni pezzo di output del
    // terminale: si firma quello che si vede, e se non è cambiato non si tocca niente.
    const signature = session
      ? [state.admin, session.name, session.projectPath, session.state, session.busy, session.label, session.mcpAllowed,
        session.imported, session.archived, session.permissionMode, session.favorite, session.autoApprove,
        project?.name ?? '', project?.autoApprove ?? false, state.connected].join('|')
      : `${state.admin}`;
    if (signature === headSignature) return;
    headSignature = signature;

    el.convName.textContent = session?.name ?? 'WRA';
    // Il nome del progetto accanto a quello della conversazione, non il percorso: il percorso
    // serve a distinguere due cartelle omonime, e sta nel suggerimento.
    el.convProject.textContent = session
      ? `${project?.name ?? projectKeyOf(session).split(/[\\/]/).pop()}${session.label ? ` · ${session.label}` : ''}`
      : 'nessuna conversazione aperta';
    el.convProject.title = session?.projectPath ?? '';
    // Lo stato per esteso, e la connessione quando manca: «spenta» e «scollegata» sono due cose
    // diverse — la prima è il processo, la seconda è questa pagina.
    el.convState.textContent = session
      ? `${session.busy ? 'sta lavorando' : STATE_LABEL[session.state] ?? session.state}${state.connected ? '' : ' · scollegata'}`
      : '';
    el.convStar.hidden = !session;
    el.convStar.setAttribute('aria-pressed', String(Boolean(session?.favorite)));
    el.convStar.title = session?.favorite ? 'toglila dalla cima' : 'fissala in alto';
    el.busy.hidden = !session?.busy;
    // I chip restano per le cose che **non** sono l'autorizzazione: da dove viene, dove sta, se è
    // archiviata. Il modo di autorizzare e l'esposizione non sono più due targhette da leggere —
    // sono il pulsante qui accanto, che ha una forma e una tinta per ognuno dei tre.
    fill(el.convChips,
      session?.label ? h('span.chip', {}, icon('tag', { size: 11 }), h('span', { text: session.label })) : null,
      session?.imported ? h('span.chip', { text: 'importata', title: 'trovata su disco: il transcript non è stato toccato' }) : null,
      session?.archived ? h('span.chip', { text: 'archiviata', title: 'fuori dall\'elenco, non cancellata' }) : null,
    );
    renderAuthBar();
    document.title = session ? `${session.name} · WRA` : 'WRA';
  }

  // ── la navigazione ─────────────────────────────────────────────────────────
  /** Quante cose ci sono in ogni sezione. Il numero accanto al nome è un **dato**, non un invito. */
  function navCounts() {
    // Le voci di prova si tolgono dal conto **con la stessa regola** della pagina dei progetti: un
    // numero nella testata che non corrisponde a quello che si vede è un programma che sembra rotto.
    const finte = testProjectKeys(state.projects, state.sessions, { hide: state.hideTests });
    return {
      conversations: state.sessions.filter((session) => !session.archived).length,
      projects: state.projects.filter((project) => !project.hidden && !finte.has(project.key)).length,
      activity: state.sessions.filter((session) => isRunning(session)).length,
    };
  }

  function renderNav() {
    const counts = navCounts();
    fill(el.navTabs, ...PAGES.map((page) => h('button.nav-tab', {
      type: 'button',
      'aria-current': state.page === page.id ? 'page' : null,
      // La pagina sta scritta anche in un attributo: i controlli in un browser vero la cercano così,
      // e cercarla nel testo della voce vorrebbe dire romperli il giorno che si cambia una parola.
      dataset: { page: page.id },
      onclick: () => setPage(page.id),
    },
    h('span', { text: page.label }),
    counts[page.id] ? h('span.n', { text: String(counts[page.id]) }) : null)));
  }

  // ── cosa si vede ───────────────────────────────────────────────────────────
  /**
   * Una schermata per volta: le sezioni stanno una sotto l'altra in `#main`, e nasconderne una sola
   * vorrebbe dire vederla ricomparire più in basso.
   */
  function renderChrome() {
    const screen = state.admin ? 'admin'
      : state.auth ? 'auth'
        : state.open ? 'session'
          : state.page;
    const session = screen === 'session';

    el.pageConversations.hidden = screen !== 'conversations';
    el.pageProjects.hidden = screen !== 'projects';
    el.pageActivity.hidden = screen !== 'activity';
    el.paneAdmin.hidden = screen !== 'admin';
    // La schermata dei permessi vive **dentro** la conversazione: è una cosa di quella
    // conversazione, e la sua testata deve continuare a dire quale.
    el.pageSession.hidden = !session && screen !== 'auth';
    el.paneAuth.hidden = screen !== 'auth';
    el.paneChat.hidden = !session || state.view !== 'chat';
    el.paneTerm.hidden = !session || state.view !== 'terminal';
    el.viewport.hidden = !session;
    el.composerWrap.hidden = !session;
    el.tabs.hidden = !session;
    el.convStar.hidden = !session;
    el.convBack.hidden = !session && screen !== 'auth';
    // Le opzioni sono *di una conversazione*: senza una conversazione aperta non c'è niente da
    // opzionare, e un pulsante che risponde «nessuna conversazione aperta» è un pulsante di troppo.
    el.convMenuBtn.hidden = !session;
    el.tabChat.setAttribute('aria-selected', String(session && state.view === 'chat'));
    el.tabTerminal.setAttribute('aria-selected', String(session && state.view === 'terminal'));
    el.navMore.setAttribute('aria-pressed', String(state.admin));
    renderNav();
    renderAuthBar();
    renderAuth();
    renderTermNote();
  }

  // ── da una schermata all'altra ─────────────────────────────────────────────
  /**
   * Cambia pagina.
   *
   * Si esce dalla conversazione aperta, e non è una perdita: la conversazione resta nel registro e
   * il suo processo resta acceso — si smette di guardarla. La testata in alto è la navigazione
   * principale, e un comando di navigazione che non naviga è peggio di un comando che manca: la
   * prima versione lasciava la conversazione sotto, e cliccare «Progetti» sembrava non fare niente.
   */
  function setPage(id) {
    if (id === 'admin') { openAdmin(); return; }
    state.page = id;
    state.admin = false;
    state.auth = false;
    if (state.open) {
      state.open = null;
      rememberOpen(null);
    }
    remember(pageKey, id);
    closeMenus();
    setSelecting(false);
    renderChrome();
    renderPage();
    renderHead();
  }

  /**
   * Il pannello prende il posto della conversazione: è un'altra cosa, e va vista da sola — su un
   * telefono, con due colonne strette, non si amministra niente.
   *
   * Sta nell'indirizzo (`#impostazioni`), così un aggiornamento della pagina ci riporta.
   */
  function openAdmin(where = 'stato') {
    state.admin = true;
    // La voce della testata si segna da `state.page`: senza questa riga l'amministrazione si apriva
    // e nessuna voce risultava corrente — cioè la testata non diceva più dove si era.
    state.page = 'admin';
    state.auth = false;
    setSelecting(false);
    renderChrome();
    closeMenus();
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}#impostazioni`);
    } catch {
      // un indirizzo che non si può riscrivere non deve impedire di aprire il pannello
    }
    return admin.open(where);
  }

  /** Torna alle conversazioni: il pannello non lascia tracce dietro di sé. */
  function closeAdmin() {
    if (!state.admin) return;
    state.admin = false;
    state.page = 'conversations';
    remember(pageKey, 'conversations');
    rememberOpen(state.open);
    renderChrome();
    renderPage();
    renderHead();
    renderChat();
  }

  /**
   * Torna all'elenco. La conversazione resta nel registro e il suo processo resta acceso: qui si
   * smette solo di guardarla — «chiudere» non deve voler dire «spegnere».
   */
  function closeSession() {
    if (!state.open && !state.auth) return;
    state.open = null;
    state.auth = false;
    rememberOpen(null);
    setSelecting(false);
    renderChrome();
    renderPage();
    renderHead();
    renderChat();
  }

  // ── la connessione ─────────────────────────────────────────────────────────
  /**
   * La striscia in cima: «senza rete» e «mi sto riconnettendo» sono due cose diverse — la prima la
   * sa il browser, la seconda il websocket — e nessuna delle due deve restare invisibile.
   */
  function renderBanner() {
    const offline = navigator.onLine === false;
    if (offline) {
      fill(el.banner,
        icon('offline', { size: 16 }),
        h('span.grow', { text: 'Senza rete. La conversazione è qui, ma l\'agente no: quello gira sulla macchina.' }),
        h('button.btn', { type: 'button', text: 'riprova', onclick: () => { refresh(); connect(); } }),
      );
      el.banner.className = 'banner danger';
      el.banner.hidden = false;
      return;
    }
    if (state.connected) {
      el.banner.hidden = true;
      return;
    }
    fill(el.banner,
      icon('refresh', { size: 16, className: 'spin' }),
      h('span.grow', { text: state.failures > 2 ? 'Non riesco a riconnettermi. Il server è acceso?' : 'Riconnessione in corso…' }),
      h('button.btn', { type: 'button', text: 'riprova ora', onclick: () => connect() }),
    );
    el.banner.className = 'banner info';
    el.banner.hidden = false;
  }

  return { renderNav, renderHead, renderChrome, renderBanner, setPage, openAdmin, closeAdmin, closeSession, PAGES };
}
