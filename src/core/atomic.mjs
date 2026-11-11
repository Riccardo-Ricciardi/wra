import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Scrittura atomica di un file di stato: prima il temporaneo, poi il rinomino. Serve perché un
 * file di stato troncato a metà non è un file di stato — è la perdita di tutto quello che
 * conteneva. Un `.tmp` non deve sopravvivere a un errore, e chi legge non deve mai vedere il
 * file a metà.
 *
 * La copia `.bak` si fa **solo** dal file attuale verificato sano: se il primario è già rotto,
 * copiarlo sopra il backup distruggerebbe l'ultima versione buona.
 *
 * E se il primario è rotto **non si solleva**: si scrive comunque, e il file rotto si mette da
 * parte (`.corrupt-<quando>`). Sollevare, come faceva prima, aveva una conseguenza sproporzionata:
 * un byte sbagliato rendeva impossibile **ogni** salvataggio successivo — le conversazioni nuove
 * restavano in memoria senza esistere su disco, e al riavvio non c'erano più. Il file di stato è
 * la cosa che non si deve perdere: qui la si scrive, e la versione rotta resta come prova.
 *
 * @param {string} file
 * @param {string} text
 * @param {{verify?: ((parsed: unknown) => void) | null}} [options]  `verify` solleva se il file attuale è rotto
 * @returns {{ quarantined: string|null }}  dove è finito il file rotto, se ce n'era uno
 */
export function writeFileAtomic(file, text, { verify = null } = {}) {
  let quarantined = null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Il nome porta un pezzo casuale, non solo il pid: un temporaneo lasciato indietro da un
  // processo morto a metà (`wx` non sovrascrive) bloccherebbe per sempre i salvataggi di quel
  // file, appena il sistema riassegna quel pid a qualcun altro.
  const temp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(temp, text, { flag: 'wx' });
    // Il file appena scritto deve essere **rileggibile** da chi lo ha scritto. Non è una
    // formalità: se la cartella ha un'ereditarietà rotta e il processo gira con un token
    // diverso dal solito (sandbox), il file nasce con un permesso che non lascia entrare
    // nemmeno chi lo ha creato. Senza questo controllo ci si mette al posto del registro un
    // file che nessuno potrà più leggere — ed è esattamente quello che è successo il 31/10.
    try {
      fs.accessSync(temp, fs.constants.R_OK);
    } catch (error) {
      throw new Error(`lo stato scritto in ${temp} non è leggibile da questo processo (${error.code}): non lo si mette al posto di ${file}`, { cause: error });
    }
    if (fs.existsSync(file)) {
      let healthy = true;
      if (verify) {
        try {
          verify(JSON.parse(fs.readFileSync(file, 'utf8')));
        } catch {
          healthy = false;
        }
      }
      if (healthy) {
        fs.copyFileSync(file, `${file}.bak`);
      } else {
        quarantined = `${file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(file, quarantined);
        } catch (error) {
          // Non si è potuto mettere da parte **e** non si può leggere: non si scrive sopra.
          // Sovrascrivere è l'unica cosa che renderebbe irrecuperabile un registro che forse
          // si poteva ancora leggere (permessi da sistemare, un admin, un'altra sessione):
          // meglio rifiutare il salvataggio e dirlo.
          throw new Error(`il registro a ${file} è illeggibile e non si può spostare (${error.code}): non lo si sovrascrive`, { cause: error });
        }
      }
    }
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { quarantined };
}
