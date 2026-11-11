import fs from 'node:fs';

// Cerca **dentro** le conversazioni, non solo nei loro nomi. È la ricerca che serve quando ci si
// ricorda di cosa si è parlato ma non come si chiamava la chat.
//
// Il vincolo è che non deve rallentare niente, e un transcript è un file di decine di MB in cui
// la maggior parte del peso sono blob di richieste API che non interessano a nessuno. Quindi:
//
//  1. si guarda **la coda** di ogni transcript, non l'inizio: è dove sta la conversazione recente,
//     ed è quello che si cerca;
//  2. si legge solo il testo dei messaggi — le altre specie di riga si scartano senza costruire
//     niente;
//  3. c'è un tetto di tempo e uno di byte letti: quando finiscono, ci si ferma e **lo si dice**
//     (`truncated`), invece di far aspettare mezzo minuto per un risultato in più.
//
// Un tetto dichiarato è meglio di una ricerca che sembra completa e non lo è.

const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_BUDGET_MS = 2_000;
const DEFAULT_MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 40;
const MIN_NEEDLE = 3;
// Ogni tanto si restituisce il turno all'event loop. Senza, una ricerca da due secondi
// bloccherebbe il server per due secondi: niente output del terminale, niente risposte alle
// altre schede, e una richiesta di permesso che aspetta. Il lavoro è lo stesso; cambia che
// mentre lo si fa il server resta vivo.
const YIELD_EVERY_MS = 40;

/** Il testo di un messaggio, se quella riga è un messaggio. Nient'altro viene costruito. */
function messageText(entry) {
  if (entry?.type !== 'user' && entry?.type !== 'assistant') return '';
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += `${block.text} `;
  }
  return text;
}

/** Un pezzo di testo intorno alla parola trovata: si legge il contesto, non solo il match. */
function snippetAround(text, at, needle) {
  const from = Math.max(0, at - 60);
  const to = Math.min(text.length, at + needle.length + 90);
  const clean = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${clean}${to < text.length ? '…' : ''}`;
}

/**
 * @param {object} input
 * @param {Array<{sessionId: string, name?: string, transcript: string, lastActivityAt?: string}>} input.sessions
 *   già ordinate da chi chiama: con il tetto di tempo, l'ordine *è* la priorità
 * @param {string} input.query
 * @param {number} [input.budgetMs]
 * @param {number} [input.maxResults]
 * @param {() => number} [input.now]
 * @returns {Promise<{hits: Array<object>, scanned: number, total: number, truncated: boolean, bytes: number}>}
 */
export async function searchConversations({
  sessions = [],
  query,
  budgetMs = DEFAULT_BUDGET_MS,
  maxResults = DEFAULT_MAX_RESULTS,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  tailBytes = DEFAULT_TAIL_BYTES,
  now = Date.now,
} = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  const empty = { hits: [], scanned: 0, total: sessions.length, truncated: false, bytes: 0 };
  if (needle.length < MIN_NEEDLE) return empty;

  const deadline = now() + budgetMs;
  const hits = [];
  let scanned = 0;
  let bytes = 0;
  let truncated = false;
  let lastYield = now();

  for (const session of sessions) {
    if (hits.length >= maxResults || bytes >= maxTotalBytes || now() > deadline) {
      truncated = true;
      break;
    }
    if (now() - lastYield > YIELD_EVERY_MS) {
      lastYield = now();
      await new Promise((resolve) => setImmediate(resolve));
    }
    let text = '';
    try {
      const stat = fs.statSync(session.transcript);
      const start = Math.max(0, stat.size - tailBytes);
      const handle = fs.openSync(session.transcript, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        const read = fs.readSync(handle, buffer, 0, buffer.length, start);
        text = buffer.subarray(0, read).toString('utf8');
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      continue; // transcript assente o illeggibile: si passa alla prossima, non è un errore
    }
    bytes += text.length;
    scanned += 1;

    // La finestra può tagliare a metà la prima riga: il `JSON.parse` la scarta da sé, e una riga
    // tagliata non deve poter inventare un risultato.
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || !line.toLowerCase().includes(needle)) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const body = messageText(entry);
      const at = body.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      hits.push({
        sessionId: session.sessionId,
        name: session.name ?? null,
        role: entry.type === 'user' ? 'tu' : 'agente',
        at: entry.timestamp ?? null,
        snippet: snippetAround(body, at, needle),
      });
      break; // una conversazione si propone una volta sola: si sta cercando *quale* chat era
    }
  }

  return { hits, scanned, total: sessions.length, truncated, bytes };
}
