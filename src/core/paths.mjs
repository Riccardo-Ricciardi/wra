// Regole sui percorsi che valgono in più di un posto: le usano il registro delle sessioni (per
// decidere dove può girare un agente) e il criterio di auto-approvazione (per decidere se un
// percorso è davvero dentro il progetto).
//
// Modulo puro: nessun processo, nessuna rete — si prova senza montare niente.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Nessun pezzo del percorso — **sotto** la radice consentita — può essere un collegamento
 * (symlink, junction, mount point).
 *
 * Serve perché il controllo sui percorsi è testuale: `\\server\share` si riconosce dalla
 * scrittura, ma una **junction** creata dentro una cartella consentita punta dove vuole e si
 * presenta come una cartella normale. `statSync` la segue, quindi il danno non sarebbe solo
 * «apre una cartella fuori dalle radici»: con una junction verso `\\attaccante\share` la
 * macchina si autentica al server di un altro **durante la validazione** (furto/relay di
 * credenziali NTLM), prima ancora che si apra qualcosa.
 *
 * `lstatSync` il collegamento lo vede e non lo attraversa: è per questo che si cammina pezzo per
 * pezzo invece di risolvere il percorso. La radice consentita invece **non** si controlla: è
 * configurazione di chi usa la macchina, non qualcosa che qualcun altro può piantare.
 *
 * Camminare invece di risolvere ha un secondo effetto voluto: un percorso che **non esiste
 * ancora** (un file che si sta per creare) si controlla lo stesso, e si controlla tutto il pezzo
 * che esiste già.
 *
 * @param {string} resolved percorso assoluto da controllare
 * @param {string} fromNorm la radice (normalizzata) da cui in poi si controlla
 * @returns {string|null} il primo pezzo che è un collegamento, o `null`
 */
export function linkInPath(resolved, fromNorm) {
  const { root } = path.parse(resolved);
  const norm = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  let current = root;
  for (const piece of resolved.slice(root.length).split(path.sep)) {
    if (!piece) continue;
    current = path.join(current, piece);
    if (norm(current).length <= fromNorm.length) continue; // la radice (o sopra): è config
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return null; // non esiste: lo dirà lo `statSync` dopo, con il suo messaggio
    }
    if (stat.isSymbolicLink()) return current;
  }
  return null;
}

/** Normalizzazione per confrontare due percorsi: `C:\Progetti\X\` e `c:/progetti/x` sono uguali. */
export const normalizePath = (value) => path.resolve(String(value ?? '')).replace(/[\\/]+$/, '').toLowerCase();

/**
 * `target` sta dentro `base` (o è `base` stesso)?
 *
 * Confronto per **pezzi** e non per prefisso di stringa: `/progetti/alfa2` inizia per
 * `/progetti/alfa` ma non è dentro `/progetti/alfa` — e con `startsWith` da soli quella differenza
 * si perde, che è il modo classico in cui un confine sui percorsi smette di esistere.
 */
export function isInside(target, base) {
  const inner = normalizePath(target);
  const outer = normalizePath(base);
  if (!inner || !outer) return false;
  return inner === outer || inner.startsWith(outer + path.sep);
}
