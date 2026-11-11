// Markdown quanto basta per una chat: paragrafi, titoli, elenchi, citazioni, tabelle, codice (a
// blocco e in linea), grassetto, corsivo, link e righe orizzontali. Niente HTML dentro: quello che
// l'agente scrive è testo, e resta testo.
//
// Il parser è puro — entra una stringa, escono blocchi — così si può provare in Node senza un
// browser. Chi disegna costruisce nodi del DOM uno per uno: nessun `innerHTML`, quindi nessun
// modo per un transcript di iniettare markup.

const FENCE = /^\s*(```|~~~)\s*([A-Za-z0-9+#._-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
// La riga sotto l'intestazione di una tabella: `|---|:--:|`. Le pipe esterne non servono.
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Le celle di una riga di tabella, con le pipe esterne tolte e gli spazi ai bordi via. */
const tableCells = (line) => String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());

/** I link si accettano solo se portano da qualche parte di sensato: niente `javascript:`. */
function safeHref(raw) {
  const value = String(raw ?? '').trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (value.startsWith('/') || value.startsWith('#')) return value;
  return null;
}

/**
 * Un pezzo di riga: testo, codice, grassetto, corsivo, link. Si scandisce una volta sola e si
 * tiene tutto piatto (niente grassetto dentro corsivo): in una chat non serve, e la ricorsione
 * è il posto dove questi parser si rompono.
 */
export function inlineSpans(text) {
  const spans = [];
  const source = String(text ?? '');
  let plain = '';
  let i = 0;

  const flush = () => {
    if (plain) spans.push({ type: 'text', text: plain });
    plain = '';
  };

  while (i < source.length) {
    const rest = source.slice(i);

    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      spans.push({ type: 'code', text: code[1] });
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2]);
      flush();
      if (href) spans.push({ type: 'link', text: link[1] || href, href });
      else spans.push({ type: 'text', text: link[0] });
      i += link[0].length;
      continue;
    }

    const bold = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (bold) {
      flush();
      spans.push({ type: 'strong', text: bold[2] });
      i += bold[0].length;
      continue;
    }

    const em = /^(\*|_)(?=\S)([^*_]*?\S)\1/.exec(rest);
    if (em) {
      flush();
      spans.push({ type: 'em', text: em[2] });
      i += em[0].length;
      continue;
    }

    plain += source[i];
    i += 1;
  }

  flush();
  return spans;
}

/**
 * Da markdown a blocchi. Volutamente tollerante: un markdown storto deve comunque produrre
 * qualcosa di leggibile, non un errore.
 */
export function parseMarkdown(input) {
  const lines = String(input ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', spans: inlineSpans(paragraph.join('\n')) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ type: 'rule' });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1].length, spans: inlineSpans(heading[2]) });
      continue;
    }

    // Una tabella: una riga con dentro delle pipe, e sotto la riga `|---|`. Senza la riga di
    // separazione non è una tabella — è una riga di testo con delle pipe, e resta testo. Gli
    // agenti le scrivono spessissimo per confrontare due cose, e senza questo erano una parete di
    // `|` da leggere a occhio, con le colonne disallineate.
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushParagraph();
      const head = tableCells(line).map(inlineSpans);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(tableCells(lines[i]).map(inlineSpans));
        i += 1;
      }
      i -= 1;
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      i -= 1;
      blocks.push({ type: 'quote', spans: inlineSpans(body.join('\n')) });
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      flushParagraph();
      const ordered = NUMBERED.test(line);
      const items = [];
      while (i < lines.length) {
        const match = ordered ? NUMBERED.exec(lines[i]) : BULLET.exec(lines[i]);
        if (!match) break;
        items.push(inlineSpans(ordered ? match[2] : match[1]));
        i += 1;
      }
      i -= 1;
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}
