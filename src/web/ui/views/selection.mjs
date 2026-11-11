// La selezione multipla: spuntare più conversazioni e fare qualcosa su tutte insieme.
//
// Stava in `app.js`, mescolata all'elenco che disegna le righe su cui si spunta. Qui è una
// **fabbrica**, come `views/permissions.mjs`, e la divisione è quella vera: l'elenco sa disegnare
// una riga e scegliere cosa mostrarne; la selezione sa quali righe sono spuntate e cosa succede
// quando se ne preme una. Nessuno dei due conosce i filtri dell'altro.
//
// La regola che tiene insieme il tutto: **non ridisegna l'elenco**. Spuntare cambia quello che è
// già disegnato — l'attributo della riga e la barra — perché con cinquecento righe un ridisegno a
// ogni spunta è la differenza fra «selezionare è comodo» e «selezionare è lento».
import { h, fill } from '/ui/dom.mjs';
import { icon } from '/ui/icons.mjs';
import { howMany } from '/core/format.mjs';
import { isRunning } from '/core/session-view.mjs';

/**
 * @param {object} input
 * @param {object} input.state
 * @param {object} input.el
 * @param {Function} input.api
 * @param {Function} input.ask
 * @param {Function} input.toast
 * @param {Function} input.refresh
 * @param {Function} input.renderPage
 * @param {(sessions: Array<object>) => Array<string>} input.knownLabels
 */
export function createSelection({ state, el, api, ask, toast, refresh, renderPage, knownLabels }) {
  /**
   * Le righe che si stanno guardando adesso. Si leggono dal DOM e non dallo stato perché i filtri
   * sono già passati di lì: «quello che si vede» e «quello che si prenderebbe» devono essere la
   * stessa cosa, e con due elenchi calcolati in due posti prima o poi non lo sono più.
   */
  const pickedRows = () => [...document.querySelectorAll('#conversations-body .list .row[data-id]')];

  /** Spunta, riga per riga, senza ridisegnare l'elenco. */
  function paintSelection() {
    for (const row of pickedRows()) {
      const on = state.selected.has(row.dataset.id);
      row.setAttribute('aria-selected', String(on));
      const box = row.querySelector('.pick');
      if (!box) continue;
      box.setAttribute('aria-checked', String(on));
      fill(box, on ? icon('check', { size: 13 }) : null);
    }
    renderSelectBar();
  }

  /**
   * La selezione multipla. Non ridisegna l'elenco: cambia quello che è già disegnato e la barra
   * delle azioni.
   */
  function setSelecting(on) {
    state.selecting = on;
    if (!on) state.selected.clear();
    renderPage();
  }

  function pick(id, on) {
    if (on ?? !state.selected.has(id)) state.selected.add(id);
    else state.selected.delete(id);
    paintSelection();
  }

  /** Tutto quello che c'è nell'elenco adesso — filtri compresi: quello che si vede è quello che si prende. */
  function pickVisible() {
    const ids = pickedRows().map((row) => row.dataset.id);
    const all = ids.length > 0 && ids.every((id) => state.selected.has(id));
    for (const id of ids) {
      if (all) state.selected.delete(id);
      else state.selected.add(id);
    }
    paintSelection();
  }

  /**
   * La barra delle azioni. Dice **quante** conversazioni prende ogni azione prima di premerla: un
   * «archivia» senza numero è un pulsante di cui non ti fidi.
   */
  function renderSelectBar() {
    const ids = [...state.selected];
    // La barra c'è da quando si accende la selezione, anche a mani vuote: è lì che sta il modo di
    // uscirne. Una modalità senza uscita visibile si lascia accesa per sbaglio.
    el.selectbar.hidden = !state.selecting;
    if (el.selectbar.hidden) return;
    const list = state.sessions.filter((session) => state.selected.has(session.sessionId));
    const archived = list.filter((session) => session.archived).length;
    const running = list.filter(isRunning).length;
    const visible = pickedRows().map((row) => row.dataset.id);
    const allPicked = visible.length > 0 && visible.every((id) => state.selected.has(id));

    const act = (label, iconName, run, { danger = false } = {}) => h(`button.act${danger ? '.danger' : ''}`, {
      type: 'button',
      title: label,
      disabled: ids.length === 0,
      onclick: () => run().catch((error) => toast(error.message, 'danger')),
    }, icon(iconName, { size: 14 }), h('span', { text: label }));

    fill(el.selectbar,
      h('.bar-head', {},
        h('strong', { text: ids.length ? howMany(ids.length, '1 selezionata', 'selezionate') : 'nessuna selezionata' }),
        running ? h('span.chip.accent', { text: `${running} accese` }) : null,
        h('span.grow'),
        h('button.link-btn', { type: 'button', text: allPicked ? 'nessuna' : 'tutte', title: 'scegli tutto quello che si vede', onclick: pickVisible }),
      ),
      h('.bar-acts', {},
        act(archived === ids.length ? 'riprendi' : 'archivia', 'archive', () => bulkArchive(archived !== ids.length, running)),
        act('fissa', 'star', () => bulk('favorite', { favorite: true })),
        act('sezione', 'tag', () => bulkSection()),
        act('chiudi', 'close', async () => setSelecting(false)),
      ),
    );
  }

  /**
   * Un'azione su più conversazioni.
   *
   * `ponytail:` una richiesta per conversazione, sulla rotta che esiste già — in locale il giro è di
   * millisecondi e non c'è niente da inventare. Una rotta di gruppo (`POST /local/sessions/bulk`)
   * quando le selezioni si conteranno a migliaia, o quando servirà che l'azione sia atomica.
   */
  async function bulk(action, body) {
    const ids = [...state.selected];
    let done = 0;
    const failed = [];
    for (const id of ids) {
      try {
        // `encodeURIComponent` per abitudine, non per necessità: oggi gli id sono quelli del
        // server, ma la rotta si compone da un dato e non deve dipendere dalla sua forma.
        await api(`/local/sessions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });
        done += 1;
      } catch (error) {
        failed.push(`${state.sessions.find((s) => s.sessionId === id)?.name ?? id.slice(0, 8)}: ${error.message}`);
      }
    }
    setSelecting(false);
    await refresh();
    report(done, ids.length, failed);
  }

  /** Quante ne ha prese, e quali no: un'azione in blocco che tace sui fallimenti è una bugia. */
  function report(done, total, failed) {
    if (failed.length) {
      toast(`fatte ${done} su ${total}. Non riuscite: ${failed.slice(0, 2).join(' · ')}${failed.length > 2 ? ` e altre ${failed.length - 2}` : ''}`, 'danger');
      return;
    }
    toast(total === 1 ? 'fatto' : `fatte ${done} conversazioni`);
  }

  /**
   * Archiviare spegne i processi: è l'unica azione in blocco che cambia qualcosa mentre accade.
   *
   * «1 conversazione» e «3 conversazioni»: un numero scritto accanto a una parola al plurale
   * sbagliato è la prima cosa che fa sembrare approssimativa un'interfaccia.
   */
  async function bulkArchive(archive, running) {
    const ids = state.selected.size;
    if (archive) {
      const spenta = running === 1
        ? 'La conversazione accesa fra queste viene spenta.'
        : `Le ${running} conversazioni accese fra queste vengono spente.`;
      const ok = await ask({
        title: `Archiviare ${howMany(ids, 'una conversazione', 'conversazioni')}?`,
        message: `${running ? `${spenta} ` : ''}Niente viene cancellato: né le conversazioni né i transcript. Escono dall'elenco e si ritrovano nel filtro «archiviate».`,
        confirmLabel: 'archivia',
      });
      if (!ok) return;
    }
    await bulk('archive', { archived: archive });
  }

  async function bulkSection() {
    const ids = state.selected.size;
    const labels = knownLabels(state.sessions);
    const label = await ask({
      title: 'Sezione',
      message: `${ids === 1 ? 'Si sposta una conversazione' : `Si spostano ${ids} conversazioni`} in una sezione: è un'etichetta per ritrovarle, e la cartella del progetto non cambia. Svuota il campo per toglierle dalla sezione.${labels.length ? ` In uso: ${labels.join(', ')}.` : ''}`,
      input: { value: '', label: 'sezione' },
      confirmLabel: 'sposta',
    });
    if (label === null) return;
    await bulk('label', { label });
  }

  return { setSelecting, pick, paintSelection, renderSelectBar, pickedRows };
}
