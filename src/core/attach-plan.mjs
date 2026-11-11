// Decide cosa fare quando si aggancia: agganciare la sessione viva, riprenderne una,
// o aprirne una nuova. È la logica di `cc`, quindi va tenuta fuori dal codice che
// parla col terminale — così si può provare senza un PTY.
import path from 'node:path';

export const RESUME_QUIET_MS = 60_000;

const short = (id) => String(id).slice(0, 8);
const when = (session) => Date.parse(session.lastActivityAt ?? session.createdAt ?? '') || 0;

/**
 * The conversation `wra -c` resumes: the one chosen by hand if it belongs to this folder,
 * otherwise the most recently active one from this folder.
 *
 * It used to take the last element of the registry list, which is creation order — so resuming
 * "the latest" could reopen an old conversation if a newer one had been created later in another
 * folder or imported. Activity is the meaning of "latest".
 */
export function latestForProject(sessions, projectDir, selectedId = null) {
  const resolved = path.resolve(projectDir);
  const here = (sessions ?? []).filter((session) => path.resolve(session.projectPath) === resolved);
  const chosen = selectedId ? here.find((session) => session.sessionId === selectedId) : null;
  if (chosen) return chosen;
  return [...here].sort((a, b) => when(b) - when(a))[0] ?? null;
}

// I tasti che staccano. Ctrl+Q è quello documentato; Ctrl+] c'è perché su Windows un terminale
// può mangiarsi una combinazione e non l'altra, e restare agganciati senza una via d'uscita è
// peggio che avere due tasti. Non Ctrl+C: quello deve arrivare a Claude, che lo usa per
// interrompere.
//
// Il terzo modo non è un tasto: `rc detach`, che fa lasciare la presa dal server. Serve a chi
// usa la macchina da un altro dispositivo, o a chi ha un terminale che non collabora.
export const DETACH_KEYS = [0x11, 0x1d];
export const DETACH = DETACH_KEYS[0];

/** Posizione del primo tasto di stacco nei byte premuti, o -1. */
export function detachAt(buffer) {
  let found = -1;
  for (const key of DETACH_KEYS) {
    const at = buffer.indexOf(key);
    if (at !== -1 && (found === -1 || at < found)) found = at;
  }
  return found;
}

/**
 * @param {object} input
 * @param {string} input.projectDir
 * @param {{uuid: string}|null} input.live   sessione viva nel PTY di quel progetto
 * @param {{id: string, mtimeMs: number}|null} input.newest  conversazione più recente della cartella
 * @param {number} [input.now]
 * @param {'new'|'continue'|'auto'} [input.mode]
 */
export function planAttach({ projectDir, live, newest, now = Date.now(), mode = 'auto' }) {
  const where = projectDir || '(nessun progetto)';

  if (mode === 'new') {
    // forceRestart sempre: se un PTY per quel progetto esiste lo chiude e ne apre uno
    // nuovo; se non esiste non fa niente. Fidarsi del rilevamento non basta — un
    // `claude` appena partito non ha `--resume` nella riga di comando e risulterebbe
    // invisibile, quindi "nuova" finirebbe per agganciarsi alla vecchia.
    return {
      resumeId: null,
      forceRestart: true,
      action: 'new',
      text: live
        ? `chiudo la sessione viva (${short(live.uuid)}) e apro una nuova in ${where}`
        : `apro una sessione nuova in ${where}`,
    };
  }

  if (mode === 'continue') {
    if (!newest) {
      return { resumeId: null, forceRestart: Boolean(live), action: 'new', text: `niente da riprendere in ${where}: apro una sessione nuova` };
    }
    if (live && live.uuid === newest.id) {
      return { resumeId: null, forceRestart: false, action: 'attach', text: `aggancio la sessione viva (${short(newest.id)}) di ${where}` };
    }
    return {
      resumeId: newest.id,
      forceRestart: Boolean(live),
      action: 'resume',
      text: `riprendo la conversazione ${short(newest.id)}${live ? ` al posto di quella viva (${short(live.uuid)})` : ''} in ${where}`,
    };
  }

  if (live) {
    return { resumeId: null, forceRestart: false, action: 'attach', text: `aggancio la sessione viva (${short(live.uuid)}) di ${where}` };
  }
  if (!newest) {
    return { resumeId: null, forceRestart: false, action: 'none', text: `nessuna sessione in ${where}` };
  }
  if (now - newest.mtimeMs < RESUME_QUIET_MS) {
    // Scritta poco fa. NON si riprende con --resume: sarebbe un secondo processo con lo
    // stesso contesto (il fork che ha già fatto danni il 27/10). E non si può nemmeno
    // dire "apro una nuova": cloudcli chiave il PTY sul solo projectPath, quindi un
    // init senza forceRestart riusa il terminale già aperto là — cioè si aggancia.
    // Il testo dice quello che succede davvero; il rilevamento (`live`) resta nullo
    // perché un `claude` appena partito non ha `--resume` nella riga di comando.
    return {
      resumeId: null,
      forceRestart: false,
      action: 'new',
      text: live
        ? `attaching to the live session (${short(live.uuid)}) of ${where}`
        : `${where} already has a conversation written ${Math.round((now - newest.mtimeMs) / 1000)}s ago: ` +
          'if there is a terminal open there I attach to it (one conversation, one process), ' +
          'otherwise a new one is opened.',
    };
  }
  return { resumeId: newest.id, forceRestart: false, action: 'resume', text: `resuming the conversation ${short(newest.id)} of ${where}` };
}
