// La conversazione: quello che l'agente ha detto e fatto, e il campo dove si scrive.
//
// Era la parte più lunga di `app.js` — i messaggi, il markdown, le schede degli strumenti coi
// risultati e i diff, le richieste di permesso, il campo di scrittura. Qui è una **fabbrica**,
// come `views/permissions.mjs`.
//
// La regola di sempre, e vale la pena ripeterla perché è il motivo per cui questo file non
// disegna niente che non ci sia: **si disegna solo quello che c'è**. Un messaggio viene dal
// transcript, una richiesta di permesso dall'hook, lo stato di una chat dal registro. Se un dato
// non c'è, quel pezzo non compare — niente segnaposto, niente «sta pensando» inventato.
//
// Quello che questa vista non sa: come si sceglie una conversazione, cosa c'è nell'elenco, come si
// autorizza. Lo riceve già deciso (`currentSession`) o lo chiede al trasporto (`send`).
import { parseMarkdown } from '/core/markdown.mjs';
import { h, fill } from '/ui/dom.mjs';
import { icon } from '/ui/icons.mjs';
import { elapsed } from '/core/format.mjs';

/**
 * @param {object} input
 * @param {object} input.state
 * @param {object} input.el
 * @param {Function} input.api
 * @param {Function} input.toast
 * @param {Function} input.currentSession
 * @param {Function} input.send           manda un messaggio sul websocket
 * @param {Function} input.socketOpen     il websocket è aperto?
 */
export function createChat({ state, el, api, toast, currentSession, send, socketOpen }) {
  const nearBottom = () => el.viewport.scrollHeight - el.viewport.scrollTop - el.viewport.clientHeight < 140;

  // ── markdown ───────────────────────────────────────────────────────────────
  function spans(list) {
    return (list ?? []).map((span) => {
      if (span.type === 'text') return document.createTextNode(span.text);
      if (span.type === 'code') return h('code', { text: span.text });
      if (span.type === 'strong') return h('strong', { text: span.text });
      if (span.type === 'em') return h('em', { text: span.text });
      if (span.type === 'link') return h('a', { href: span.href, target: '_blank', rel: 'noopener noreferrer', text: span.text });
      return null;
    });
  }

  function codeBlock(text, lang) {
    const copy = h('button.icon-btn', { type: 'button', 'aria-label': 'copia il codice', title: 'copia', style: { height: '1.5rem', width: '1.5rem' } }, icon('copy', { size: 14 }));
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        fill(copy, icon('check', { size: 14 }));
        setTimeout(() => fill(copy, icon('copy', { size: 14 })), 1_500);
      } catch {
        toast('Non riesco a copiare da qui', 'danger');
      }
    });
    return h('.code', {},
      h('header', {},
        h('span', { text: lang || 'codice' }),
        h('span.grow', { style: { flex: '1 1 auto' } }),
        copy,
      ),
      h('pre', {}, h('code', { text })),
    );
  }

  function markdownBlock(text) {
    const box = h('div');
    for (const block of parseMarkdown(text)) {
      if (block.type === 'paragraph') box.append(h('p', {}, spans(block.spans)));
      else if (block.type === 'heading') box.append(h(`h${Math.min(block.level + 1, 4)}`, {}, spans(block.spans)));
      else if (block.type === 'quote') box.append(h('blockquote', {}, spans(block.spans)));
      else if (block.type === 'rule') box.append(h('hr'));
      else if (block.type === 'list') box.append(h(block.ordered ? 'ol' : 'ul', {}, ...block.items.map((item) => h('li', {}, spans(item)))));
      else if (block.type === 'code') box.append(codeBlock(block.text, block.lang));
      // Una tabella va in un contenitore che può scorrere da solo: su un telefono una tabella a
      // quattro colonne non entra, e senza questo si porterebbe dietro tutta la conversazione.
      else if (block.type === 'table') {
        box.append(h('.table-wrap', {}, h('table', {},
          h('thead', {}, h('tr', {}, ...block.head.map((cell) => h('th', {}, spans(cell))))),
          h('tbody', {}, ...block.rows.map((row) => h('tr', {}, ...row.map((cell) => h('td', {}, spans(cell)))))),
        )));
      }
    }
    return box;
  }

  // ── strumenti ──────────────────────────────────────────────────────────────
  function toolSummary(part) {
    const input = part.input;
    if (typeof input === 'string') return input.replace(/\s+/g, ' ').slice(0, 200);
    for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
      const value = input?.[key];
      if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').slice(0, 200);
    }
    try {
      return JSON.stringify(input).slice(0, 200);
    } catch {
      return '';
    }
  }

  const TOOL_ICON = {
    Bash: 'terminal', Read: 'file', Write: 'file', Edit: 'pencil', Glob: 'search', Grep: 'search',
    WebFetch: 'arrowUpRight', WebSearch: 'search', Task: 'chat', TodoWrite: 'check',
  };

  function toolStatus(part) {
    if (part.result?.isError) return { text: 'errore', kind: 'error' };
    const source = part.decision?.source ?? '';
    const decision = part.decision?.decision ?? '';
    if (decision && decision !== 'accept') return { text: 'rifiutato', kind: 'error' };
    if (/^user/.test(source)) return { text: 'approvato da te', kind: 'person' };
    if (source === 'mode') return { text: 'consentito dalla modalità', kind: 'auto' };
    if (source === 'config') return { text: 'consentito dalle regole', kind: 'auto' };
    if (part.result) return { text: 'fatto', kind: 'ok' };
    return { text: 'in corso', kind: 'wait' };
  }

  /** Un diff unificato, così com'è nel transcript: righe `-`, `+` e di contesto. */
  function diffBlock(result) {
    const box = h('.diff');
    for (const hunk of result.patch) {
      const where = hunk.oldStart !== null && hunk.newStart !== null ? `@@ -${hunk.oldStart} +${hunk.newStart} @@` : '@@';
      box.append(h('.hunk', { text: where }));
      for (const line of hunk.lines) {
        const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
        box.append(h('.line', { class: kind },
          h('span.sign', { text: kind === 'add' ? '+' : kind === 'del' ? '-' : ' ' }),
          h('span', { text: line.slice(1) || ' ' }),
        ));
      }
    }
    if (result.added || result.removed) {
      box.append(h('.stat', {}, h('b', { text: `+${result.added}` }), ' ', h('i', { text: `−${result.removed}` })));
    }
    return box;
  }

  function toolNode(part) {
    const status = toolStatus(part);
    const filePath = part.result?.filePath ?? (typeof part.input === 'object' ? part.input?.file_path : null);
    const box = h('details.tool', {
      dataset: { status: status.kind === 'error' ? 'error' : part.result ? 'ok' : 'wait' },
    });

    box.append(h('summary', {},
      icon('chevronRight', { size: 14, className: 'chev' }),
      icon(TOOL_ICON[part.name] ?? 'terminal', { size: 15, className: 'tool-icon' }),
      h('span.label', { text: part.name }),
      h('span.what', { text: part.result?.kind === 'edit' || part.result?.kind === 'create' ? (filePath ?? '') : toolSummary(part), title: toolSummary(part) }),
      h('span.chip', { class: status.kind === 'error' ? 'danger' : status.kind === 'person' ? 'warn' : '', text: status.text }),
    ));

    const detail = h('.detail');
    detail.append(h('span.cap', { text: 'richiesta' }));
    detail.append(h('pre', { text: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}, null, 2) }));
    if (part.inputTruncated) detail.append(h('span.note', { text: 'richiesta tagliata: era troppo lunga da mostrare qui' }));

    if (part.result?.patch?.length) {
      detail.append(h('span.cap', { text: part.result.kind === 'create' ? 'file creato' : `modifica · ${filePath ?? ''}` }));
      detail.append(diffBlock(part.result));
    } else if (part.result) {
      detail.append(h('span.cap', { text: part.result.filePath ? `risultato · ${part.result.filePath}` : 'risultato' }));
      detail.append(h('pre', { class: part.result.isError ? 'error' : '', text: part.result.text || '(nessun output)' }));
      if (part.result.truncated) detail.append(h('span.note', { text: 'risultato tagliato: il resto è nel transcript' }));
    }

    box.append(detail);
    if (part.result?.isError) box.open = true; // le cose andate storte si aprono da sole
    return box;
  }

  /**
   * Più strumenti di fila, in una riga sola.
   *
   * Il sommario dice **cosa è successo**, non solo quanti sono: «2 file modificati · 3 letture» è
   * la risposta alla domanda che si fa guardando un turno lungo. Il gruppo si apre da sé se dentro
   * c'è un errore: quello non è un dettaglio da andare a cercare.
   */
  function toolGroup(parts) {
    const errori = parts.filter((part) => part.result?.isError).length;
    const inCorso = parts.filter((part) => !part.result).length;
    const conta = (re) => parts.filter((part) => re.test(part.name)).length;
    const modificati = parts.filter((part) => part.result?.patch?.length).length;
    const comandi = conta(/^Bash$/);
    const letture = conta(/^(Read|Glob|Grep|WebFetch|WebSearch)$/);

    const chips = [];
    if (modificati) chips.push(`${modificati} file modificat${modificati === 1 ? 'o' : 'i'}`);
    if (comandi) chips.push(`${comandi} comand${comandi === 1 ? 'o' : 'i'}`);
    if (letture) chips.push(`${letture} lettur${letture === 1 ? 'a' : 'e'}`);

    const box = h('details.tools', { dataset: { state: errori ? 'error' : inCorso ? 'wait' : 'ok' } });
    box.append(h('summary', {},
      icon('chevronRight', { size: 14, className: 'chev' }),
      h('span.label', { text: `${parts.length} strumenti` }),
      ...chips.map((text) => h('span.chip', { text })),
      errori ? h('span.chip.danger', { text: `${errori} con errore` }) : null,
      inCorso ? h('span.chip.accent', { text: 'in corso' }) : null,
    ));
    const detail = h('.detail');
    for (const part of parts) detail.append(toolNode(part));
    box.append(detail);
    if (errori) box.open = true;
    return box;
  }

  function thinkingNode(part) {
    const seconds = Math.round((part.durationMs ?? 0) / 1000);
    return h('details.thinking', {},
      h('summary', {}, icon('chevronRight', { size: 14, className: 'chev' }), h('span', { text: seconds > 0 ? `ragionamento · ${seconds}s` : 'ragionamento' })),
      h('.md', {}, markdownBlock(part.text)),
    );
  }

  // ── i messaggi ─────────────────────────────────────────────────────────────
  function messageNode(message) {
    const isUser = message.role === 'user';
    const body = h('.body');

    const byline = h('.byline', {},
      h('span', { text: isUser ? 'tu' : 'agente' }),
      message.at ? h('time', { text: new Date(message.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }), title: new Date(message.at).toLocaleString('it-IT') }) : null,
    );

    if (!isUser) {
      const text = (message.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text).join('\n\n');
      if (text) {
        const copy = h('button.icon-btn', { type: 'button', 'aria-label': 'copia la risposta', title: 'copia', style: { height: '1.4rem', width: '1.4rem' } }, icon('copy', { size: 14 }));
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(text);
            fill(copy, icon('check', { size: 14 }));
            setTimeout(() => fill(copy, icon('copy', { size: 14 })), 1_500);
          } catch {
            toast('Non riesco a copiare da qui', 'danger');
          }
        });
        byline.append(copy);
      }
    }

    body.append(byline);
    // Gli strumenti **consecutivi** diventano un blocco solo. Un turno che legge tre file e ne
    // modifica due sono cinque schede bordate una sotto l'altra, tutte uguali: la risposta
    // dell'agente — che è la cosa che si sta leggendo — finiva schiacciata in mezzo. Raggruppati,
    // restano una riga sola («5 strumenti · 2 file modificati · 3 letture») che si apre quando
    // serve. Da soli restano schede, perché una scheda sola non fa una parete.
    const pezzi = [];
    let sospesi = [];
    const chiudiGruppo = () => {
      if (!sospesi.length) return;
      pezzi.push(sospesi.length === 1 ? toolNode(sospesi[0]) : toolGroup(sospesi));
      sospesi = [];
    };
    for (const part of message.parts ?? []) {
      if (part.kind === 'tool') { sospesi.push(part); continue; }
      chiudiGruppo();
      if (part.kind === 'text') pezzi.push(h('.text.md', {}, markdownBlock(part.text)));
      else if (part.kind === 'thinking') pezzi.push(thinkingNode(part));
    }
    chiudiGruppo();
    for (const pezzo of pezzi) body.append(pezzo);

    if (body.childNodes.length <= 1) return h('li'); // solo la byline: non c'è niente da mostrare
    return h(`li.turn.${isUser ? 'user' : 'assistant'}`, { dataset: { id: message.id } },
      h('span.avatar', { 'aria-hidden': 'true' }, icon(isUser ? 'arrowUpRight' : 'chat', { size: 15 })),
      body,
    );
  }

  function emptyState() {
    return h('li.feed-empty', {},
      h('span.mark', {}, icon('chat', { size: 26 })),
      h('h2', { text: 'Niente da leggere, per ora' }),
      h('p', { text: 'Scrivi qui sotto: il messaggio arriva all\'agente di questa conversazione.' }),
    );
  }

  let workingClock = null;

  /**
   * Cosa sta facendo l'agente, mentre lo fa. Non si inventa niente: lo strumento in corso è
   * l'ultima chiamata del transcript che non ha ancora un risultato, e il tempo è quello
   * dall'inizio dell'ultimo turno dell'agente — che è un dato, non una stima.
   */
  function workingRow() {
    const list = state.messages.get(state.open) ?? [];
    const last = [...list].reverse().find((message) => message.role === 'assistant');
    const running = (last?.parts ?? []).filter((part) => part.kind === 'tool' && !part.result).pop();
    const since = Date.parse(last?.at ?? '') || 0;
    const clock = h('span.time', { text: since ? elapsed(since) : '' });
    workingClock = clock;

    return h('li.turn.assistant', {},
      h('span.avatar', {}, icon('chat', { size: 15 })),
      h('.body', {},
        h('.working', {},
          h('span.dots', {}, h('span'), h('span'), h('span')),
          h('span', { text: running ? `sta usando ${running.name}` : 'sta lavorando…' }),
          running ? h('span.what', { text: toolSummary(running), title: toolSummary(running) }) : null,
          clock,
        ),
      ),
    );
  }

  /** Il tempo passa anche quando non arriva niente dal server: la riga si aggiorna da sola. */
  setInterval(() => {
    if (!workingClock?.isConnected) {
      workingClock = null;
      return;
    }
    const last = [...(state.messages.get(state.open) ?? [])].reverse().find((message) => message.role === 'assistant');
    const since = Date.parse(last?.at ?? '') || 0;
    if (since) workingClock.textContent = elapsed(since);
  }, 1_000);

  const messageNodes = new Map();
  let renderedFor = null;

  function renderChat({ scroll = false } = {}) {
    const stick = scroll || nearBottom();
    const list = state.messages.get(state.open) ?? [];

    if (renderedFor !== state.open) {
      messageNodes.clear();
      renderedFor = state.open;
    }

    const ordered = [];
    let changed = false;
    for (const message of list) {
      const known = messageNodes.get(message.id);
      if (known && known.message === message) {
        ordered.push(known.node);
        continue;
      }
      const node = messageNode(message);
      if (known) known.node.replaceWith(node);
      messageNodes.set(message.id, { node, message });
      ordered.push(node);
      changed = true;
    }
    for (const id of [...messageNodes.keys()]) {
      if (!list.some((message) => message.id === id)) {
        messageNodes.delete(id);
        changed = true;
      }
    }

    const session = currentSession();
    let working = null;
    if (session?.busy && list.length) working = workingRow();
    else workingClock = null;
    const count = String(ordered.length + (working ? 1 : 0));
    if (changed || el.messages.dataset.count !== count) {
      el.messages.replaceChildren(
        ...(ordered.length ? ordered : [emptyState()]),
        ...(working ? [working] : []),
      );
      el.messages.dataset.count = count;
    }

    if (stick) el.viewport.scrollTop = el.viewport.scrollHeight;
  }

  // ── approvazioni ───────────────────────────────────────────────────────────
  // Le operazioni che vale la pena guardare due volte. Non è un verdetto — è una lettura più
  // attenta: il comando è scritto per intero lì sotto, e la decisione resta di chi legge.
  const RISKY = [
    { re: /\brm\s+-[a-z]*[rf]/i, why: 'cancella file' },
    { re: /\bgit\s+push\b[^\n]*(--force|\s-f\b)/i, why: 'riscrive la storia del repository remoto' },
    { re: /\bgit\s+reset\s+--hard\b/i, why: 'butta via le modifiche non salvate' },
    { re: /\bnpm\s+publish\b|\byarn\s+publish\b/i, why: 'pubblica un pacchetto' },
    { re: /\b(sudo|runas|Start-Process\s+[^\n]*-Verb\s+RunAs)\b/i, why: 'esegue come amministratore' },
    { re: /\b(shutdown|reboot|Restart-Computer|Stop-Computer)\b/i, why: 'spegne o riavvia la macchina' },
    { re: /\b(curl|wget|Invoke-WebRequest|iwr)\b[^\n|]*\|\s*(ba)?sh\b/i, why: 'esegue codice scaricato dalla rete' },
    { re: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b/i, why: 'cancella dati' },
    { re: /\b(taskkill[^\n]*\/F|Stop-Process[^\n]*-Force)\b/i, why: 'chiude processi a forza' },
  ];

  function riskOf(approval) {
    const input = approval.input ?? {};
    const text = [input.command, input.file_path, input.path, JSON.stringify(input)].filter((v) => typeof v === 'string').join(' \n ');
    return RISKY.find((rule) => rule.re.test(text)) ?? null;
  }

  function upsertApproval(approval) {
    if (!approval?.id) return;
    state.approvals = [...state.approvals.filter((other) => other.id !== approval.id), approval];
    renderApprovals();
  }

  function renderApprovals() {
    const shown = state.approvals;
    const fingerprint = shown.map((approval) => approval.id).join(',');
    if (fingerprint === el.approvals.dataset.fingerprint) return;
    el.approvals.dataset.fingerprint = fingerprint;

    fill(el.approvals, ...shown.map((approval) => {
      const session = state.sessions.find((entry) => entry.sessionId === approval.sessionId);
      const risk = riskOf(approval);
      const actions = h('.actions');

      const decide = async (behavior) => {
        for (const button of actions.querySelectorAll('button')) button.disabled = true;
        try {
          // Col websocket aperto si risponde di lì (la persona vede subito l'esito); se è caduto si
          // passa dalla rotta HTTP, che fa la stessa cosa. È l'unico posto in cui la scelta conta.
          if (socketOpen()) send({ t: 'approve', id: approval.id, behavior });
          else await api(`/local/approvals/${approval.id}`, { method: 'POST', body: { behavior } });
          state.approvals = state.approvals.filter((other) => other.id !== approval.id);
          el.approvals.dataset.fingerprint = '';
          renderApprovals();
          toast(behavior === 'allow' ? 'permesso concesso' : 'richiesta rifiutata');
        } catch (error) {
          toast(error.message, 'danger');
          delete el.approvals.dataset.fingerprint;
          renderApprovals();
        }
      };

      actions.append(
        h('button.btn.btn-primary', { type: 'button', text: 'consenti una volta', onclick: () => decide('allow') }),
        h('button.btn', { type: 'button', text: 'rifiuta', onclick: () => decide('deny') }),
      );

      return h('section.ask', { class: risk ? 'sensitive' : '', role: 'alertdialog', 'aria-label': `${approval.toolName} chiede il permesso` },
        h('header', {},
          icon(risk ? 'alert' : 'shield', { size: 16 }),
          h('strong', {}, h('span.tool-name', { text: approval.toolName }), ' chiede il permesso'),
          h('span.where', { text: session?.name ?? approval.sessionId.slice(0, 8) }),
        ),
        h('.body', {},
          risk ? h('.warning', {}, h('span', { text: `Sembra un'operazione che ${risk.why}. Leggi il comando prima di consentire.` })) : null,
          h('pre.cmd', { text: typeof approval.input === 'string' ? approval.input : toolSummary({ input: approval.input }) }),
          actions,
        ),
      );
    }));
  }

  // ── scrittura ──────────────────────────────────────────────────────────────
  function autosize() {
    el.composerText.style.height = 'auto';
    const max = Math.max(120, window.innerHeight * 0.4);
    el.composerText.style.height = `${Math.min(el.composerText.scrollHeight, max)}px`;
    el.send.disabled = !el.composerText.value.trim() || !state.open;
  }

  el.composerText.addEventListener('input', autosize);
  el.composerText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      el.composer.requestSubmit();
    }
  });

  el.composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = el.composerText.value.trim();
    if (!text || !state.open) return;
    el.composerText.value = '';
    autosize();
    el.viewport.scrollTop = el.viewport.scrollHeight;
    try {
      await api('/local/talk', { method: 'POST', body: { sessionId: state.open, message: text } });
    } catch (error) {
      toast(error.message, 'danger');
      el.composerText.value = text; // non è partito: si rimette dov'era
      autosize();
    }
  });

  /**
   * La tastiera del telefono non cambia `innerHeight`: cambia `visualViewport`. Senza questo, il
   * campo di scrittura finisce sotto la tastiera e si scrive alla cieca — è il difetto che fa
   * sembrare "non professionale" una chat su Android.
   */
  function watchKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      el.composerWrap.style.paddingBottom = hidden > 60 ? `${hidden + 8}px` : '';
      if (hidden > 60) el.viewport.scrollTop = el.viewport.scrollHeight;
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
  }

  return { renderChat, renderApprovals, upsertApproval, autosize, watchKeyboard };
}
