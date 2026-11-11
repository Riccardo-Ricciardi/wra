// La pagina Attività: cosa gira **adesso** su questa macchina.
//
// È la schermata che risponde a «posso chiudere il portatile?» — un processo per riga, con da
// quanto è acceso. Stava in `app.js` in mezzo alle altre viste; qui è una **fabbrica**, come
// `views/permissions.mjs`: riceve quello che le serve e restituisce le sue funzioni, e non sa
// niente di com'è fatto il resto dell'applicazione.
//
// Quello che le serve è poco, ed è il punto: lo stato, il nodo dove disegnare, e la sola azione
// che una riga sa fare — aprire la conversazione. Non conosce l'elenco, i filtri, la chat né il
// terminale, e nessuno di quelli la conosce.
import { h, fill } from '/ui/dom.mjs';
import { elapsed, STATE_LABEL } from '/core/format.mjs';
import { activityAt, isRunning, projectKeyOf } from '/core/session-view.mjs';

/**
 * @param {object} input
 * @param {object} input.state        lo stato dell'applicazione (si legge, non si scrive)
 * @param {object} input.el           i nodi della pagina
 * @param {(id: string) => void} input.openSession
 */
export function createActivity({ state, el, openSession }) {
  const byActivity = (a, b) => activityAt(b) - activityAt(a);

  function activityRow(session) {
    const project = state.projects.find((entry) => entry.key === projectKeyOf(session)) ?? null;
    const at = Date.parse(session.lastActivityAt ?? session.createdAt ?? '');
    return h('li', {}, h('button.row', {
      type: 'button',
      title: session.projectPath,
      onclick: () => openSession(session.sessionId),
    },
    h('span.dot', { dataset: { state: session.busy ? 'busy' : session.state } }),
    h('span.title', { text: session.name }),
    h('span.what', { text: session.busy ? 'sta lavorando' : STATE_LABEL[session.state] ?? session.state }),
    h('span.where', { text: project?.name ?? projectKeyOf(session).split(/[\\/]/).pop() }),
    h('span.when', { text: Number.isFinite(at) ? elapsed(at) : '' })));
  }

  function renderActivity() {
    const live = state.sessions.filter((session) => isRunning(session)).sort(byActivity);
    const working = live.filter((session) => session.busy).length;

    fill(el.activityBody,
      h('.page-head', {},
        h('.titles', {},
          h('h1', { text: 'Attività' }),
          h('p.lead', { text: 'I processi accesi su questa macchina. Chiudere una conversazione non ne spegne il processo: si smette di guardarla, il lavoro resta.' }))),

      h('.card', {},
        h('.card-head', {},
          h('h2', { text: 'Processi' }),
          h('span.meta', { text: live.length ? `${live.length} accesi${working ? ` · ${working} al lavoro` : ''}` : 'nessuno' })),
        live.length
          ? h('.list', {}, ...live.map((session) => activityRow(session)))
          : h('.empty', {},
            h('strong', { text: 'Niente in esecuzione' }),
            h('p', { text: 'Nessuna conversazione ha un processo acceso. Aprine una e scrivi: il processo parte da solo.' }))));
  }

  return { renderActivity };
}
