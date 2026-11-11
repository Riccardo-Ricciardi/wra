import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

/**
 * Il log si scrive **subito**, non in coda.
 *
 * Con un flusso in scrittura le righe restano in memoria finché il sistema non le manda al file:
 * se il processo esce male — che è esattamente il caso in cui il log serve — quelle righe non
 * arrivano mai, e `rc start` legge un log vuoto e non sa dire perché il server non è partito.
 * Sono poche righe per esecuzione: la scrittura diretta non costa niente e non si perde niente.
 */
function write(level, message, extra) {
  const line = `${new Date().toISOString()} [${level}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`;
  process.stdout.write(`${line}\n`);
  try {
    fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
    fs.appendFileSync(config.logFile, `${line}\n`);
  } catch {
    // il log è un extra: se non si può scrivere, il programma va avanti lo stesso
  }
}

export const info = (message, extra) => write('INFO', message, extra);
export const warn = (message, extra) => write('WARN', message, extra);
export const error = (message, extra) => write('ERROR', message, extra);
