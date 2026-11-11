// Il transcript di Claude Code è una sequenza di *eventi*, non di messaggi: una risposta con
// tre strumenti sono quattro righe, e i risultati arrivano dopo, in righe `user` che l'utente
// non ha mai scritto. Per una vista a chat serve la forma che si vede in claude.ai: un messaggio
// per turno, con dentro, nell'ordine, testo, ragionamento e schede degli strumenti.
//
// Qui si fa solo quello — unire — e solo con quello che c'è davvero nel transcript. Niente
// viene inventato: se un dato non c'è, il campo resta vuoto e la UI non lo disegna.

const MAX_RESULT_CHARS = 8_000;
const MAX_INPUT_CHARS = 4_000;

/** Il testo di un risultato di strumento: stringa, oppure blocchi (testo e immagini). */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text') parts.push(block.text ?? '');
    else if (block?.type === 'image') parts.push('[immagine]');
  }
  return parts.join('\n');
}

/**
 * La forma comoda che il transcript offre per alcuni strumenti: per Bash stdout/stderr,
 * per Write/Edit il file toccato e il pezzo cambiato. Si usa quella, quando c'è, perché è già
 * separata; altrimenti si ripiega sul testo del risultato.
 */
function structuredResult(entry) {
  const raw = entry?.toolUseResult;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.stdout === 'string' || typeof raw.stderr === 'string') {
    return { text: [raw.stdout, raw.stderr].filter(Boolean).join('\n').trim(), kind: 'command' };
  }
  if (raw.filePath && typeof raw.filePath === 'string') {
    // Le modifiche a un file arrivano già come diff unificato (`structuredPatch`: vecchie e nuove
    // righe numerate, con le righe `-`/`+`/contesto). Si passa così com'è: ricostruire il diff
    // dal prima/dopo sarebbe inventare una numerazione che il transcript non dà.
    const patch = Array.isArray(raw.structuredPatch)
      ? raw.structuredPatch
        .filter((hunk) => Array.isArray(hunk?.lines))
        .map((hunk) => ({
          oldStart: hunk.oldStart ?? null,
          newStart: hunk.newStart ?? null,
          lines: hunk.lines.map((line) => String(line)),
        }))
      : null;
    return {
      text: null,
      kind: patch?.length ? (raw.type === 'create' ? 'create' : 'edit') : 'file',
      filePath: raw.filePath,
      patch: patch?.length ? patch : null,
      added: patch ? patch.reduce((total, hunk) => total + hunk.lines.filter((l) => l.startsWith('+')).length, 0) : 0,
      removed: patch ? patch.reduce((total, hunk) => total + hunk.lines.filter((l) => l.startsWith('-')).length, 0) : 0,
    };
  }
  return null;
}

function clip(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}

/** Un blocco di testo o di ragionamento, tenuto com'è. */
const textPart = (kind, text, extra = {}) => ({ kind, text: String(text ?? ''), ...extra });

/**
 * Costruisce i messaggi da una sequenza di righe di transcript.
 *
 * `push` restituisce il messaggio *cambiato* — che può essere appena nato o uno di prima
 * aggiornato col risultato di uno strumento. La UI li sostituisce per id, quindi un
 * aggiornamento non è un messaggio nuovo.
 */
export class ConversationLog {
  #messages = [];
  #open = null; // il messaggio dell'assistente a cui si sta ancora aggiungendo
  #tools = new Map(); // id della chiamata -> la sua scheda

  constructor({ maxResultChars = MAX_RESULT_CHARS, maxInputChars = MAX_INPUT_CHARS } = {}) {
    this.maxResultChars = maxResultChars;
    this.maxInputChars = maxInputChars;
  }

  get messages() {
    return this.#messages;
  }

  static fromEntries(entries, options) {
    const log = new ConversationLog(options);
    for (const entry of entries) log.push(entry);
    return log;
  }

  #start(role, entry) {
    const message = {
      id: entry?.uuid ?? `m${this.#messages.length}`,
      role,
      at: entry?.timestamp ?? null,
      model: null,
      parts: [],
    };
    this.#messages.push(message);
    return message;
  }

  push(entry) {
    if (!entry || entry.isSidechain) return null;
    if (entry.type === 'assistant') return this.#assistant(entry);
    if (entry.type === 'user') return this.#user(entry);
    return null; // system, attachment, e la dozzina di righe interne: non sono conversazione
  }

  #assistant(entry) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return null;

    const wanted = content.filter((block) => block?.type === 'text' || block?.type === 'thinking' || block?.type === 'tool_use');
    if (!wanted.length) return null;

    // Due risposte di fila senza un prompt in mezzo sono lo stesso turno (è così che appare
    // quando in mezzo c'è uno strumento): si continua lo stesso messaggio.
    const message = this.#open ?? this.#start('assistant', entry);
    this.#open = message;
    if (entry.message?.model) message.model = entry.message.model;
    if (entry.timestamp) message.at = message.at ?? entry.timestamp;

    for (const block of wanted) {
      if (block.type === 'text') {
        if (block.text) message.parts.push(textPart('text', block.text));
        continue;
      }
      if (block.type === 'thinking') {
        if (block.thinking) {
          message.parts.push(textPart('thinking', block.thinking, {
            durationMs: Number.isFinite(entry.thinkingDurationMs) ? entry.thinkingDurationMs : null,
          }));
        }
        continue;
      }
      // Un `Write` di un file intero è un input enorme: quello che non passa si taglia, ma si
      // dice che è stato tagliato invece di far credere che il comando fosse più corto.
      const raw = JSON.stringify(block.input ?? {});
      const input = clip(raw, this.maxInputChars);
      const part = {
        kind: 'tool',
        id: block.id ?? null,
        name: block.name ?? 'strumento',
        input: input.truncated ? input.text : (block.input ?? {}),
        inputTruncated: input.truncated,
        result: null,
        decision: null,
      };
      message.parts.push(part);
      if (part.id) this.#tools.set(part.id, { part, message });
    }
    return message;
  }

  #user(entry) {
    const content = entry.message?.content;
    const results = Array.isArray(content) ? content.filter((block) => block?.type === 'tool_result') : [];

    if (results.length) {
      let touched = null;
      for (const block of results) {
        const known = this.#tools.get(block.tool_use_id);
        if (!known) continue; // il risultato di uno strumento di un turno che non abbiamo letto
        const { part, message } = known;
        const structured = structuredResult(entry);
        const text = clip(structured?.text ?? resultText(block.content), this.maxResultChars);
        part.result = {
          text: text.text,
          truncated: text.truncated,
          isError: Boolean(block.is_error),
          kind: structured?.kind ?? null,
          filePath: structured?.filePath ?? null,
          ...(structured?.patch ? { patch: structured.patch, added: structured.added, removed: structured.removed } : {}),
        };
        // Il transcript dice *come* è stato concesso il permesso: dalla configurazione, dalla
        // modalità, o perché una persona l'ha approvato adesso.
        if (entry.permissionDecision) {
          part.decision = {
            decision: entry.permissionDecision.decision ?? null,
            source: entry.permissionDecision.source ?? null,
          };
        }
        touched = message;
      }
      return touched;
    }

    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : '');
    if (!text) return null;
    this.#open = null;
    const message = this.#start('user', entry);
    message.parts.push(textPart('text', text));
    return message;
  }
}
