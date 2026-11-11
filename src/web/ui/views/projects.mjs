// La pagina Progetti: una riga per cartella, quante conversazioni ci stanno, e i comandi che
// appartengono a quella cartella.
//
// Stava in `app.js` in mezzo alle altre viste. Qui è una **fabbrica**, come `views/permissions.mjs`.
//
// La cosa che questa pagina sa e le altre no: il **nome** di un progetto, la sua stella e il
// «nascosto» sono metadati che vivono accanto al registro, e nessuno di questi comandi tocca la
// cartella sul disco. L'unica eccezione è «apri la cartella», che è dichiarata nel suo suggerimento.
// E c'è la regola di `core/registry-hygiene.mjs`, che è pura e si prova in Node: le voci che hanno
// lasciato i test si vedono, si nascondono, si tolgono — con anteprima, conferma e una copia.
import { h, fill } from '/ui/dom.mjs';
import { icon } from '/ui/icons.mjs';
import { howMany } from '/core/format.mjs';
import { splitProjects, testProjectKeys } from '/core/registry-hygiene.mjs';
import { projectKeyOf, visibleProjects } from '/core/session-view.mjs';

/**
 * @param {object} input
 * @param {object} input.state               lo stato dell'applicazione (si legge, e si scrive solo
 *                                           `projects`/`showHidden`/`hideTests`/`project` — le sue)
 * @param {object} input.el
 * @param {Function} input.api
 * @param {Function} input.ask
 * @param {Function} input.toast
 * @param {Function} input.openMenu
 * @param {Function} input.refresh
 * @param {Function} input.remember
 * @param {Function} input.renderPage        ridisegna quello che si sta guardando
 * @param {Function} input.setPage
 * @param {Function} input.addProject
 * @param {Function} input.createConversation
 * @param {string}   input.hideTestsKey      dove si ricorda «senza le voci di prova»
 */
export function createProjects({
  state, el, api, ask, toast, openMenu, refresh, remember, renderPage, setPage,
  addProject, createConversation, hideTestsKey,
}) {
  const totalInProject = (key) => state.sessions.filter((session) => projectKeyOf(session) === key).length;

  /** Le azioni su un progetto. */
  function projectMenuItems(project) {
    const update = (fields) => api('/local/projects/update', { method: 'POST', body: { path: project.path, ...fields } });
    const total = totalInProject(project.key);
    return [
      {
        label: 'Nuova conversazione qui',
        icon: 'plus',
        run: () => createConversation(project.path),
      },
      {
        label: 'Apri la cartella sul PC',
        icon: 'folder',
        hint: 'dal browser di questa macchina',
        run: async () => {
          await api('/local/projects/open', { method: 'POST', body: { path: project.path } });
          toast('Cartella aperta sul PC');
        },
      },
      {
        label: 'Copia il percorso',
        icon: 'copy',
        run: async () => {
          await navigator.clipboard.writeText(project.path);
          toast('Percorso copiato');
        },
      },
      { separator: true },
      {
        label: 'Rinomina il progetto',
        icon: 'pencil',
        hint: 'solo qui',
        run: async () => {
          const name = await ask({
            title: 'Nome del progetto',
            message: `Cambia solo il nome mostrato in questa interfaccia: la cartella resta ${project.path}. Lascia vuoto per tornare al nome della cartella.`,
            input: { value: project.name, label: 'nome' },
            confirmLabel: 'rinomina',
          });
          if (name === null) return;
          await update({ name });
          await refresh();
        },
      },
      {
        label: 'Progetto preferito',
        icon: 'star',
        checked: Boolean(project.favorite),
        hint: project.favorite ? 'in cima' : '',
        run: async () => {
          await update({ favorite: !project.favorite });
          await refresh();
        },
      },
      {
        label: project.hidden ? 'Rimetti nell\'elenco' : 'Nascondi dall\'elenco',
        icon: project.hidden ? 'refresh' : 'eyeOff',
        checked: Boolean(project.hidden),
        hint: project.hidden ? '' : 'i file non si toccano',
        run: async () => {
          await update({ hidden: !project.hidden });
          await refresh();
        },
      },
      {
        // Vale per le conversazioni di questa cartella che non hanno scelto per sé: una che dice
        // «spento» resta spenta. Non tocca le altre cartelle, e non è una preferenza globale.
        label: 'MCP automatico controllato',
        icon: 'shield',
        checked: Boolean(project.autoApprove),
        hint: project.autoApprove ? 'acceso per le conversazioni di questa cartella' : 'spento',
        run: async () => {
          const next = !project.autoApprove;
          if (next) {
            const ok = await ask({
              title: 'Accendere l\'automatico controllato su questo progetto?',
              message: `Vale per le conversazioni di ${project.name} che non hanno scelto per sé: dentro questa cartella le modifiche non chiederanno il permesso, i comandi e i percorsi fuori no. Una conversazione che dice «spento» resta spenta.`,
              confirmLabel: 'accendi',
            });
            if (!ok) return;
          }
          try {
            await update({ autoApprove: next });
          } catch (error) {
            toast(error.message, 'danger');
            return;
          }
          await refresh();
        },
      },
      { separator: true },
      {
        label: 'Dimentica il progetto',
        icon: 'trash',
        danger: true,
        // Con delle conversazioni dentro non si dimentica: si nasconde. È la differenza fra
        // «non lo voglio vedere» e «non lo voglio più», e la seconda non deve poter cancellare
        // niente per sbaglio.
        hint: total ? `ha ${total} conversazioni: nascondilo` : 'solo l\'etichetta, non la cartella',
        run: async () => {
          const ok = await ask({
            title: 'Dimenticare il progetto?',
            message: `Si perdono nome, stella e «nascosto» di ${project.name}. La cartella e i file non si toccano.`,
            confirmLabel: 'dimentica',
            danger: true,
          });
          if (!ok) return;
          const result = await api('/local/projects/remove', { method: 'POST', body: { path: project.path } });
          state.projects = result.projects ?? state.projects;
          await refresh();
        },
      },
    ];
  }

  /** Un progetto, come riga: nome, cartella, quante conversazioni, e i comandi che gli appartengono. */
  function projectRow(project, count) {
    const menuButton = h('button.icon-btn.menu-btn', {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-label': `opzioni del progetto ${project.name}`,
    }, icon('more', { size: 16 }));
    menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openMenu(menuButton, projectMenuItems(project));
    });

    const newButton = h('button.icon-btn.menu-btn', {
      type: 'button',
      title: 'nuova conversazione qui',
      'aria-label': `nuova conversazione in ${project.name}`,
      onclick: (event) => {
        event.stopPropagation();
        createConversation(project.path).catch((error) => toast(error.message, 'danger'));
      },
    }, icon('plus', { size: 16 }));

    const row = h('button.row', {
      type: 'button',
      title: project.path,
      dataset: { hidden: String(Boolean(project.hidden)) },
      onclick: () => { state.project = project.key; setPage('conversations'); },
    },
      h('span.project-mark', {}, icon(project.favorite ? 'star' : 'folder', { size: 15, className: project.favorite ? 'star' : '' })),
      h('span.title', { text: project.name }),
      project.hidden ? h('span.chip', { text: 'nascosto' }) : null,
      h('span.where', { text: project.path }),
      h('span.count', { title: `${count} conversazioni`, text: String(count) }));

    return h('li', {}, row, newButton, menuButton);
  }

  function renderProjectsPage() {
    const shown = visibleProjects({
      sessions: state.sessions,
      projects: state.projects,
      facet: 'all',
      when: 'any',
      needle: '',
      solo: false,
      showHidden: state.showHidden,
      currentKey: null,
      sort: state.projectSort,
    });
    const hidden = state.projects.filter((project) => project.hidden).length;
    // Le voci che i test hanno lasciato nel registro. Il nome non c'entra: la regola sta in
    // `core/registry-hygiene.mjs`, che è puro e si prova in Node.
    const { test: diProva, sospetti } = splitProjects(state.projects, state.sessions);
    const chiaviDiProva = testProjectKeys(state.projects, state.sessions, { hide: state.hideTests });
    const visibili = state.hideTests
      ? shown.filter((entry) => !chiaviDiProva.has(entry.project.key))
      : shown;

    fill(el.projectsBody,
      h('.page-head', {},
        h('.titles', {},
          h('h1', { text: 'Progetti' }),
          h('p.lead', { text: 'Le cartelle su questa macchina dove girano le conversazioni. Una riga apre le sue conversazioni.' })),
        h('.acts', {},
          h('button.btn', {
            type: 'button',
            onclick: () => addProject().catch((error) => toast(error.message, 'danger')),
          }, icon('plus', { size: 15 }), h('span', { text: 'aggiungi progetto' })))),

      // Un **conteggio** e un interruttore, non tre pillole che si leggono come tre scelte. I tre
      // numeri di prima (`tutti 73 · senza le voci di prova 9 · visibili 73`) erano un filtro e due
      // conteggi messi nella stessa forma, e la forma diceva che erano la stessa cosa.
      h('.toolbar', {},
        h('span.count', { text: howMany(visibili.length, 'un progetto', 'progetti') }),
        h('.grow'),
        hidden
          ? h('button.btn', {
            type: 'button', 'aria-pressed': String(state.showHidden), dataset: { show: 'toggle' },
            onclick: () => setShowHidden(!state.showHidden),
          }, icon(state.showHidden ? 'eyeOff' : 'eye', { size: 15 }),
          h('span', { text: state.showHidden ? 'nascondi i nascosti' : `anche i nascosti (${hidden})` }))
          : null),

      h('.card', {},
        visibili.length
          ? h('.list', {}, ...visibili.map((entry) => projectRow(entry.project, entry.sessions.length)))
          : h('.empty', {},
            h('strong', { text: shown.length ? 'Nessun progetto da mostrare' : 'Nessun progetto' }),
            h('p', { text: shown.length
              ? 'Sono tutte voci di prova: la riga qui sotto dice quante sono e come si mostrano.'
              : 'Aggiungi una cartella che esiste già sul PC: le sue conversazioni compaiono qui.' }))),

      // Le voci di prova: **una riga in fondo**, non un blocco in testa. Sessantaquattro righe
      // davanti alle nove vere erano il difetto più grosso dell'audit — e i progetti veri finivano
      // sotto la piega. Qui si vedono lo stesso, si nascondono, si dimenticano: non occupano la
      // schermata di chi ha novanta progetti veri.
      diProva.length
        ? h('p.note.tests', {},
          h('span', { text: `${howMany(diProva.length, 'una voce di prova', 'voci di prova')} ${state.hideTests ? 'nascoste' : 'in elenco'}: le hanno scritte i test di questo programma, e nessuna conversazione le usa.` }),
          h('button.link-btn', {
            type: 'button', dataset: { tests: state.hideTests ? 'nascosti' : 'tutti' }, 'aria-pressed': String(state.hideTests),
            onclick: () => setHideTests(!state.hideTests),
          }, h('span', { text: state.hideTests ? 'mostrale' : 'nascondile' })),
          h('button.link-btn', {
            type: 'button',
            onclick: () => forgetTestProjects().catch((error) => toast(error.message, 'danger')),
          }, h('span', { text: 'dimentica…' })))
        : null,
      sospetti.length
        ? h('p.note.tests', {},
          h('span', { text: `${howMany(sospetti.length, 'una voce da guardare', 'voci da guardare')}: nessuna conversazione, o una cartella temporanea — ma niente che dica che siano dei test, quindi non si toccano.` }))
        : null,
    );
  }

  function setShowHidden(on) {
    state.showHidden = on;
    renderPage();
  }

  function setHideTests(on) {
    state.hideTests = on;
    // `'0'` e non `''`: «nascoste» è il default, e una preferenza assente deve voler dire quello.
    // Con la stringa vuota, tornare al default non si distingueva da non aver mai scelto.
    remember(hideTestsKey, on ? '1' : '0');
    renderPage();
  }

  /**
   * Dimenticare le voci di prova.
   *
   * Tre passi, e nessuno dei tre si può saltare: si **vede** cosa si sta per togliere (l'anteprima
   * con i percorsi, non solo il numero), si **chiede** conferma con la parola che dice cosa succede,
   * e il server scrive una **copia** prima di toccare il file. Non si cancella niente: si tolgono dei
   * metadati, e le conversazioni con i loro transcript restano dove sono.
   */
  async function forgetTestProjects() {
    const { test: diProva } = splitProjects(state.projects, state.sessions);
    if (!diProva.length) {
      toast('Non c\'è nessuna voce di prova da dimenticare');
      return;
    }
    const esempi = diProva.slice(0, 6).map((voce) => voce.project.path).join('\n');
    const ok = await ask({
      title: `Dimenticare ${howMany(diProva.length, 'una voce', 'voci')} di prova?`,
      message: `Sono metadati di progetto, non conversazioni. Nessuna conversazione e nessun transcript viene toccato, e la cartella sul disco resta dov'è.\n\n${esempi}${diProva.length > 6 ? `\n…e altre ${diProva.length - 6}` : ''}\n\nPrima di scrivere, il server mette da parte una copia di com'era il registro.`,
      confirmLabel: 'dimentica',
      danger: true,
    });
    if (!ok) return;
    try {
      const esito = await api('/local/projects/forget', {
        method: 'POST',
        body: { paths: diProva.map((voce) => voce.project.path) },
      });
      toast(`${esito.removed} voci dimenticate`);
      await refresh();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  return { renderProjectsPage, setShowHidden, setHideTests, forgetTestProjects, projectMenuItems };
}
