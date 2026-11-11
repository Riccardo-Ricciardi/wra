import fs from 'node:fs';
import path from 'node:path';

export function slugForProjectDir(dir) {
  return String(dir).replace(/[^A-Za-z0-9]/g, '-');
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function discoverCandidates({ root, projectDir, recentMs, now = Date.now() }) {
  const base = projectDir ? path.join(root, slugForProjectDir(projectDir)) : root;
  if (!isDirectory(base)) return { files: [], newest: null, ambiguous: [] };

  const dirs = projectDir
    ? [base]
    : fs.readdirSync(base).map((name) => path.join(base, name)).filter(isDirectory);

  const files = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recent = files.filter((file) => now - file.mtimeMs <= recentMs);
  return { files, newest: files[0] ?? null, ambiguous: recent.length > 1 ? recent : [] };
}

export function readRecentEntries(filePath, maxBytes = 65536) {
  const stat = fs.statSync(filePath);
  let start = Math.max(0, stat.size - maxBytes);
  const partialHead = start > 0;
  if (partialHead) start -= 1;
  const length = stat.size - start;
  if (length <= 0) return [];

  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  let text = buffer.toString('utf8');
  if (partialHead) {
    const newline = text.indexOf('\n');
    text = newline === -1 ? '' : text.slice(newline + 1);
  }

  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // riga parziale o corrotta: il transcript non è un'API, si salta
    }
  }
  return entries;
}

export function userPromptText(entry) {
  if (entry?.type !== 'user') return null;
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((block) => block?.type === 'text').map((block) => block.text ?? '');
  return texts.length ? texts.join('\n') : null;
}

export function isToolResult(entry) {
  if (entry?.type !== 'user') return false;
  const content = entry.message?.content;
  return Array.isArray(content) && content.some((block) => block?.type === 'tool_result');
}

export function assistantText(entry) {
  if (entry?.type !== 'assistant') return null;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n\n');
  return text || null;
}

export function assistantToolNames(entry) {
  if (entry?.type !== 'assistant') return [];
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'tool_use' && block.name).map((block) => block.name);
}

export function stopReason(entry) {
  return entry?.type === 'assistant' ? entry.message?.stop_reason ?? null : null;
}

export function isTurnOpen(entries) {
  let lastPrompt = -1;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i]?.type === 'user' && !isToolResult(entries[i]) && userPromptText(entries[i])) lastPrompt = i;
  }
  if (lastPrompt === -1) return false;
  for (let i = lastPrompt + 1; i < entries.length; i += 1) {
    if (stopReason(entries[i]) === 'end_turn') return false;
  }
  return true;
}

// ponytail: readSync + TextDecoder per file, non readFileSync — un carattere
// multi-byte a cavallo di due letture verrebbe altrimenti corrotto in silenzio.
export class TailingReader {
  #decoder = new TextDecoder('utf-8');
  #carry = '';
  #offset = 0;
  // Fino a quale byte del file arriva il testo che il decoder ha **emesso**: un offset assoluto,
  // quindi riparte da dove ci si è posizionati (`#offset`), non da zero. Non è la stessa cosa di
  // `#offset`, che conta i byte *letti*: il decoder ne tiene da parte fino a tre quando un
  // carattere multi-byte cade a cavallo di due letture, e la differenza è esattamente quel resto.
  #decodedBytes = 0;

  constructor(filePath) {
    this.path = filePath;
  }

  get offset() {
    return this.#offset;
  }

  /**
   * Da dove **riprendere** senza perdere niente.
   *
   * Non è `offset`: `offset` sta in fondo al file, e se l'ultima riga era arrivata a metà
   * (`#carry` la tiene da parte, non ancora interpretata) ripartire da lì salterebbe la prima
   * metà di quella riga. Qui si torna all'inizio della riga incompleta, che verrà riletta
   * intera quando il resto arriva. Su un transcript scritto a pezzi è la differenza fra una
   * risposta intera e una risposta mozzata.
   *
   * Il conto si fa sui byte **emessi dal decoder** (`#decodedBytes`) e non su `#offset`: se un
   * carattere multi-byte cade a cavallo di due letture, il decoder ne tiene da parte i primi
   * byte, e quei byte non sono in `#carry` — togliendoli da `#offset` si ripartirebbe *dentro* la
   * riga, e la riga andrebbe persa. (Trovato provando: `però`, tagliato dentro la `è`, dava
   * `resumeOffset = 1` invece di `0`.)
   */
  get resumeOffset() {
    return this.#decodedBytes - Buffer.byteLength(this.#carry, 'utf8');
  }

  sync() {
    // Il transcript di una sessione nuova non esiste ancora: il file nasce al primo messaggio.
    // Qui si parte da zero e si aspetta, invece di far esplodere il turno.
    try {
      this.#offset = fs.statSync(this.path).size;
    } catch {
      this.#offset = 0;
    }
    this.#carry = '';
    this.#decodedBytes = this.#offset;
    this.#decoder = new TextDecoder('utf-8');
    return this.#offset;
  }

  /**
   * Torna a un punto già letto, o a uno mai letto: serve a **riprendere** un turno lungo, cioè
   * a ricominciare a guardare esattamente da dove si era smesso. Senza, la ripresa rileggerebbe
   * da capo e la risposta si duplicherebbe.
   */
  seek(offset) {
    const target = Number(offset);
    this.#offset = Number.isFinite(target) && target >= 0 ? target : 0;
    this.#carry = '';
    this.#decodedBytes = this.#offset;
    this.#decoder = new TextDecoder('utf-8');
    return this.#offset;
  }

  readNew() {
    let stat;
    try {
      stat = fs.statSync(this.path);
    } catch {
      return [];
    }
    if (stat.size < this.#offset) {
      // il file è stato troncato o sostituito: si riparte dall'inizio
      this.#offset = 0;
      this.#carry = '';
      this.#decodedBytes = this.#offset;
      this.#decoder = new TextDecoder('utf-8');
    }
    if (stat.size === this.#offset) return [];

    const length = stat.size - this.#offset;
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(this.path, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, this.#offset);
    } finally {
      fs.closeSync(fd);
    }
    this.#offset = stat.size;

    // `stream: true` fa tenere al decoder i byte di un carattere multi-byte arrivato a metà:
    // si contano quelli **emessi**, non quelli letti, ed è quello che rende esatto `resumeOffset`.
    const decoded = this.#decoder.decode(buffer, { stream: true });
    this.#decodedBytes += Buffer.byteLength(decoded, 'utf8');

    const text = this.#carry + decoded;
    const lines = text.split('\n');
    this.#carry = lines.pop() ?? '';

    const entries = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // riga parziale o corrotta: si salta
      }
    }
    return entries;
  }
}

export class ReplyAssembler {
  #endedAt = null;

  constructor({ settleMs = 1200 } = {}) {
    this.settleMs = settleMs;
    this.parts = [];
    this.tools = new Set();
    this.closed = false;
  }

  add(entry, now = Date.now()) {
    if (!entry) return;
    if (entry.type === 'user' && !isToolResult(entry) && userPromptText(entry)) {
      this.closed = true;
      return;
    }
    if (entry.type !== 'assistant') return;

    const text = assistantText(entry);
    if (text) this.parts.push(text);
    for (const name of assistantToolNames(entry)) this.tools.add(name);

    if (stopReason(entry) === 'end_turn') this.#endedAt = now;
    else if (this.#endedAt !== null) this.#endedAt = now;
  }

  /**
   * Riprende da un assembler precedente: il testo già raccolto e i nomi degli strumenti.
   * `endedAt` dice se la fine del turno era già stata vista — senza, una ripresa dopo un
   * `end_turn` non saprebbe che non c'è più niente da aspettare e resterebbe appesa.
   */
  seed({ parts = [], tools = [], endedAt = null } = {}) {
    this.parts = [...parts];
    this.tools = new Set(tools);
    this.#endedAt = endedAt === null || endedAt === undefined ? null : Date.now();
    return this;
  }

  get text() {
    return this.parts.join('\n\n');
  }

  get toolNames() {
    return [...this.tools];
  }

  /** La fine del turno è stata vista: quello che manca è solo il tempo di quiete. */
  get ended() {
    return this.#endedAt !== null;
  }

  get done() {
    return this.closed || (this.#endedAt !== null && Date.now() - this.#endedAt >= this.settleMs);
  }
}
