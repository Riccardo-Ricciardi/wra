export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
// Ctrl+U: svuota la riga del composer. Senza, un residuo (una tua digitazione, un
// invio precedente andato a meta') si attacca davanti al messaggio iniettato.
export const CLEAR_LINE = '\x15';

// Il testo che arriva da fuori (il client MCP, uno script) non deve poter chiudere il
// bracketed paste da solo: con un `\x1b[201~` dentro il messaggio, tutto quello che segue
// arriverebbe al TUI come tasti — Esc, Ctrl+C, e perfino la risposta a un dialog di permesso.
// Il tool promette "manda testo e leggi la risposta": se il testo può diventare tasti, la
// promessa è falsa. Via anche gli altri caratteri di controllo, tranne a capo e tab.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function sanitizePrompt(text) {
  return String(text ?? '').replace(CONTROL_CHARS, '');
}

export function framePrompt(text) {
  return `${CLEAR_LINE}${PASTE_START}${sanitizePrompt(text)}${PASTE_END}\r`;
}

// La TUI avvolge un paste multi-riga in <pasted_content id="…">…</pasted_content> prima
// di scriverlo nel transcript: il nostro testo c'e' tutto, ma non e' piu' identico a
// quello che abbiamo mandato. Un messaggio di una riga non viene avvolto: per questo il
// confronto funzionava e un testo multi-riga risultava "non riconoscibile" pur essendo
// arrivato (e l'agente aveva gia' risposto).
const PASTE_WRAPPER = /<\/?pasted_content[^>]*>/g;

export function normalizePrompt(value) {
  return String(value ?? '').replace(PASTE_WRAPPER, ' ').replace(/\s+/g, ' ').trim();
}

export function promptMatches(entryText, sent) {
  const found = normalizePrompt(entryText);
  const wanted = normalizePrompt(sent);
  if (!found || !wanted) return false;
  if (found === wanted) return true;
  // Residuo nel composer: il nostro testo resta in coda. Il filtro temporale
  // (si guardano solo le righe scritte dopo l'iniezione) tiene fuori i falsi positivi.
  if (found.endsWith(wanted)) return true;
  return found.length === wanted.length && found.startsWith(wanted.slice(0, 80));
}
