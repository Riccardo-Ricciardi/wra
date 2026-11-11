// L'interfaccia: elenco, chat, terminale, approvazioni.
//
// Regola di sempre: si disegna **solo quello che c'è**. Un messaggio viene dal transcript
// (testo, ragionamento, schede degli strumenti coi risultati e i diff), una richiesta di
// permesso dall'hook, lo stato di una chat dal registro. Se un dato non c'è, quel pezzo non
// compare — niente segnaposto, niente "sta pensando" inventato.



import { icon } from '/ui/icons.mjs';
import { h, fill } from '/ui/dom.mjs';
// Dove si mette un menu che appartiene a un pulsante: puro, e si prova in Node.
import { placeAnchored } from '/ui/anchor.mjs';
import { createAdmin } from '/ui/views/admin.mjs';
import { createPermissions } from '/ui/views/permissions.mjs';
import { createActivity } from '/ui/views/activity.mjs';
import { createProjects } from '/ui/views/projects.mjs';
import { createList } from '/ui/views/list.mjs';
import { createSelection } from '/ui/views/selection.mjs';
import { createChat } from '/ui/views/chat.mjs';
import { createTerminal } from '/ui/views/terminal.mjs';
import { createShell } from '/ui/views/shell.mjs';
// Cosa può fare l'agente, e chi può parlarci: due assi, e le frasi che li spiegano vivono in un
// modulo puro (`authorization.mjs`) perché `docs/SECURITY.md` è la fonte e l'interfaccia non può
// contraddirla in due schermate diverse.
import { authorizationOf, projectNameOf, stateOf } from '/core/authorization.mjs';
import { createApi } from '/state/api.mjs';
import { createSocket } from '/state/socket.mjs';

import { knownLabels, projectKeyOf } from '/core/session-view.mjs';

const PROTO = 2;
const TOKEN_KEY = 'cc-remote-token';
const THEME_KEY = 'cc-remote-theme';
const VIEW_KEY = 'cc-remote-view';
const FACET_KEY = 'cc-remote-facet';
const WHEN_KEY = 'cc-remote-when';
const HIDE_TESTS_KEY = 'cc-remote-hide-tests';
// La pagina scelta si ricorda: quella di ieri vale anche stamattina.
const PAGE_KEY = 'cc-remote-page';

const el = {
  nav: document.querySelector('.nav'),
  navTabs: document.getElementById('nav-tabs'),
  navSearch: document.getElementById('nav-search'),
  navMore: document.getElementById('nav-more'),
  brand: document.getElementById('brand'),
  brandMark: document.getElementById('brand-mark'),
  searchIcon: document.getElementById('search-icon'),
  theme: document.getElementById('theme'),
  connWrap: document.getElementById('conn-wrap'),
  conn: document.getElementById('conn'),
  connText: document.getElementById('conn-text'),
  banner: document.getElementById('banner'),
  pageConversations: document.getElementById('page-conversations'),
  conversationsBody: document.getElementById('conversations-body'),
  pageProjects: document.getElementById('page-projects'),
  projectsBody: document.getElementById('projects-body'),
  pageActivity: document.getElementById('page-activity'),
  activityBody: document.getElementById('activity-body'),
  pageSession: document.getElementById('page-session'),
  convBack: document.getElementById('conv-back'),
  selectbar: document.getElementById('selectbar'),
  convName: document.getElementById('conv-name'),
  convProject: document.getElementById('conv-project'),
  convState: document.getElementById('conv-state'),
  convChips: document.getElementById('conv-chips'),
  convStar: document.getElementById('conv-star'),
  busy: document.getElementById('busy'),
  convMenuBtn: document.getElementById('conv-menu-btn'),
  tabChat: document.getElementById('tab-chat'),
  tabTerminal: document.getElementById('tab-terminal'),
  paneChat: document.getElementById('pane-chat'),
  paneTerm: document.getElementById('pane-term'),
  paneAdmin: document.getElementById('pane-admin'),
  paneAuth: document.getElementById('pane-auth'),
  convAuth: document.getElementById('conv-auth'),
  authBar: document.getElementById('auth-bar'),
  tabs: document.querySelector('.tabs-seg'),
  termNote: document.getElementById('term-note'),
  viewport: document.getElementById('viewport'),
  messages: document.getElementById('messages'),
  approvals: document.getElementById('approvals'),
  composer: document.getElementById('composer'),
  composerWrap: document.getElementById('composer-wrap'),
  composerText: document.getElementById('composer-text'),
  send: document.getElementById('send'),
  screen: document.getElementById('screen'),
  menuLayer: document.getElementById('menu-layer'),
  dialogLayer: document.getElementById('dialog-layer'),
  toast: document.getElementById('toast'),
  gate: document.getElementById('gate'),
  gateForm: document.getElementById('gate-form'),
  gateErr: document.getElementById('gate-err'),
  gateMark: document.getElementById('gate-mark'),
  tokenInput: document.getElementById('token'),
};

const state = {
  token: '',
  sessions: [],
  projects: [],
  selections: [],
  approvals: [],
  open: null,
  messages: new Map(), // sessionId -> [messaggio]
  view: 'chat',
  connected: false,
  failures: 0,
  filter: '',
  sort: 'activity',        // com'è ordinato l'elenco delle conversazioni
  projectSort: 'activity', // com'è ordinato l'elenco dei progetti
  facet: 'all',            // cosa si sta guardando: tutte, recenti, preferite, attive, archiviate
  project: null,           // una conversazione sola, un progetto solo: si vede solo quello
  showHidden: false,       // i progetti nascosti si guardano solo se lo si chiede
  hideTests: false,        // le voci che hanno lasciato i test: si nascondono senza toglierle
  when: 'any',             // da quando in qua: si combina con il filtro, non lo sostituisce
  selecting: false,        // si stanno scegliendo più conversazioni
  selected: new Set(),     // quali
  page: 'conversations',   // quale pagina si sta guardando
  admin: false,            // il pannello è aperto al posto della conversazione
  auth: false,             // «questa conversazione»: permessi e accesso, al posto della chat
  search: { query: '', state: 'idle', hits: [], truncated: false },
};

const THEME_ICONS = { '': 'contrast', light: 'sun', dark: 'moon' };
const THEME_LABEL = { '': 'tema: come il sistema', light: 'tema: chiaro', dark: 'tema: scuro' };

// ── piccole cose condivise ───────────────────────────────────────────────────
function setConn(value, text) {
  el.conn.dataset.state = value;
  el.connText.textContent = text;
}

let toastTimer = null;
function toast(message, kind = '') {
  if (!message) return;
  el.toast.textContent = message;
  el.toast.className = kind;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 5_000);
}

function stored(key) {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // finestra privata: si va avanti senza ricordare
  }
}

// Il trasporto sta in `state/`: le rotte in `api.mjs`, il websocket in `socket.mjs`. Qui restano
// due righe di collegamento, perché il resto del file continua a chiamare `api` e `send` come
// prima — il refactoring sposta il codice, non riscrive le chiamate.
const { api } = createApi({ tokenOf: () => state.token });


// ── menu a comparsa e finestre ───────────────────────────────────────────────
let menuAnchor = null;
let menuOpen = null; // { anchor, menu } finché un menu è aperto: serve a riposizionarlo

function closeMenus() {
  fill(el.menuLayer);
  if (menuAnchor) menuAnchor.setAttribute('aria-expanded', 'false');
  menuAnchor = null;
  menuOpen = null;
}

/**
 * Rimette il menu dove va, secondo `ui/anchor.mjs`.
 *
 * Si chiama all'apertura e **anche** quando la finestra cambia misura o la pagina scorre: un menu
 * `fixed` non segue la sua ancora da sé, e un menu che resta fermo mentre la riga si sposta è un
 * menu che punta a un'altra cosa.
 */
function placeMenu() {
  if (!menuOpen) return;
  const { anchor, menu } = menuOpen;
  const box = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const dove = placeAnchored(
    { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
    { width: size.width, height: size.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  menu.style.left = `${dove.left}px`;
  menu.style.top = `${dove.top}px`;
  menu.style.maxHeight = `${dove.height}px`;
  menu.style.overflowY = dove.scroll ? 'auto' : '';
}

window.addEventListener('resize', placeMenu);
// In cattura: la pagina che scorre è `#main`, non la finestra, e un ascoltatore sul documento in
// fase di bolla non la vedrebbe.
window.addEventListener('scroll', placeMenu, true);

/**
 * Un menu ancorato a un pulsante.
 *
 * L'ordine delle righe qui sotto **è** la correzione del difetto. Appeso a `#menu-layer` — un
 * blocco largo quanto la pagina — il menu si misurava largo 1440 invece che 230: il conto per
 * tenerlo dentro lo schermo partiva da lì e finiva sempre nello stesso posto, `left: 8px`, staccato
 * dalla sua ancora e sopra il contenuto. Un blocco **posizionato** invece prende la larghezza del
 * suo contenuto, che è la misura che serve: `position: fixed` va scritta prima di misurare.
 */
function openMenu(anchor, items) {
  closeMenus();
  menuAnchor = anchor;
  const menu = h('.menu', { role: 'menu' });
  for (const item of items) {
    if (item.separator) {
      menu.append(h('.sep'));
      continue;
    }
    // `checked` è un interruttore (una cosa che si accende da sé); `radio` è una **scelta fra
    // poche**, e va disegnata come tale. Il filtro per data era quattro interruttori indipendenti
    // tutti spenti, di una cosa che mutuamente esclusiva: nessuno diceva quale fosse attivo.
    const scelta = item.checked === undefined ? null : (item.radio ? 'radio' : 'check');
    const row = h('button.row', {
      type: 'button',
      role: scelta === null ? 'menuitem' : scelta === 'radio' ? 'menuitemradio' : 'menuitemcheckbox',
      'aria-checked': item.checked === undefined ? null : String(item.checked),
      class: item.danger ? 'danger' : '',
    },
      item.icon ? icon(item.icon, { size: 16 }) : null,
      h('span.label', { text: item.label }),
      scelta === null
        ? (item.hint ? h('span.hint', { text: item.hint }) : null)
        : h(`span.${scelta === 'radio' ? 'radio' : 'switch'}`),
    );
    row.addEventListener('click', async () => {
      closeMenus();
      try {
        await item.run?.();
      } catch (error) {
        toast(error.message, 'danger');
      }
    });
    menu.append(row);
  }

  // Prima si posiziona, poi si mostra: appeso ma non ancora misurato il menu comparirebbe per un
  // istante nell'angolo, che è il difetto di prima visto per un fotogramma.
  menu.style.position = 'fixed';
  menu.style.visibility = 'hidden';
  el.menuLayer.append(menu);
  anchor.setAttribute('aria-expanded', 'true');
  menuOpen = { anchor, menu };
  placeMenu();
  menu.style.visibility = '';
  menu.querySelector('button')?.focus();
}

/**
 * Una finestra per una decisione. Sostituisce `prompt()` e `confirm()`, che fuori dal browser
 * sembrano un'altra applicazione — e su un telefono bloccano la pagina.
 *
 * @returns {Promise<string|boolean|null>} il testo scritto, `true` per conferma, `null` se annulla
 */
function ask({ title, message = '', input = null, confirmLabel = 'conferma', danger = false }) {
  return new Promise((resolve) => {
    const field = input === null ? null : h('input', {
      type: 'text', value: input.value ?? '', 'aria-label': input.label ?? title, maxlength: 80,
    });
    const form = h('form.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', { text: title }),
      message ? h('p', { text: message }) : null,
      field ? h('div.field', {}, field) : null,
      h('.actions', {},
        h('button.btn', { type: 'button', text: 'annulla', onclick: () => finish(null) }),
        h(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, { type: 'submit', text: confirmLabel }),
      ),
    );

    const backdrop = h('.dialog-backdrop', {}, form);
    const finish = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    // Il fuoco resta **dentro** la finestra: `aria-modal="true"` lo promette, e un Tab che esce
    // sulla pagina sotto lo rompe — si finisce a tabulare su cinquecento righe che non si vedono
    // più, e il ritorno non c'è. Si gira fra i pulsanti della finestra e basta.
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const raggiungibili = [...form.querySelectorAll('button, input, [href], select, textarea')]
        .filter((node) => !node.disabled && node.offsetParent !== null);
      if (!raggiungibili.length) return;
      const primo = raggiungibili[0];
      const ultimo = raggiungibili[raggiungibili.length - 1];
      // Con il fuoco già fuori (la finestra si è appena aperta) il primo Tab deve entrare, non
      // saltare al secondo elemento.
      if (!form.contains(document.activeElement)) {
        event.preventDefault();
        primo.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === primo) {
        event.preventDefault();
        ultimo.focus();
      } else if (!event.shiftKey && document.activeElement === ultimo) {
        event.preventDefault();
        primo.focus();
      }
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      finish(field ? field.value.trim() : true);
    });
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) finish(null);
    });
    document.addEventListener('keydown', onKey);

    el.dialogLayer.append(backdrop);
    (field ?? form.querySelector('button')).focus();
    field?.select?.();
  });
}

// ── il pannello ──────────────────────────────────────────────────────────────
// Le primitive arrivano da qui (nodi, icone, rete, finestre, avvisi): `admin.mjs` è
// un'applicazione dentro l'applicazione, e importarle da lì sarebbe un giro circolare.
const admin = createAdmin({
  into: el.paneAdmin,
  h, icon, fill, api, ask, toast,
  tokenOf: () => state.token,
});

// ── tema ─────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const current = document.documentElement.dataset.theme ?? '';
  fill(el.theme, icon(THEME_ICONS[current] ?? 'contrast'));
  el.theme.title = THEME_LABEL[current] ?? THEME_LABEL[''];
  el.theme.setAttribute('aria-label', el.theme.title);
}

el.theme.addEventListener('click', () => {
  const now = document.documentElement.dataset.theme ?? '';
  const next = now === '' ? 'light' : now === 'light' ? 'dark' : '';
  remember(THEME_KEY, next);
  applyTheme(next);
});


// L'«MCP automatico controllato» è acceso? La conversazione vince sul progetto, e nessuno dei due
// vale finché qualcuno non lo accende: `null` sulla conversazione vuol dire «decide il progetto».
const autoApproveOf = (session) => {
  if (typeof session?.autoApprove === 'boolean') return session.autoApprove;
  const project = state.projects.find((entry) => entry.key === projectKeyOf(session));
  return project?.autoApprove === true;
};


// ── la conversazione aperta ─────────────────────────────────────────────────
const currentSession = () => state.sessions.find((session) => session.sessionId === state.open) ?? null;

el.convStar.addEventListener('click', async () => {
  const session = currentSession();
  if (!session) return;
  try {
    await api(`/local/sessions/${session.sessionId}/favorite`, { method: 'POST', body: { favorite: !session.favorite } });
    await refresh();
  } catch (error) {
    toast(error.message, 'danger');
  }
});

// Da dove si torna alle conversazioni: il marchio, in cima alla testata. Da qualunque schermata,
// che è il punto — si esce da dove si è finiti senza doversi ricordare come ci si è arrivati.
el.brand.addEventListener('click', () => {
  if (state.admin) closeAdmin();
  else if (state.open || state.auth) closeSession();
  else setPage('conversations');
});

// Il ritorno dalla conversazione aperta: è la stessa cosa del marchio, ma sta dove il pollice e
// l'occhio lo cercano — a sinistra della testata.
el.convBack.addEventListener('click', () => {
  if (state.auth) closeAuth();
  else closeSession();
});

// Le impostazioni stavano in fondo a una colonna, che su un telefono era il posto meno
// raggiungibile della pagina. Adesso è una voce della testata, allo stesso livello delle altre.
el.navMore.addEventListener('click', (event) => {
  event.stopPropagation();
  openMenu(el.navMore, [
    { label: 'Amministrazione', icon: 'shield', checked: state.admin, run: () => openAdmin() },
    { separator: true },
    { label: 'Aggiungi un progetto', icon: 'folder', run: () => addProject().catch((error) => toast(error.message, 'danger')) },
    { label: 'Seleziona più conversazioni', icon: 'check', checked: state.selecting, run: () => { setPage('conversations'); setSelecting(!state.selecting); } },
    { separator: true },
    ...WHEN.map((option) => ({ label: `Quando: ${option.label}`, radio: true, checked: state.when === option.id, run: () => setWhen(option.id) })),
  ]);
});

el.navSearch.addEventListener('click', () => focusSearch());

// ── Le viste ─────────────────────────────────────────────────────────────────
// Ognuna è una **fabbrica** in `ui/views/`: riceve quello che le serve e restituisce le sue
// funzioni. `app.js` resta il collegamento — chi disegna non decide, chi decide non disegna — e
// l'ordine qui sotto è una dipendenza vera, non alfabetica:
//
//   la **selezione** prima dei permessi, perché i permessi spengono la selezione quando si esce;
//   l'**elenco** dopo i permessi, perché la riga porta la tinta e il contrassegno del modo di
//   autorizzare, e a calcolarli è `permissions.mjs`.
//
// La pagina Attività vuole solo lo stato e il modo di aprire una conversazione; la pagina Progetti
// non sa niente dell'elenco, della chat né del terminale.
const selection = createSelection({ state, el, api, ask, toast, refresh, renderPage, knownLabels });
const { setSelecting, pick, paintSelection, renderSelectBar } = selection;

// Alla chat il trasporto si passa **pigro**, e non è un vezzo: il websocket si costruisce più in
// basso (ha bisogno delle misure del terminale, che nasce dopo), e leggerlo qui una volta sola
// darebbe `undefined`. Le due frecce rinviano la lettura al momento della chiamata — la stessa
// ragione per cui il saluto del websocket legge la misura del terminale dentro una funzione.
const chat = createChat({
  state, el, api, toast, currentSession,
  send: (message) => send(message),
  socketOpen: () => socket.isOpen(),
});
const { renderChat, renderApprovals, upsertApproval, autosize, watchKeyboard } = chat;

const terminal = createTerminal({
  state, el, currentSession, focusSearch,
  send: (message) => send(message),
});

// Il telaio è l'unica vista che **conosce tutte le altre** — è il suo mestiere: sa che esistono
// quattro pagine e un pannello, e mostra una schermata per volta. Per questo nasce per ultima fra
// quelle che disegnano, e i due pezzi che sono dei permessi (`renderAuth`, `renderAuthBar`) le si
// passano **pigri**: la fabbrica dei permessi si costruisce qui sotto e ha bisogno, lei, di
// `renderChrome` e `renderHead`. Le due frecce rompono il giro senza spostare niente di posto.
const shell = createShell({
  state, el, refresh, remember, rememberOpen, closeMenus, renderPage, renderChat,
  setSelecting, currentSession, admin, pageKey: PAGE_KEY,
  renderAuth: (...args) => permissions.renderAuth(...args),
  renderAuthBar: (...args) => permissions.renderAuthBar(...args),
  renderTermNote: terminal.renderTermNote,
  connect: () => socket.start(),
});
const { renderNav, renderHead, renderChrome, renderBanner, setPage, openAdmin, closeAdmin, closeSession, PAGES } = shell;

const permissions = createPermissions({
  state, el, h, fill, icon, api, ask, toast,
  authorizationOf, projectNameOf, projectKeyOf, stateOf,
  currentSession, refresh, rememberOpen, setSelecting,
  renderChrome, renderHead, renderChat, closeMenus, autoApproveOf,
});
const { authOf, openAuth, closeAuth } = permissions;

const list = createList({
  state, el, api, ask, toast, openMenu, refresh, remember, renderPage, queueRender,
  openSession, addProject, createConversation, focusSearch, pick,
  authOf, openAuth, knownLabels, facetKey: FACET_KEY, whenKey: WHEN_KEY,
});
const { renderConversations, conversationMenuItems, setWhen, FACETS, WHEN } = list;

const activity = createActivity({ state, el, openSession });
const { renderActivity } = activity;

const projects = createProjects({
  state, el, api, ask, toast, openMenu, refresh, remember, renderPage, setPage,
  addProject, createConversation, hideTestsKey: HIDE_TESTS_KEY,
});
const { renderProjectsPage } = projects;

// La ricerca nel contenuto si chiede, non parte da sola: leggere i transcript mentre si scrive è il
// modo di rendere lenta la ricerca invece che utile. L'`input` aggiorna la parola, l'Invio cerca —
// e il campo vive nella pagina, quindi i due gestori stanno dove il campo si costruisce.


el.convMenuBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  const session = currentSession();
  if (!session) {
    toast('Nessuna conversazione aperta');
    return;
  }
  openMenu(el.convMenuBtn, conversationMenuItems(session));
});

document.addEventListener('click', (event) => {
  // Il click che ha aperto il menu arriva anche qui: senza questa riga il menu si chiuderebbe
  // nello stesso istante in cui si apre — e sembrerebbe che il pulsante non funzioni.
  if (menuAnchor?.contains(event.target)) return;
  if (!el.menuLayer.contains(event.target)) closeMenus();
});

const isTyping = (node) => node instanceof HTMLElement
  && (node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName));

document.addEventListener('keydown', (event) => {
  const typing = isTyping(event.target);
  const quickSearch = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
  if (quickSearch) {
    // Sulla pagina del token non si ruba niente: lì si sta scrivendo una cosa sola.
    if (!el.gate.hidden) return;
    event.preventDefault();
    focusSearch();
    return;
  }
  // «/» apre la ricerca, **tranne** dentro il terminale: lì la barra è di Claude Code (i comandi
  // cominciano con «/»), e mangiargliela vorrebbe dire rompere il TUI che questa finestra mostra.
  //
  // E tranne dentro una conversazione, che è il caso nuovo: la ricerca è una **pagina**, e aprire
  // la pagina vuol dire chiudere la conversazione — cioè, per una scorciatoia da tastiera, buttare
  // fuori chi stava leggendo. Ctrl+K è «voglio cercare» e ci sta di uscire; «/» è un tasto che si
  // preme mentre si scrive, e lì la barra è un carattere come gli altri. (Il vecchio guscio poteva
  // permetterselo, perché la ricerca stava in una colonna sempre presente.)
  if (event.key === '/' && !typing && !event.ctrlKey && !event.altKey && !event.metaKey) {
    // La barra è del TUI **quando il TUI si vede**: la condizione è quella che sta sullo schermo,
    // non una preferenza ricordata. Con la scheda terminale ricordata ma chiusa, la barra non
    // apriva niente e non scriveva niente — un tasto morto.
    if (!el.paneTerm.hidden) return;
    if (state.open || state.auth || state.admin) return;
    event.preventDefault();
    focusSearch();
    return;
  }
  if (event.key === 'Escape') {
    // La precedenza va a quello che è **aperto**: un menu si chiude con Escape, sempre. Solo se
    // non c'è niente da chiudere, Escape svuota la ricerca — altrimenti il primo Escape se lo
    // mangiava il filtro e il menu restava lì (raggiungibile proprio via Ctrl+K).
    if (el.menuLayer.childElementCount) {
      closeMenus();
      return;
    }
    // Il pannello e «questa conversazione» sono schermate: Escape le chiude, come una finestra.
    if (state.admin && !el.dialogLayer.childElementCount) {
      closeAdmin();
      return;
    }
    if (state.auth && !el.dialogLayer.childElementCount) {
      closeAuth();
      return;
    }
    if (el.dialogLayer.childElementCount) return; // la finestra ha il suo gestore
    // Prima di svuotare la ricerca: se si stanno scegliendo conversazioni, Escape esce di lì.
    if (state.selecting) {
      setSelecting(false);
      return;
    }
    if (!state.filter) return;
    state.filter = '';
    renderPage();
    event.preventDefault();
  }
});

// ── conversazioni ────────────────────────────────────────────────────────────
// L'id che sta nell'indirizzo si apre **alla prima** risposta del server: prima non si sa se
// quella conversazione esiste ancora, e aprirne una che non c'è è una testata che mente.
let pendingOpen = sessionFromHash();

async function refresh() {
  try {
    const data = await api('/local/sessions');
    state.selections = data.selections ?? [];
    state.approvals = data.approvals ?? [];
    state.sessions = data.sessions ?? [];
    state.projects = data.projects ?? [];
    // La conversazione aperta può non esserci più: tolta dall'elenco da un'altra finestra, o da
    // `rc`. Una testata che parla di una conversazione che non esiste è peggio di nessuna testata.
    if (state.open && !state.sessions.some((session) => session.sessionId === state.open)) {
      state.open = null;
      rememberOpen(null);
    }
    queueRender();
    renderChrome();
    renderHead();
    renderApprovals();
    renderChat();
    // All'avvio la conversazione dell'indirizzo si riapre: è quello che rende un aggiornamento
    // della pagina — o un tocco sul link di ieri — un ritorno al posto in cui si era.
    const wanted = pendingOpen;
    if (wanted) {
      pendingOpen = '';
      if (state.sessions.some((session) => session.sessionId === wanted)) {
        openSession(wanted);
        // …e se l'indirizzo diceva anche «permessi», si riapre dove si era.
        if (panelFromHash() === 'permessi') openAuth();
      } else {
        // Una conversazione che non c'è più non resta scritta nell'indirizzo: un indirizzo che
        // promette una cosa e ne mostra un'altra è peggio di nessun indirizzo.
        rememberOpen(null);
      }
    }
  } catch (error) {
    toast(error.message, 'danger');
  }
}

/**
 * Aggiunge un progetto scegliendo una cartella che esiste. La cartella non si crea e non si
 * sposta: si registra, e da lì si possono aprire conversazioni. Un percorso sbagliato lo dice
 * il server, con il motivo (non esiste, o sta fuori dalle radici consentite).
 */
async function addProject() {
  const path = await ask({
    title: 'Aggiungi un progetto',
    message: 'Il percorso di una cartella che esiste già sul PC. Nessun file viene creato o spostato: serve a scegliere dove far nascere le conversazioni.',
    input: { value: '', label: 'percorso della cartella' },
    confirmLabel: 'aggiungi',
  });
  if (!path) return;
  const result = await api('/local/projects/add', { method: 'POST', body: { path } });
  state.projects = result.projects ?? state.projects;
  toast('Progetto aggiunto');
  await refresh();
}

function openSession(sessionId, { fromServer = false } = {}) {
  state.admin = false; // scegliere una conversazione vuol dire uscire dal pannello
  if (state.open !== sessionId) {
    state.open = sessionId;
    if (!state.messages.has(sessionId)) state.messages.set(sessionId, []);
    setSelecting(false);
    renderChat();
    renderChrome();
    renderPage();
    rememberOpen(sessionId);
    if (!fromServer) send({ t: 'open', sessionId });
  }
  closeMenus();
  renderPage();
  renderHead();
}

/**
 * La conversazione aperta sta nell'indirizzo. Senza, un aggiornamento della pagina — o un
 * `Ctrl+R` per sbaglio su un telefono — riporta alla home, e si perde il posto in cui si era.
 */
function rememberOpen(sessionId, panel = '') {
  const hash = sessionId ? `#c=${encodeURIComponent(sessionId)}${panel ? `&${panel}` : ''}` : '';
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  } catch {
    // un indirizzo che non si può riscrivere non deve impedire di aprire la conversazione
  }
}

function sessionFromHash() {
  // `[^&]+` e non `.+`: l'indirizzo può portare anche **quale schermata** era aperta
  // (`#c=<id>&permessi`), e la conversazione è quello che sta prima della e commerciale.
  const given = /^#c=([^&]+)/.exec(location.hash)?.[1];
  if (!given) return '';
  try {
    return decodeURIComponent(given);
  } catch {
    // Un indirizzo scritto a mano e sbagliato (`#c=%E0%A4%A`) non deve impedire di aprire
    // l'applicazione: non è una conversazione, e si va alla home come se non ci fosse.
    return '';
  }
}

/** Quale schermata era aperta sopra la conversazione, se ce n'era una. */
const panelFromHash = () => (/^#c=[^&]+&(permessi)$/.exec(location.hash)?.[1] ?? '');

async function createConversation(projectPath) {
  const created = await api('/local/sessions', { method: 'POST', body: { projectPath } });
  await refresh();
  openSession(created.session.sessionId);
  setView('chat');
}



window.addEventListener('online', () => { renderBanner(); connect(); refresh(); });
window.addEventListener('offline', renderBanner);

// ── websocket ────────────────────────────────────────────────────────────────
/**
 * La connessione, e cosa dire quando cade.
 *
 * Il websocket **non sa disegnare**: prima `connect()` chiamava `setConn`, `renderBanner`,
 * `showGate` e toccava il gate — quattro modi di dire una cosa sola, dentro il modulo di
 * trasporto. Adesso la politica sta qui, il trasporto sta in `state/socket.mjs`, e non sa niente
 * del DOM.
 */
const socket = createSocket({
  openSocket: (protocols) => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return new WebSocket(`${scheme}://${location.host}/ws`, protocols);
  },
  // Una funzione e non un valore: il token si legge **quando ci si connette**. Letto qui una
  // volta sola, la prima connessione partirebbe prima che il token ci sia — ed è esattamente
  // quello che è successo la prima volta che questo codice è girato.
  protocols: () => [`bearer.${state.token}`],
  hello: () => ({
    t: 'hello', proto: PROTO, role: state.view === 'terminal' ? 'terminal' : 'chat',
    ...terminal.size(),
    ...(state.open ? { open: state.open } : {}),
  }),
  onOpen: () => {
    state.connected = true;
    setConn('on', 'connesso');
    renderBanner();
    el.gate.hidden = true;
    if (state.open) send({ t: 'open', sessionId: state.open });
  },
  onMessage: (message) => handle(message),
  onClosed: ({ failures, retrying, giveUp }) => {
    state.connected = false;
    setConn('off', 'non connesso');
    renderBanner();
    if (giveUp) {
      // Il server dice di no: lì il token è davvero sbagliato, e riprovare non lo aggiusta.
      forgetToken();
      showGate('Token rifiutato dal server.');
      return;
    }
    // `1006` è «la connessione è caduta», e succede a ogni riavvio del server. Non si cancella
    // niente: si riprova. Un riavvio non deve far rientrare a mano.
    if (retrying && failures >= 4 && failures % 4 === 0) {
      showGate('Il server non risponde, o il token non è più quello giusto.');
    }
  },
});

const connect = () => socket.start();
const send = (message) => socket.send(message);

function handle(message) {
  if (message.t === 'welcome' || message.t === 'sessions') {
    const stateOfOpen = (list) => (state.open ? list.find((session) => session.sessionId === state.open)?.state ?? null : null);
    const wasOpen = stateOfOpen(state.sessions);
    state.sessions = message.sessions ?? [];
    // La sessione è finita mentre la si guardava: il terminale del browser non deve restare con
    // lo schermo alternativo, il mouse e il cursore nascosto che il TUI aveva acceso. Senza
    // questo, la scheda Terminale resta «sporca» e la cronologia non si scorre più.
    if (stateOfOpen(state.sessions) === 'exited' && wasOpen !== 'exited') {
      terminal.endNote();
    }
    // Il server manda lo stato a ogni pezzo di output del terminale: l'elenco si ridisegna una
    // volta per frame, non una volta per riga scritta dall'agente.
    queueRender();
    renderChrome();
    renderHead();
    return;
  }
  if (message.t === 'opened') {
    openSession(message.session.sessionId, { fromServer: true });
    terminal.reset();

    if (message.replay) terminal.write(message.replay);
    return;
  }
  if (message.t === 'output') {
    if (message.sessionId === state.open) terminal.write(message.data);
    return;
  }
  if (message.t === 'chat') {
    const list = state.messages.get(message.sessionId) ?? [];
    if (message.history) {
      state.messages.set(message.sessionId, [...message.messages]);
    } else {
      for (const incoming of message.messages) {
        const at = list.findIndex((known) => known.id === incoming.id);
        if (at === -1) list.push(incoming);
        else list[at] = incoming;
      }
      state.messages.set(message.sessionId, list);
    }
    if (message.sessionId === state.open) renderChat({ scroll: !message.history });
    return;
  }
  if (message.t === 'approval') {
    upsertApproval(message.approval);
    return;
  }
  if (message.t === 'approval_gone') {
    state.approvals = state.approvals.filter((approval) => approval.id !== message.id);
    delete el.approvals.dataset.fingerprint;
    renderApprovals();
    return;
  }
  // Un permesso concesso dal criterio automatico: non c'è niente da decidere, ma passa davanti
  // agli occhi di chi sta guardando quella conversazione — un permesso dato senza chiedere non
  // deve mai essere invisibile.
  if (message.t === 'approval_auto') {
    toast(`automatico: ${message.approval.toolName} senza chiedere`);
    return;
  }
  if (message.t === 'error') toast(message.message, 'danger');
}

// ── viste ────────────────────────────────────────────────────────────────────
function setView(view, { remember: keep = true } = {}) {
  state.view = view;
  // Quali riquadri si vedono lo decide `renderChrome`, in un posto solo: con il pannello aperto
  // (o senza una conversazione) le regole sono tre, e scritte in due posti divergono.
  renderChrome();
  if (keep) remember(VIEW_KEY, view);

  if (view === 'terminal') {
    // La scheda si apre **dipinta**: vedi `views/terminal.mjs` — xterm tiene il buffer anche da
    // nascosto e non lo ridisegna, e `fit()` non basta se la misura non cambia.
    terminal.show();
  } else {
    renderChat();
    // Il campo si prende il fuoco solo su uno schermo largo: su un telefono, mettere il fuoco
    // fa comparire la tastiera da sola appena si apre la pagina, e mezza conversazione sparisce.
    if (window.matchMedia('(min-width: 60rem)').matches) el.composerText.focus({ preventScroll: true });
  }

  // Il ruolo dice al server se questa finestra scrive: in chat non deve poter ridimensionare
  // il terminale di chi ci sta lavorando dentro.
  send({
    t: 'hello', proto: PROTO,
    role: view === 'terminal' ? 'terminal' : 'chat',
    sessionId: state.open,
    ...terminal.size(),
  });
}

el.tabChat.addEventListener('click', () => setView('chat'));
el.tabTerminal.addEventListener('click', () => setView('terminal'));


// ── token ────────────────────────────────────────────────────────────────────
function tokenFromUrl() {
  const given = new URLSearchParams(location.search).get('token');
  if (!given) return '';
  history.replaceState(null, '', location.pathname + location.hash);
  return given;
}

function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // idem
  }
}

function showGate(reason = '') {
  el.gate.hidden = false;
  el.gateErr.textContent = reason;
  el.tokenInput.focus();
}

el.gateForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = el.tokenInput.value.trim();
  if (!value) return;
  remember(TOKEN_KEY, value);
  state.token = value;
  el.gate.hidden = true;
  start();
});

// ── avvio ────────────────────────────────────────────────────────────────────
async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    // senza service worker l'app funziona lo stesso: si perde solo l'uso senza rete
  }
}

function start() {
  applyTheme(stored(THEME_KEY));

  // Quello che si è scelto ieri vale anche stamattina: pagina, filtro, quando. Un'interfaccia che
  // si dimentica come l'avevi messa la si rimette a posto ogni volta, e allora tanto vale non averla.
  state.facet = FACETS.some((facet) => facet.id === stored(FACET_KEY)) ? stored(FACET_KEY) : 'all';
  state.when = WHEN.some((option) => option.id === stored(WHEN_KEY)) ? stored(WHEN_KEY) : 'any';
  state.page = PAGES.some((page) => page.id === stored(PAGE_KEY)) ? stored(PAGE_KEY) : 'conversations';
  // Le voci che hanno lasciato i test si **nascondono per impostazione predefinita**: sul registro
  // vero sono 64 righe davanti alle 9 cartelle vere, nove delle quali portano lo stesso nome e lo
  // stesso percorso troncato — cioè indistinguibili. Non si cancellano: si mostrano chiedendolo.
  state.hideTests = stored(HIDE_TESTS_KEY) !== '0';
  state.admin = state.page === 'admin';

  // Su uno schermo stretto si apre sempre in chat: il terminale su un telefono è una cosa che
  // si va a cercare, non dove si vuole atterrare.
  const narrow = window.matchMedia('(max-width: 60rem)').matches;
  setView(!narrow && stored(VIEW_KEY) === 'terminal' ? 'terminal' : 'chat', { remember: false });
  renderChrome();
  renderPage();
  connect();
  refresh();
  // Il pannello, quando è aperto, si tiene aggiornato da sé: sono due numeri, non l'elenco di
  // cinquecento conversazioni. E non si ridisegna l'applicazione per aggiornare un contatore.
  setInterval(() => {
    if (state.admin) admin.refresh();
    else refresh();
  }, 5_000);
  // Dopo un ripristino il registro è cambiato sotto: l'elenco va riletto.
  admin.onRestored = () => refresh();
  if (location.hash === '#impostazioni') openAdmin();
  renderBanner();
  autosize();
}
/**
 * Ridisegna quello che si sta guardando — e **solo** quello. Con cinquecento conversazioni,
 * disegnare tre pagine per mostrarne una è il modo di rendere lenta un'interfaccia che non lo è.
 * È anche l'unico punto d'ingresso: `queueRender` passa da qui, e da qui passano i filtri.
 */
function renderPage() {
  renderNav();
  if (state.admin || state.auth || state.open) {
    // La riga della conversazione aperta si segna **anche** con la pagina nascosta: tornando
    // indietro si deve vedere dov'eri. Ridisegnare cinquecento righe a ogni apertura per cambiare
    // un attributo sarebbe il modo di pagare una cosa con l'altra.
    const aperta = state.open;
    const session = aperta ? state.sessions.find((entry) => entry.sessionId === aperta) : null;
    const marca = session ? stateOf(session, state.projects.find((p) => p.key === projectKeyOf(session)) ?? null) : null;
    for (const row of document.querySelectorAll('#conversations-body .list .row[data-id]')) {
      const sua = row.dataset.id === aperta;
      row.setAttribute('aria-current', String(sua));
      // Cambiare il modo di autorizzare si vede subito anche nella riga: la riga **è** lo stato, e
      // una riga che dice «normale» mentre l'agente non chiede è la bugia che questa interfaccia
      // esiste per non dire.
      if (!sua || !marca) continue;
      row.dataset.tone = marca.tone;
      let segno = row.querySelector('.auth-mark');
      if (!segno) {
        segno = h('span.auth-mark');
        row.insertBefore(segno, row.querySelector('.where'));
      }
      segno.textContent = marca.mark ?? '';
      segno.title = marca.mark ? marca.sentence : '';
      // E l'altro asse: chi può parlare con la conversazione. Anche questo si accende da un'altra
      // schermata, e anche questo deve vedersi nella riga **subito** — altrimenti si torna
      // indietro, si guarda l'elenco, e l'esposizione appena concessa non c'è.
      let presa = row.querySelector('.mark-ico.reach');
      if (marca.reach.on && !presa) {
        presa = h('span.mark-ico.reach', { title: marca.reach.sentence }, icon('plug', { size: 12 }));
        row.insertBefore(presa, row.querySelector('.where'));
      } else if (!marca.reach.on && presa) {
        presa.remove();
      } else if (presa) {
        presa.title = marca.reach.sentence;
      }
    }
    paintSelection();
    return;
  }
  if (state.page === 'projects') renderProjectsPage();
  else if (state.page === 'activity') renderActivity();
  else renderConversations();
  paintSelection();
  renderSelectBar();
}

/** Porta il fuoco sulla ricerca. Il campo vive nella pagina delle conversazioni: se non è quella
 *  che si sta guardando, ci si va — una scorciatoia che non porta da nessuna parte non è una
 *  scorciatoia. */
function focusSearch() {
  if (state.open || state.auth || state.admin || state.page !== 'conversations') setPage('conversations');
  const field = document.querySelector('#conversations-body input[type="search"]');
  field?.focus();
  field?.select();
}
// Il disegno passa da un frame. Il server manda lo stato delle sessioni a ogni pezzo di output del
// terminale: ridisegnare per ogni riga che l'agente scrive è il modo di rendere lenta
// un'interfaccia che non ha niente di lento.
let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderPage();
    renderHead();
  });
}

// Le icone statiche della pagina
fill(el.brandMark, icon('terminal', { size: 13 }));
fill(el.gateMark, icon('terminal', { size: 13 }));
fill(el.searchIcon, icon('search', { size: 15 }));
fill(el.convMenuBtn, icon('more', { size: 18 }));
fill(el.convStar, icon('star', { size: 17 }));
fill(el.convBack, icon('arrowLeft', { size: 18 }));
fill(el.navMore, icon('more', { size: 17 }));
fill(el.send, icon('send', { size: 17 }));
el.convBack.title = 'torna alle conversazioni';
watchKeyboard();
registerWorker();

const fromUrl = tokenFromUrl();
const initial = fromUrl || stored(TOKEN_KEY);
if (initial) {
  state.token = initial;
  if (fromUrl) remember(TOKEN_KEY, fromUrl);
  start();
} else {
  applyTheme(stored(THEME_KEY));
  showGate();
}
