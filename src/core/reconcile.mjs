// I due elenchi che non coincidono.
//
// Le conversazioni stanno in due posti, e non sono lo stesso posto: il **registro**
// (`~/.cc-remote/sessions.json`) dice quali cc-remote conosce, i **transcript**
// (`~/.claude/projects/<cartella>/<id>.jsonl`) sono quelli che Claude Code ha davvero scritto. Il
// registro si può perdere o non aver mai visto una conversazione; i transcript non si cancellano
// mai da soli. Quindi i due elenchi divergono, e l'audit di M9 l'ha misurato sul registro vero:
// 13 voci del registro senza più il transcript (si aprono vuote) e 183 transcript autentici che
// l'interfaccia non mostra.
//
// Questo modulo **non scrive niente**: prende i due elenchi e dice cosa c'è di là e cosa di qua,
// con il motivo. Chi decide è una persona, davanti a un'anteprima, con una conferma esplicita —
// perché importare è scrivere nel registro, e una scrittura senza anteprima è una scommessa.
//
// Puro: niente `fs`, niente rete. Il filesystem entra come funzione (`exists`), i verdetti di
// riprendibilità arrivano già calcolati. Si prova in Node (`test/reconcile.test.mjs`).

/**
 * @typedef {{sessionId: string, projectPath?: string, name?: string|null, transcript?: string|null,
 *   imported?: boolean, lastActivityAt?: string, riprendibile?: {ok: boolean, reason?: string}}} Voce
 */

/**
 * @param {object} input
 * @param {Voce[]} input.sessions   il registro
 * @param {Voce[]} input.found      i transcript trovati su disco (`scanHistory`)
 * @param {(file: string|null) => boolean} [input.exists]  se un file c'è (iniettabile: si prova senza toccare il disco)
 * @returns {{counts: object, importabili: Voce[], nonRiprendibili: Voce[], senzaTranscript: Voce[],
 *   maiAperte: Voce[], duplicati: object[]}}
 */
export function reconcile({ sessions = [], found = [], exists = () => true } = {}) {
  // ── la deduplicazione ───────────────────────────────────────────────────────────────────────
  // Lo stesso id in due cartelle è lo stesso transcript visto due volte: succede quando una
  // cartella viene spostata e Claude Code ne ricostruisce lo slug. Si tiene quello **più recente**
  // e si dice che l'altro c'era, invece di importare due volte la stessa conversazione.
  const perId = new Map();
  const duplicati = [];
  for (const entry of found) {
    const prima = perId.get(entry.sessionId);
    if (!prima) {
      perId.set(entry.sessionId, entry);
      continue;
    }
    const [tieni, scarta] = Date.parse(entry.modifiedAt ?? 0) > Date.parse(prima.modifiedAt ?? 0)
      ? [entry, prima]
      : [prima, entry];
    perId.set(entry.sessionId, tieni);
    duplicati.push({ sessionId: scarta.sessionId, transcript: scarta.transcript, invece: tieni.transcript });
  }

  const inRegistro = new Set(sessions.map((session) => session.sessionId));

  // ── il verso che importa: transcript che il registro non conosce ────────────────────────────
  const importabili = [];
  const nonRiprendibili = [];
  for (const entry of perId.values()) {
    if (inRegistro.has(entry.sessionId)) continue;
    // Non si inventa una continuità che non c'è: una conversazione che `--resume` non può
    // riprendere si **mostra** con il motivo, e non si importa.
    if (entry.riprendibile?.ok === false) nonRiprendibili.push(entry);
    else importabili.push(entry);
  }
  importabili.sort((a, b) => Date.parse(b.modifiedAt ?? 0) - Date.parse(a.modifiedAt ?? 0));
  nonRiprendibili.sort((a, b) => Date.parse(b.modifiedAt ?? 0) - Date.parse(a.modifiedAt ?? 0));

  // ── l'altro verso: voci del registro senza più il loro file ─────────────────────────────────
  const trovati = new Set(perId.keys());
  const senzaTranscript = [];
  const maiAperte = [];
  for (const session of sessions) {
    if (trovati.has(session.sessionId)) continue;
    // Il percorso del transcript il registro lo **calcola** sempre, quindi «il file non c'è» da
    // solo non vuol dire niente: una conversazione creata e mai aperta non ha ancora niente da
    // scrivere, ed è normale. Quello che rende la mancanza un difetto è che la conversazione sia
    // stata **usata** — importata da un transcript che c'era, o aperta almeno una volta.
    const usata = Boolean(session.imported) || Boolean(session.lastActivityAt);
    if (session.transcript && exists(session.transcript)) continue;
    (usata ? senzaTranscript : maiAperte).push(session);
  }

  return {
    counts: {
      registro: sessions.length,
      trovati: perId.size,
      importabili: importabili.length,
      nonRiprendibili: nonRiprendibili.length,
      senzaTranscript: senzaTranscript.length,
      maiAperte: maiAperte.length,
      duplicati: duplicati.length,
    },
    importabili,
    nonRiprendibili,
    senzaTranscript,
    maiAperte,
    duplicati,
  };
}

/**
 * Quante conversazioni ci stanno, prima di provarci.
 *
 * Il registro ha un tetto (`CR_MAX_SESSIONS`) e l'importazione lo urta: sul registro vero di
 * questa macchina ci sono 84 conversazioni con il tetto a 256, e i transcript che l'interfaccia
 * non mostra sono 212 — cioè 296, che non ci stanno. Senza questo conto l'importazione parte,
 * riempie il registro fino al tetto e **poi** si ferma: chi la guarda vede 172 importate e 40
 * fallite con un motivo che parla di «troppe sessioni salvate», e non ha modo di sapere che il
 * numero che conta l'ha deciso una variabile d'ambiente.
 *
 * Meglio dirlo **prima**, con i tre numeri in chiaro, e non scrivere niente: un'importazione a
 * metà non perde dati (la copia c'è), ma lascia un registro che non è né quello di prima né quello
 * che si voleva.
 *
 * @param {{inRegistro?: number, daImportare?: number, max?: number}} input
 * @returns {{posti: number, mancano: number, ok: boolean}}
 */
export function capienza({ inRegistro = 0, daImportare = 0, max = 0 }) {
  const posti = Math.max(0, max - inRegistro);
  return { posti, mancano: Math.max(0, daImportare - posti), ok: daImportare <= posti };
}

/**
 * Quali id si importano davvero, dati quelli chiesti da chi ha premuto.
 *
 * Il client può chiedere quello che vuole: la lista buona è quella che risulta **adesso** dalla
 * scansione, e l'intersezione si fa qui. Un id che non è nell'elenco delle importabili — perché
 * non esiste, perché è già nel registro, o perché non è riprendibile — non entra.
 *
 * @param {{importabili: Voce[]}} plan
 * @param {string[]} wanted
 * @returns {{scelti: Voce[], rifiutati: string[]}}
 */
export function choose(plan, wanted = []) {
  const buoni = new Map((plan?.importabili ?? []).map((entry) => [entry.sessionId, entry]));
  const scelti = [];
  const rifiutati = [];
  for (const id of [...new Set(wanted.map(String))]) {
    const entry = buoni.get(id);
    if (entry) scelti.push(entry);
    else rifiutati.push(id);
  }
  return { scelti, rifiutati };
}
