// Quali voci del registro le hanno scritte i test.
//
// Il nome **non** è una prova. `progetto-auto-2` può benissimo essere il nome di un progetto di
// qualcuno, e cancellare per somiglianza di nome è il modo di cancellare il lavoro di qualcun
// altro. Le prove sono un'altra cosa: cose che il codice di produzione non può aver prodotto.
//
// `SEGNI_SOLO_DEI_TEST` sono stringhe che compaiono **solo** dentro `test/e2e.stub.test.mjs`:
// `cc-remote-e2e-` è il prefisso delle cartelle temporanee che quel file crea, `progetto-auto-` una
// sottocartella che scrive. C'è un test che lo verifica scandendo `src/` — se un giorno qualcuno
// usasse uno di questi nomi nel codice di produzione, quel test fallisce e la decisione torna a
// essere una decisione, invece di una riga di questo file che nessuno rilegge.
//
// Serve a due cose, e sono diverse:
//   1. **nascondere** le voci di prova da un elenco, senza toccare niente (reversibile);
//   2. proporre una **pulizia**, che è distruttiva e chiede conferma, anteprima e una copia.

/** Stringhe che il codice di produzione non scrive mai. Vedi `test/registry-hygiene.test.mjs`. */
export const SEGNI_SOLO_DEI_TEST = ['cc-remote-e2e-', 'progetto-auto-'];

const inTemporanea = (percorso) => /(^|[\\/])(temp|tmp)([\\/]|$)/i.test(percorso);

/**
 * Il verdetto su una voce di progetto, con le prove che lo sostengono.
 *
 * @param {{path?: string, key?: string}} project
 * @param {{sessions?: number}} [context]  quante conversazioni la usano
 * @returns {{test: boolean, weak: boolean, signals: {id: string, detail: string}[]}}
 *   `test` è «sicuramente di prova»: due prove indipendenti, e fra queste quella che viene dal
 *   codice. Una prova sola non basta mai — una cartella in `%TEMP%` può essere un progetto vero, e
 *   un progetto appena aggiunto non ha ancora conversazioni.
 */
export function verdictOf(project, { sessions = 0 } = {}) {
  const percorso = String(project?.path ?? project?.key ?? '');
  const signals = [];

  for (const segno of SEGNI_SOLO_DEI_TEST) {
    if (percorso.toLowerCase().includes(segno)) {
      signals.push({ id: 'test-name', detail: `il percorso contiene «${segno}», che il codice di produzione non scrive` });
      break;
    }
  }
  if (inTemporanea(percorso)) signals.push({ id: 'temp', detail: 'la cartella sta in una cartella temporanea' });
  if (sessions === 0) signals.push({ id: 'empty', detail: 'nessuna conversazione la usa' });

  const dalCodice = signals.some((signal) => signal.id === 'test-name');
  // `sessions === 0` non è una prova fra le altre: è una **condizione**. Una voce di progetto usata
  // da una conversazione non si dichiara di prova nemmeno se tutto il resto grida il contrario —
  // una cartella temporanea con del lavoro dentro è una cartella con del lavoro dentro, e il modo
  // di perdere il lavoro di qualcuno è decidere che quel lavoro non conta perché il nome sembra
  // finto. Il test qui sotto lo tiene fermo.
  const test = dalCodice && sessions === 0 && signals.length >= 2;
  return {
    test,
    // Una prova sola: si mostra, e **non** si propone di toglierla. È la differenza fra un filtro
    // che aiuta e un filtro che decide al posto di chi guarda.
    weak: !test && signals.length > 0,
    signals,
  };
}

/**
 * Divide le voci di progetto in tre gruppi. Il resto del programma non deve sapere come si
 * riconosce un test: chiede qui, e ottiene tre elenchi.
 *
 * @param {Array<{path?: string, key?: string}>} projects
 * @param {Array<{projectKey?: string, projectPath?: string}>} sessions
 */
export function splitProjects(projects, sessions = []) {
  const usi = new Map();
  for (const session of sessions) {
    const chiave = session.projectKey ?? session.projectPath;
    if (chiave) usi.set(chiave, (usi.get(chiave) ?? 0) + 1);
  }

  const test = [];
  const sospetti = [];
  const veri = [];
  for (const project of projects) {
    const count = usi.get(project.key) ?? usi.get(project.path) ?? 0;
    const verdict = verdictOf(project, { sessions: count });
    const voce = { project, sessions: count, ...verdict };
    if (verdict.test) test.push(voce);
    else if (verdict.weak) sospetti.push(voce);
    else veri.push(voce);
  }
  return { test, sospetti, veri };
}

/**
 * Le chiavi delle voci che i test hanno lasciato, quando vanno nascoste.
 *
 * Esiste perché la regola dev'essere **una**: il numero accanto a «Progetti» nella testata e le
 * righe della pagina dei progetti la chiedono tutte e due, e due conti fatti in due posti prima o
 * poi dicono due numeri — che è esattamente il modo di far sembrare rotto un programma che non lo è.
 *
 * @param {Array<object>} projects
 * @param {Array<object>} sessions
 * @param {{hide?: boolean}} [options]  `hide: false` vuol dire «si mostrano»: insieme vuoto
 * @returns {Set<string>}
 */
export function testProjectKeys(projects, sessions, { hide = true } = {}) {
  if (!hide) return new Set();
  return new Set(splitProjects(projects, sessions).test.map((voce) => voce.project.key));
}
