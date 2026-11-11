// Il terminale: la TUI vera dell'agente, dentro una pagina del browser.
//
// Stava in `app.js`, sparso — la costruzione di xterm da una parte, la misura al resize da
// un'altra, la nota «questa conversazione non ha un processo» da un'altra ancora. Qui è una
// **fabbrica**, come `views/chat.mjs`, e ha una responsabilità sola: mostrare quello che il PTY
// scrive e mandare indietro quello che si preme.
//
// Tre cose che questa vista sa e le altre no:
//
//   1. **xterm non dipinge da nascosto.** Scrive nel buffer anche mentre il riquadro è chiuso, ma
//      non lo disegna: senza un `refresh()` all'apertura della scheda, il terminale si apre *vuoto*
//      su una conversazione che ha già scritto, e si riempie solo al primo tasto premuto. `fit()`
//      non basta, perché se la misura non cambia nessuno chiede un ridisegno.
//   2. **`\x1b[I` e `\x1b[O` non sono tasti.** Sono «il terminale ha preso/ha perso il fuoco», e
//      xterm li manda quando cambia il fuoco della scheda del browser. Inoltrarli al PTY è rumore
//      che finisce dentro la TUI.
//   3. **Ctrl+K si prende, il resto no.** xterm ferma la propagazione dei tasti, quindi l'unico
//      punto in cui intercettarli è la sua API: lì si prende Ctrl+K (la ricerca) e si lascia
//      passare tutto il resto — compresa la barra `/`, che Claude Code usa per i suoi comandi.
import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/fit/lib/addon-fit.mjs';
import { TERMINAL_RESET } from '/ui/terminal-reset.mjs';
import { isRunning } from '/core/session-view.mjs';

/**
 * @param {object} input
 * @param {object} input.state
 * @param {object} input.el
 * @param {Function} input.send          manda al server (`input`, `resize`)
 * @param {Function} input.focusSearch   Ctrl+K: la ricerca, che vive nell'elenco
 * @param {Function} input.currentSession
 */
export function createTerminal({ state, el, send, focusSearch, currentSession }) {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
    fontSize: 13,
    scrollback: 5_000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el.screen);
  fit.fit();

  const FOCUS_ONLY = /^(?:\x1b\[[IO])+$/;

  term.onData((data) => {
    if (state.view !== 'terminal') return;
    if (FOCUS_ONLY.test(data)) return;
    send({ t: 'input', data });
  });

  /**
   * Ctrl+K deve aprire la ricerca **anche quando il fuoco è nel terminale**. Restituire `false`
   * vuol dire «questo tasto non mandarlo al PTY».
   *
   * È l'unico tasto che cc-remote prende al terminale, e vale la pena dirlo: tutto il resto —
   * compresa la barra `/` — arriva al TUI come se questa pagina non ci fosse.
   */
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.altKey && !event.shiftKey) {
      focusSearch();
      return false;
    }
    return true;
  });

  const refit = () => {
    if (state.view !== 'terminal') return;
    try {
      fit.fit();
    } catch {
      return;
    }
    send({ t: 'resize', cols: term.cols, rows: term.rows });
  };
  window.addEventListener('resize', refit);
  new ResizeObserver(refit).observe(el.screen);
  window.matchMedia('(max-width: 60rem)').addEventListener('change', () => refit());

  /**
   * La scheda Terminale si apre **dipinta**, non solo scritta: xterm tiene il buffer anche da
   * nascosto e non lo ridisegna, e `fit()` non basta perché se la misura non cambia non c'è niente
   * che chieda un ridisegno.
   */
  const show = () => {
    fit.fit();
    term.refresh(0, term.rows - 1);
    term.focus();
  };

  /** La sessione è finita — o ne è stata aperta un'altra: il buffer vecchio non è di questa. */
  const reset = () => {
    term.reset?.();
    term.clear();
  };

  /**
   * Il terminale di una conversazione senza processo è una pagina vuota che sembra rotta. Qui dice
   * cosa manca e come si accende — che è l'unica cosa utile da dire in quel momento.
   */
  function renderTermNote() {
    const session = currentSession();
    const visible = state.view === 'terminal' && session && !isRunning(session);
    el.termNote.hidden = !visible;
    if (!visible) return;
    el.termNote.textContent = session.state === 'exited'
      ? 'Il processo di questa conversazione è finito. La conversazione resta: ⋯ → «Accendi il processo» per riprenderla.'
      : 'Questa conversazione non ha un processo acceso: il terminale si riempie quando la riaccendi (⋯ → «Accendi il processo»).';
  }

  return {
    show,
    reset,
    renderTermNote,
    write: (data) => term.write(data),
    clear: () => term.clear(),
    size: () => ({ cols: term.cols, rows: term.rows }),
    endNote: () => term.write(`${TERMINAL_RESET}\x1b[2m[la sessione è finita: la conversazione resta nel registro]\x1b[0m\r\n`),
  };
}
