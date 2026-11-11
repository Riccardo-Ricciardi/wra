// I tre modi di autorizzare una conversazione, e il quarto stato che nasce dalla loro
// combinazione — scritti **una volta sola**, come funzioni pure.
//
// Perché un modulo e non qualche `if` dentro il disegno: perché la cosa che l'interfaccia deve
// dire è un fatto sul modello di sicurezza, e `docs/SECURITY.md` è la fonte. Se la frase che
// spiega il bypass vive dentro un `render`, prima o poi due schermate la dicono in due modi
// diversi, e una delle due promette qualcosa che il sistema non fa. Qui la frase è una sola, e
// si prova in Node (`test/authorization.test.mjs`) senza aprire un browser.

/** Le tre modalità che questa schermata sa **offrire**, in ordine crescente di privilegio. */
export const MODES = ['normal', 'auto', 'bypass'];

/** Da meno a più permissivo: `normale` è il default, `bypass` è il fondo. */
const RANK = { normal: 0, auto: 1, bypass: 2 };

/**
 * Le modalità che `claude` accetta, che il server lascia passare, e che questa schermata **non**
 * sa descrivere — perché non è lei a sceglierle: arrivano da `claude --permission-mode` all'avvio
 * di una conversazione, o da un `POST` che le ha chieste per nome.
 *
 * `manual` è documentata come uguale a `default`, quindi non è «altro»: è normale.
 *
 * **`acceptEdits` è il motivo per cui questo elenco esiste.** Approva da sé le letture, le
 * modifiche di file e i comandi di filesystem comuni (`mkdir`, `touch`, `mv`, `cp`) dentro la
 * cartella del progetto (`docs/SECURITY.md`, dalla tabella delle modalità native di Claude Code).
 * Dipingerla come «Normale — ogni comando chiede» sarebbe la bugia peggiore che questa schermata
 * possa dire: è esattamente il caso per cui esiste, cioè una conversazione che agisce senza
 * chiedere mostrata come la meno allarmante di tutte.
 *
 * Per le altre che non conosciamo la posizione onesta è **«non lo so»**, non una supposizione: su
 * una schermata che dice cosa può fare l'agente, sbagliare verso l'allarme costa una lettura,
 * sbagliare verso la calma costa quello che il prodotto serve a evitare.
 */
const DESCRITTE = {
  acceptEdits: {
    sentence: 'Questa non è la modalità normale: Claude Code approva da sé le letture, le '
      + 'modifiche di file e i comandi di filesystem comuni (`mkdir`, `touch`, `mv`, `cp`) dentro '
      + 'la cartella del progetto. Tutto il resto chiede.',
    accept: 'Stai accettando che l\'agente modifichi file, e ne sposti e ne copi, dentro il '
      + 'progetto senza chiedere. È una modalità di Claude Code, non di cc-remote: si sceglie '
      + 'all\'avvio della conversazione, e questa schermata non l\'ha impostata.',
  },
};

/**
 * Il modo **efficace** di una conversazione.
 *
 * Quattro valori e non tre: `normal`, `auto`, `bypass`, e **`other`** per una modalità che il
 * server accetta ma che qui non sappiamo descrivere. `other` non è un caso di scuola — è la
 * differenza fra una schermata che dice la verità e una che dice «Normale» a una conversazione
 * che modifica file da sola.
 *
 * Sono due sorgenti e vince la più permissiva: la modalità della conversazione (`permissionMode`)
 * e l'automatico controllato, che può essere acceso sulla conversazione o ereditato dal progetto.
 * Un progetto in automatico con una conversazione in bypass è in bypass: dire «automatico» lì
 * sarebbe una bugia comoda.
 */
export function modeOf(session, project = null) {
  if (!session) return 'normal';
  const raw = session.permissionMode;
  if (raw === 'bypassPermissions') return 'bypass';
  // `default` e `manual` sono la stessa cosa; `null` (o assente) vuol dire «non l'ho mai decisa»,
  // e allora vale la modalità di partenza del server, che è `default`.
  if (raw && raw !== 'default' && raw !== 'manual') return 'other';
  // Nel registro `false` e `null` sono due cose diverse: `null` vuol dire «non ho deciso», e
  // allora vale il progetto; `false` vuol dire «qui no», e vince. Trattarli uguali vorrebbe dire
  // che una conversazione non può sottrarsi all'automatico della sua cartella.
  const auto = session.autoApprove === true
    || (session.autoApprove !== false && project?.autoApprove === true);
  return auto ? 'auto' : 'normal';
}

/** Il nome del progetto come lo si dice a voce: la cartella, non il percorso intero. */
export function projectNameOf(session, project = null) {
  if (project?.name) return project.name;
  const path = String(session?.projectPath ?? '');
  return path.split(/[\\/]/).filter(Boolean).pop() ?? 'questo progetto';
}

/**
 * Cosa può fare l'agente in questa conversazione, detto in modo che si capisca — con la frase
 * per esteso e con **cosa si sta accettando**. `accept` è vuoto per la modalità normale: non si
 * sta accettando niente, ed è esattamente il punto.
 */
export function authorizationOf(session, project = null) {
  const mode = modeOf(session, project);
  const where = projectNameOf(session, project);
  const inherited = mode === 'auto' && session?.autoApprove !== true;

  if (mode === 'bypass') {
    return {
      mode,
      rank: RANK[mode],
      name: 'Bypass',
      short: 'bypass',
      inherited: false,
      sentence: 'L\'agente non chiede mai il permesso: nessun comando, in nessun percorso, '
        + 'passa da una richiesta da approvare.',
      accept: 'Stai accettando che l\'agente esegua qualunque comando con i tuoi privilegi su '
        + 'questo PC, senza chiedere e senza avvisare. Non c\'è niente, qui dentro, che lo fermi.',
      tone: 'bypass',
    };
  }

  if (mode === 'other') {
    const raw = String(session?.permissionMode);
    const known = DESCRITTE[raw];
    return {
      mode,
      rank: RANK.auto, // non sappiamo quanto sia permissiva: si tratta come l'automatico, mai meno
      name: raw,
      short: raw,
      inherited: false,
      known: Boolean(known),
      sentence: known ? known.sentence
        : `Questa conversazione è in «${raw}», una modalità di Claude Code che questa schermata `
          + 'non sa descrivere. Quello che non so è cosa approva da sé — e su una schermata che '
          + 'dice cosa può fare l\'agente, «non lo so» è la risposta, non una supposizione.',
      accept: known ? known.accept : '',
      tone: 'other',
    };
  }

  if (mode === 'auto') {
    return {
      mode,
      rank: RANK[mode],
      name: 'Automatico controllato',
      short: 'auto',
      inherited,
      sentence: `Dentro ${where} le letture e le modifiche di file non chiedono il permesso. `
        + 'Fuori dal progetto, i comandi, le credenziali, `.claude/` e `.git/` chiedono ancora.',
      accept: `Stai accettando che l'agente legga e modifichi i file di ${where} senza chiedere.`,
      tone: 'auto',
    };
  }

  return {
    mode: 'normal',
    rank: RANK.normal,
    name: 'Normale',
    short: 'normale',
    inherited: false,
    sentence: 'L\'agente chiede il permesso prima di agire: ogni comando e ogni modifica passa '
      + 'da una richiesta che approvi tu.',
    accept: '',
    tone: 'normal',
  };
}

/**
 * L'altro asse: **chi** può parlare con questa conversazione. Non è un modo di autorizzare, ed è
 * per questo che non ha la stessa forma né la stessa tinta — chi guarda non deve poterli
 * confondere.
 *
 * `expired` è il caso che conta: il consenso è scritto nel registro ma non vale più. Va detto,
 * perché altrimenti l'interruttore risulta acceso e la conversazione non risponde.
 */
/**
 * Se un client esterno può parlare con questa conversazione.
 *
 * Due campi e non uno, e non è un ramo di compatibilità da ricordarsi: `mcpReachable` è la
 * risposta completa — tiene conto del consenso scaduto e dell'archivio — ma esiste solo dove il
 * consenso esiste. Dove non c'è, l'interruttore `mcpAllowed` **è** la risposta: non c'è nessun
 * consenso che possa scadere. Leggere il primo e ripiegare sul secondo vuol dire soltanto che,
 * quando i due campi convivono, vince quello che sa più cose.
 */
export const reachableOf = (session) => (session?.mcpReachable === undefined
  ? session?.mcpAllowed === true
  : session.mcpReachable === true);

export function reachOf(session) {
  if (!session) return { on: false, expired: false, archived: false, name: 'ChatGPT', sentence: '', tone: 'normal' };
  const on = reachableOf(session);
  const scritta = session.mcpAllowed === true;
  // Perché non è raggiungibile **pur essendo scritta**: sono tre ragioni diverse e vanno dette
  // ognuna per quello che è. Dire «il consenso è scaduto» a una conversazione archiviata è la
  // direzione giusta con la ragione sbagliata, e una schermata che sbaglia le ragioni si smette
  // di crederle.
  const archived = !on && scritta && session.archived === true;
  const expired = !on && scritta && !archived && Boolean(session.mcpBypassAt);
  return {
    on,
    expired,
    archived,
    name: 'ChatGPT',
    tone: on ? 'reach' : 'normal',
    sentence: on
      ? 'ChatGPT può parlare con questa conversazione, leggerne le risposte e farle eseguire comandi.'
      : archived
        ? 'La conversazione è archiviata: l\'esposizione resta scritta ma non è attiva. Torna raggiungibile quando la riprendi dall\'archivio.'
        : expired
          ? 'Il consenso è scaduto: la conversazione non è più raggiungibile da fuori finché non lo ridai.'
          : 'Nessun client esterno può parlare con questa conversazione.',
  };
}

/**
 * Lo stato da mostrare **senza doverlo leggere**: è la combinazione dei due assi, ed è quello che
 * finisce nella riga dell'elenco e nella testata. `danger` è il caso che va visto per primo —
 * l'agente che non chiede *ed è* pilotabile da fuori — e non è la somma degli altri due: è una
 * cosa peggiore, e ha un nome suo.
 */
export function stateOf(session, project = null) {
  const auth = authorizationOf(session, project);
  const reach = reachOf(session);
  const combined = auth.mode === 'bypass' && reach.on;
  return {
    ...auth,
    reach,
    combined,
    tone: combined ? 'combined' : auth.tone,
    // La parola che si vede nella riga. Corta, in monospaziato, e **non** una spiegazione: la
    // spiegazione sta dove si decide.
    mark: combined ? 'bypass + esposto' : auth.mode === 'normal' ? '' : auth.short,
  };
}

/** Il modo, in una riga, per il registro delle operazioni e per i test. */
export function describeState(session, project = null) {
  const state = stateOf(session, project);
  return `${state.name}${state.inherited ? ' (dal progetto)' : ''}${state.reach.on ? ' · esposto a ChatGPT' : ''}`;
}
