// La pagina delle conversazioni: il titolo, i filtri, la ricerca, le righe — con le sezioni quando
// le sezioni ci sono.
//
// Era il pezzo più grosso di `app.js`: la pagina, la riga, il menu della riga, il campo di ricerca,
// il filtro per data e la ricerca dentro i messaggi. Qui è una **fabbrica**, come
// `views/permissions.mjs`, e i confini sono questi:
//
//   - la **selezione** (cosa è spuntato, la barra delle azioni) sta in `views/selection.mjs`, e qui
//     si riceve solo `pick` — la riga sa che cliccare una riga in modalità selezione spunta, e non
//     sa niente di cosa succede dopo;
//   - i **permessi** (`authOf`, `openAuth`) stanno in `views/permissions.mjs`: la riga porta la
//     tinta e il contrassegno del modo, ma chi li calcola e chi li cambia è quell'altro;
//   - le **regole** — cosa è recente, cosa prende un filtro, cosa si raggruppa — stanno in
//     `core/session-view.mjs` e `core/ordering.mjs`, che sono puri e si provano in Node.
//
// Quello che resta qui è disegno e ordinamento della pagina, che è una responsabilità sola.
import { h, fill } from '/ui/dom.mjs';
import { icon } from '/ui/icons.mjs';
import { shortWhen, STATE_LABEL } from '/core/format.mjs';
import { projectNameOf, stateOf } from '/core/authorization.mjs';
import { activityAt, facetCounts, isRunning, passesFacet, projectKeyOf, sectionsOf } from '/core/session-view.mjs';

const FACETS = [
  { id: 'all', label: 'tutte' },
  { id: 'recent', label: 'recenti' },
  { id: 'favorite', label: 'preferite' },
  { id: 'active', label: 'attive' },
  { id: 'archived', label: 'archiviate' },
];

// «Quando» è un asse diverso dallo stato: si combina con il filtro, non lo sostituisce.
const WHEN = [
  { id: 'any', label: 'qualsiasi data' },
  { id: 'today', label: 'oggi' },
  { id: 'week', label: 'ultimi 7 giorni' },
  { id: 'month', label: 'ultimi 30 giorni' },
];

const byActivity = (a, b) => activityAt(b) - activityAt(a);

/**
 * @param {object} input
 * @param {object} input.state
 * @param {object} input.el
 * @param {Function} input.api
 * @param {Function} input.ask
 * @param {Function} input.toast
 * @param {Function} input.openMenu
 * @param {Function} input.refresh
 * @param {Function} input.remember
 * @param {Function} input.renderPage
 * @param {Function} input.queueRender       ridisegna al frame dopo (il campo di ricerca)
 * @param {Function} input.openSession
 * @param {Function} input.addProject
 * @param {Function} input.createConversation
 * @param {Function} input.focusSearch
 * @param {Function} input.pick              dalla selezione: spunta una riga
 * @param {Function} input.authOf            dai permessi: il modo di autorizzare di una conversazione
 * @param {Function} input.openAuth          dai permessi: apre la schermata
 * @param {Function} input.knownLabels
 * @param {string}   input.facetKey
 * @param {string}   input.whenKey
 */
export function createList({
  state, el, api, ask, toast, openMenu, refresh, remember, renderPage, queueRender,
  openSession, addProject, createConversation, focusSearch, pick,
  authOf, openAuth, knownLabels, facetKey, whenKey,
}) {
  const matchesNeedle = (session, needle) => !needle
    || session.name.toLowerCase().includes(needle)
    || String(session.projectPath ?? '').toLowerCase().includes(needle);

  function setFacet(id) {
    state.facet = id;
    remember(facetKey, id);
    renderPage();
  }

  function setWhen(id) {
    state.when = id;
    remember(whenKey, id);
    renderPage();
  }

  /**
   * Il menu di una riga: la stella, la sezione, i permessi, il processo, l'archivio, il nome, l'id,
   * e l'unica voce distruttiva — che chiede conferma e non tocca il disco.
   */
  function conversationMenuItems(session) {
    const current = state.sessions.find((entry) => entry.sessionId === session.sessionId) ?? session;
    const stopped = current.state === 'offline' || current.state === 'exited';
    const authState = authOf(current);
    return [
      {
        label: current.favorite ? 'Togli dalla cima' : 'Fissa in alto',
        icon: 'star',
        checked: Boolean(current.favorite),
        hint: current.favorite ? 'fissata' : 'resta in alto nel suo progetto',
        run: async () => {
          await api(`/local/sessions/${session.sessionId}/favorite`, { method: 'POST', body: { favorite: !current.favorite } });
          await refresh();
        },
      },
      {
        label: 'Sposta in una sezione…',
        icon: 'tag',
        hint: current.label ?? '',
        run: async () => {
          const labels = knownLabels(state.sessions);
          const label = await ask({
            title: 'Sezione',
            message: labels.length
              ? `In uso: ${labels.join(', ')}. Svuota il campo per toglierla dalla sezione. La cartella del progetto non cambia.`
              : 'Una sezione è un\'etichetta per ritrovare le conversazioni: la cartella del progetto non cambia.',
            input: { value: current.label ?? '', label: 'sezione' },
            confirmLabel: 'sposta',
          });
          if (label === null) return;
          await api(`/local/sessions/${session.sessionId}/label`, { method: 'POST', body: { label } });
          await refresh();
        },
      },
      { separator: true },
      {
        // I tre interruttori che decidevano i permessi stavano qui, in mezzo a «copia l'id», e
        // ognuno si spiegava in un suggerimento che da telefono non esiste. Adesso c'è una porta:
        // la decisione si prende in una schermata che dice cosa si sta accettando.
        label: 'Permessi e accesso…',
        icon: authState.tone === 'bypass' || authState.tone === 'combined' ? 'alert' : 'shield',
        danger: authState.tone === 'bypass' || authState.tone === 'combined',
        hint: authState.reach.on ? `${authState.name} · ChatGPT` : authState.name,
        run: async () => openAuth(),
      },
      {
        // «Finita» e «spenta» sono due storie diverse, ma per questo menu sono la stessa cosa:
        // in tutti e due i casi non c'è un processo, e quello che si può fare è accenderlo.
        label: stopped ? 'Accendi il processo' : 'Spegni il processo',
        icon: 'power',
        hint: stopped ? '' : 'la conversazione resta',
        run: async () => {
          await api(`/local/sessions/${session.sessionId}/${stopped ? 'start' : 'stop'}`, { method: 'POST' });
          await refresh();
        },
      },
      {
        label: current.archived ? 'Riprendi dall\'archivio' : 'Archivia',
        icon: current.archived ? 'refresh' : 'file',
        hint: current.archived ? '' : 'esce dall\'elenco, non sparisce',
        run: async () => {
          await api(`/local/sessions/${session.sessionId}/archive`, { method: 'POST', body: { archived: !current.archived } });
          await refresh();
        },
      },
      { separator: true },
      {
        label: 'Rinomina',
        icon: 'pencil',
        run: async () => {
          const name = await ask({ title: 'Rinomina', input: { value: current.name, label: 'nome' }, confirmLabel: 'rinomina' });
          if (!name) return;
          await api(`/local/sessions/${session.sessionId}/rename`, { method: 'POST', body: { name } });
          await refresh();
        },
      },
      {
        label: 'Copia l\'id',
        icon: 'copy',
        hint: session.sessionId.slice(0, 8),
        run: async () => {
          await navigator.clipboard.writeText(session.sessionId);
          toast('Id copiato');
        },
      },
      { separator: true },
      {
        label: 'Togli dall\'elenco',
        icon: 'trash',
        danger: true,
        hint: 'su disco resta',
        run: async () => {
          const ok = await ask({
            title: 'Togliere dall\'elenco?',
            message: `«${current.name}» sparisce da qui. La conversazione su disco non si tocca, e il suo transcript resta al suo posto.`,
            confirmLabel: 'togli', danger: true,
          });
          if (!ok) return;
          await api(`/local/sessions/${session.sessionId}/forget`, { method: 'POST' });
          if (state.open === session.sessionId) state.open = null;
          await refresh();
        },
      },
    ];
  }

  /** Una conversazione, come riga di un elenco. La tinta della riga **è** il modo di autorizzare. */
  function conversationRow(session) {
    const project = state.projects.find((entry) => entry.key === projectKeyOf(session)) ?? null;
    const favorite = Boolean(session.favorite);
    const auth = stateOf(session, project);
    // Tutto quello che una riga non può dire per esteso sta qui: passando sopra si legge, e la riga
    // resta leggibile — che in un elenco di cento è la cosa che conta.
    const summary = [
      session.busy ? 'sta lavorando' : STATE_LABEL[session.state] ?? session.state,
      session.imported ? 'importata: il transcript non è stato toccato' : null,
      session.archived ? 'archiviata: fuori dall\'elenco, non cancellata' : null,
      session.label ? `sezione: ${session.label}` : null,
      auth.combined ? 'ChatGPT può pilotarla E i permessi sono saltati: nessuno approva niente' : null,
      auth.reach.on ? 'ChatGPT può parlarci' : null,
      auth.mode === 'bypass' ? 'permessi saltati: l\'agente non chiede' : null,
      auth.mode === 'auto' ? `automatico controllato: dentro ${projectNameOf(session, project)} non chiede, fuori sì` : null,
    ].filter(Boolean).join(' · ');

    const selected = state.selected.has(session.sessionId);
    const row = h('button.row', {
      type: 'button',
      'aria-current': String(session.sessionId === state.open),
      'aria-selected': state.selecting ? String(selected) : null,
      // La tinta della riga **è** lo stato: normale non ne ha, e le altre ne hanno una che cresce
      // con il privilegio. È quello che si vede di lato senza leggere niente.
      dataset: { state: session.state, favorite: String(favorite), id: session.sessionId, tone: auth.tone },
      title: summary,
      onclick: () => {
        if (state.selecting) pick(session.sessionId);
        else openSession(session.sessionId);
      },
    },
      state.selecting
        ? h('span.pick', { role: 'checkbox', 'aria-checked': String(selected), 'aria-label': `scegli ${session.name}` },
          selected ? icon('check', { size: 13 }) : null)
        : null,
      h('span.dot', { dataset: { state: session.busy ? 'busy' : session.state } }),
      favorite ? icon('star', { size: 12, className: 'pin', filled: true }) : null,
      h('span.title', { text: session.name }),
      // Importata e archiviata sono fatti, non avvisi: un'icona con la sua spiegazione dice la stessa
      // cosa di una targhetta senza rubare mezza riga al nome.
      session.imported ? h('span.mark-ico', { title: 'importata da disco' }, icon('download', { size: 12 })) : null,
      session.archived ? h('span.mark-ico', { title: 'archiviata' }, icon('archive', { size: 12 })) : null,
      // Il modo, in monospaziato e in una parola: non è una spiegazione — quella sta dove si decide —
      // è la conferma di quello che la tinta dice di lato. `normale` non ne ha una, ed è il punto.
      auth.mark ? h('span.auth-mark', { text: auth.mark, title: auth.sentence }) : null,
      // L'esposizione è l'altro asse, e ha un glifo suo: chi può parlarci, non cosa può fare.
      auth.reach.on ? h('span.mark-ico.reach', { title: auth.reach.sentence }, icon('plug', { size: 12 })) : null,
      h('span.where', { text: project?.name ?? projectKeyOf(session).split(/[\\/]/).pop() }),
      h('span.when', { text: shortWhen(session.lastActivityAt ?? session.createdAt) }),
    );

    const menuButton = h('button.icon-btn.menu-btn', {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-label': `opzioni di ${session.name}`,
    }, icon('more', { size: 16 }));
    menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openMenu(menuButton, conversationMenuItems(session));
    });

    return h('li', {}, row, menuButton);
  }

  /**
   * Le righe di un elenco di conversazioni, con le sezioni quando le sezioni ci sono.
   *
   * Le sezioni c'erano nell'elenco a colonna e si erano perse passando alla pagina: un'etichetta si
   * poteva ancora dare (dal menu della conversazione) e non si vedeva più da nessuna parte. La regola
   * di raggruppamento sta in `core/ordering.mjs`, che è provata, e qui si disegna quello che torna:
   * quando non c'è nessuna etichetta torna un gruppo solo senza titolo, e le righe restano piatte.
   */
  function righeDi(sessions) {
    const gruppi = sectionsOf(sessions, state.sort);
    return gruppi.flatMap((gruppo) => [
      gruppo.title ? h('li.group-head', { text: gruppo.title }) : null,
      ...gruppo.sessions.map((session) => conversationRow(session)),
    ].filter(Boolean));
  }

  /**
   * Il campo di ricerca, costruito **una volta sola**.
   *
   * Ridisegnando la pagina a ogni tasto si otteneva un campo nuovo, e il fuoco andava perso: si
   * scriveva una lettera e la seconda finiva nel vuoto. Il campo è l'unico nodo della pagina che ha
   * uno stato suo — dove sta il cursore, cosa c'è selezionato — e quello stato non si ricostruisce.
   * Il resto della pagina si ridisegna, lui no: si aggiornano solo il valore e il pulsante «svuota».
   */
  let campo = null;
  function campoDiRicerca() {
    if (!campo) {
      const svuota = h('button.icon-btn', {
        type: 'button',
        'aria-label': 'svuota la ricerca',
        onclick: () => {
          state.filter = '';
          campo.querySelector('input').value = '';
          state.search = { query: '', state: 'idle', hits: [], truncated: false };
          renderPage();
          focusSearch();
        },
      }, icon('close', { size: 14 }));
      svuota.hidden = true;

      campo = h('.field', {},
        icon('search', { size: 15 }),
        h('input', {
          type: 'search',
          id: 'filter',
          placeholder: 'Cerca per nome o cartella',
          'aria-label': 'cerca fra conversazioni e progetti',
          autocomplete: 'off',
          oninput: (event) => {
            state.filter = event.target.value;
            svuota.hidden = !state.filter;
            // Cambiata la parola, il risultato di prima non vale più: si torna a «si può cercare», e
            // il collegamento per cercare **dentro i messaggi** compare solo quando c'è una parola.
            const scritta = state.filter.trim().toLowerCase();
            if (state.search.query !== scritta) searchSeq += 1;
            state.search = { query: scritta, state: 'idle', hits: [], truncated: false };
            queueRender();
          },
          onkeydown: (event) => {
            if (event.key !== 'Enter') return;
            state.search = { query: '', state: 'idle', hits: [], truncated: false };
            runSearch(state.filter.trim()).catch(() => {});
          },
        }),
        svuota);
    }
    const input = campo.querySelector('input');
    if (input.value !== state.filter) input.value = state.filter;
    campo.querySelector('button').hidden = !state.filter;
    return campo;
  }

  /**
   * Il filtro per data, dove prima stava il menu «ordina e filtra» dell'elenco.
   *
   * Anche questo è costruito una volta sola, e per una ragione misurata: ricostruito a ogni
   * ridisegno, il pulsante sotto il puntatore cambiava **fra la pressione e il rilascio** del mouse —
   * il contatore accanto cambia testo, il gruppo si riallinea di qualche pixel, e il clic finiva nel
   * vuoto. Un bersaglio che si sposta mentre lo si preme non è un bersaglio.
   */
  let bottoneQuando = null;
  function whenMenuButton() {
    if (!bottoneQuando) {
      bottoneQuando = h('button.btn', {
        type: 'button', id: 'when-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      }, icon('clock', { size: 15 }), h('span', { text: 'Quando' }));
      bottoneQuando.addEventListener('click', (event) => {
        event.stopPropagation();
        openMenu(bottoneQuando, WHEN.map((option) => ({
          label: option.label,
          // Una scelta fra poche, non quattro interruttori: `radio` è quello che la disegna così.
          radio: true,
          checked: state.when === option.id,
          run: () => setWhen(option.id),
        })));
      });
    }
    bottoneQuando.dataset.on = String(state.when !== 'any');
    return bottoneQuando;
  }

  /**
   * La ricerca dentro i messaggi. Compare solo quando serve: con una parola scritta e nessun
   * risultato nei nomi, o perché la si è chiesta. Non parte da sola a ogni tasto — leggere i
   * transcript mentre si scrive è il modo di rendere lenta la ricerca invece che utile.
   */
  function searchNode(needle) {
    if (!needle) return null;
    if (state.search.query !== needle) return null;
    if (state.search.state === 'idle') {
      if (state.filter.trim().length < 3) return null;
      return h('.side-note', {}, h('button.link-btn', {
        type: 'button',
        text: `cerca «${state.filter.trim()}» dentro i messaggi`,
        onclick: () => runSearch(state.filter.trim()),
      }));
    }
    if (state.search.state === 'busy') return h('.side-note', { text: 'cerco nei messaggi…' });
    if (state.search.state === 'error') return h('.side-note', { text: state.search.message });

    const hits = state.search.hits;
    return h('.search-hits', {},
      h('.section-head', { text: hits.length ? `nei messaggi (${hits.length})` : 'nei messaggi' }),
      hits.length
        ? h('ul', {}, ...hits.map((hit) => h('li', {}, h('button.hit', {
          type: 'button',
          onclick: () => openSession(hit.sessionId),
        },
        h('.what', { text: hit.name ?? hit.sessionId.slice(0, 8) }),
        h('.who', {}, h('span', { text: hit.role }), hit.at ? h('span', { text: shortWhen(hit.at) }) : null),
        h('.snip', { text: hit.snippet })))))
        : h('.side-note', { text: 'Niente, nei messaggi cercati.' }),
      state.search.truncated
        ? h('.side-note', { text: `guardate ${state.search.scanned} conversazioni su ${state.search.total}: scrivi una parola più precisa, o apri il filtro «tutte».` })
        : null,
    );
  }

  /** La ricerca dentro i messaggi è una cosa che si chiede, non che parte da sola. */
  let searchSeq = 0;
  async function runSearch(query) {
    const seq = (searchSeq += 1);
    state.search = { query, state: 'busy', hits: [], truncated: false };
    renderPage();
    try {
      const result = await api(`/local/search?q=${encodeURIComponent(query)}`);
      // Una risposta arrivata tardi non deve sovrascrivere una ricerca più recente.
      if (seq !== searchSeq) return;
      state.search = {
        query,
        state: 'done',
        hits: result.hits ?? [],
        truncated: Boolean(result.truncated),
        scanned: result.scanned ?? 0,
        total: result.total ?? 0,
      };
    } catch (error) {
      if (seq !== searchSeq) return;
      state.search = { query, state: 'error', message: error.message, hits: [] };
    }
    renderPage();
  }

  /** Una conversazione nuova, nella cartella indicata o in quella di partenza. */
  async function newConversation(projectPath) {
    const path = projectPath ?? state.projects.find((project) => !project.hidden)?.path ?? state.projects[0]?.path;
    if (!path) {
      toast('Prima aggiungi un progetto: la conversazione nasce in una cartella che esiste.', 'danger');
      return;
    }
    await createConversation(path);
  }

  /** La pagina delle conversazioni: un titolo, i filtri, e le righe. */
  function renderConversations() {
    const needle = state.filter.trim().toLowerCase();
    const { counts, whenTotal } = facetCounts(state.sessions, { when: state.when });
    const project = state.project
      ? state.projects.find((entry) => entry.key === state.project) ?? null
      : null;

    const shown = state.sessions
      .filter((session) => passesFacet(session, { facet: state.facet, when: state.when }))
      .filter((session) => (state.project ? projectKeyOf(session) === state.project : true))
      .filter((session) => matchesNeedle(session, needle))
      // Le fissate in cima, poi per attività. Con l'elenco raggruppato per progetto la stella voleva
      // dire «davanti alle altre **del suo progetto**»; adesso l'elenco è piatto, e «fissa in alto»
      // vuol dire in alto: senza questa riga la stella restava accesa e non spostava niente.
      .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || byActivity(a, b));
    const live = shown.filter((session) => isRunning(session));
    // Quelle che girano adesso stanno **sopra**, e sotto non si ripetono: la stessa conversazione due
    // volte nella stessa schermata è la prima cosa che fa sembrare un elenco disordinato, e il numero
    // che il progetto dichiara non tornerebbe più con le righe che si vedono.
    const resto = live.length ? shown.filter((session) => !live.includes(session)) : shown;

    // Il fuoco e il cursore, se stavano nel campo di ricerca: ridisegnando la pagina il campo viene
    // staccato e riattaccato, e senza queste tre righe si scrive una lettera e la seconda finisce nel
    // vuoto. È l'unico nodo della pagina che ha uno stato suo da difendere.
    const attivo = document.activeElement;
    const nelCampo = attivo instanceof HTMLInputElement && attivo.id === 'filter';
    const cursore = nelCampo ? attivo.selectionStart : null;

    fill(el.conversationsBody,
      h('.page-head', {},
        h('.titles', {},
          h('h1', { text: project ? project.name : 'Conversazioni' }),
          h('p.lead', { text: project
            ? 'Le conversazioni di questa cartella.'
            : 'Le conversazioni di Claude Code su questa macchina. Apri una riga per leggerla e rispondere.' })),
        h('.acts', {},
          project
            ? h('button.btn', {
              type: 'button',
              // Il filtro di progetto si vede — il titolo della pagina è il nome del progetto, e
              // questo è il modo di uscirne. Avere un `id` serve ai controlli, che devono poter
              // dire «togli il filtro» senza dipendere da come è scritta la parola.
              id: 'clear-project',
              onclick: () => { state.project = null; renderPage(); },
            }, icon('close', { size: 15 }), h('span', { text: 'tutte' }))
            : null,
          h('button.btn', {
            type: 'button',
            onclick: () => addProject().catch((error) => toast(error.message, 'danger')),
          }, icon('folder', { size: 15 }), h('span', { text: 'aggiungi progetto' })),
          h('button.btn.btn-primary', {
            type: 'button',
            onclick: () => newConversation(project?.path).catch((error) => toast(error.message, 'danger')),
          }, icon('plus', { size: 15 }), h('span', { text: 'nuova' })))),

      h('.toolbar', {},
        campoDiRicerca(),
        h('.grow'),
        h('.seg', { role: 'group', 'aria-label': 'cosa mostrare' },
          ...FACETS.map((facet) => h('button', {
            type: 'button',
            'aria-pressed': String(state.facet === facet.id),
            dataset: { facet: facet.id },
            onclick: () => setFacet(facet.id),
          },
          h('span', { text: facet.label }),
          counts[facet.id] ? h('span.n', { text: String(counts[facet.id]) }) : null)),
          // Il filtro per data si vede quando c'è, e si toglie da qui: un filtro attivo che non si
          // vede è il modo di credere che una conversazione sia sparita.
          state.when === 'any'
            ? null
            : h('button.when', {
              type: 'button',
              title: 'togli il filtro per data',
              onclick: () => setWhen('any'),
            }, icon('clock', { size: 11 }), h('span', { text: WHEN.find((option) => option.id === state.when)?.label ?? state.when }), h('span.n', { text: String(whenTotal) }))),
        whenMenuButton(),
        h('span.count', { text: `${shown.length} di ${state.sessions.length}` })),

      live.length
        ? h('.card.now-block', {},
          h('.card-head', {}, h('h2', { text: 'Adesso' }), h('span.meta', { text: `${live.length} con un processo acceso` })),
          h('.list', {}, ...live.map((session) => conversationRow(session))))
        : null,

      h('.card', {},
        resto.length
          ? h('.list', {}, ...righeDi(resto))
          : h('.empty', {},
            h('strong', { text: shown.length ? 'Sono tutte qui sopra' : needle ? 'Nessun risultato' : 'Niente da mostrare' }),
            h('p', { text: shown.length
              ? 'Le conversazioni con un processo acceso stanno nella scheda «Adesso», e non si ripetono qui sotto.'
              : needle
                ? `Niente che contenga «${state.filter.trim()}» in questa vista. La ricerca dentro i messaggi si chiede con Invio.`
                : state.facet === 'archived'
                  ? 'Nessuna conversazione archiviata.'
                  : 'Il «+» qui sopra ne apre una nuova in un progetto che esiste già.' }))),

      searchNode(needle));

    if (nelCampo) {
      const input = campo.querySelector('input');
      input.focus();
      if (cursore !== null) input.setSelectionRange(cursore, cursore);
    }
  }

  return { renderConversations, conversationMenuItems, setFacet, setWhen, FACETS, WHEN };
}
