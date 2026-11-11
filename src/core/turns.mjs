import fs from 'node:fs';
import { promptMatches } from './prompt.mjs';
import {
  ReplyAssembler,
  TailingReader,
  discoverCandidates,
  isToolResult,
  isTurnOpen,
  readRecentEntries,
  userPromptText,
} from './transcript.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** due percorsi indicano la stessa cartella? (separatori, maiuscole, barra finale) */
export function samePath(a, b) {
  const clean = (value) => String(value ?? '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  if (!a || !b) return false;
  return clean(a) === clean(b);
}

export function preflight({ projectsRoot, projectDir, recentMs }) {
  const { files, newest, ambiguous } = discoverCandidates({ root: projectsRoot, projectDir, recentMs });

  if (!newest) {
    return {
      ok: false,
      error: `no Claude Code session found${projectDir ? ` for ${projectDir}` : ''} — open one in the WRA terminal`,
    };
  }

  // Con il progetto fissato il match sul testo del prompt sceglie il file da sé:
  // più sessioni nella stessa cartella non sono un'ambiguità da rifiutare.
  const pool = projectDir ? files : [newest];
  if (!projectDir && ambiguous.length) {
    return {
      ok: false,
      error: `piu di una sessione toccata negli ultimi minuti, non tiro a indovinare: ${ambiguous.map((file) => file.path).join(', ')} (imposta CR_PROJECT_DIR)`,
    };
  }

  const idle = pool.filter((file) => !isTurnOpen(readRecentEntries(file.path)));
  if (idle.length === 0) {
    return { ok: false, error: 'Claude Code is busy with another turn' };
  }

  return { ok: true, files: idle, newest };
}

/**
 * Segue un turno: manda il messaggio, riconosce il prompt nel transcript, e raccoglie la
 * risposta.
 *
 * `resume` riprende un turno **già avviato**: il messaggio è già stato mandato e il prompt già
 * riconosciuto, quindi non si rimanda niente — si ricomincia a leggere dal punto esatto in cui
 * si era smesso. È quello che permette a un turno lungo di sopravvivere alla fine della
 * finestra di ascolto: senza, l'unica alternativa sarebbe rimandare il messaggio, cioè un
 * secondo prompt nella stessa conversazione.
 *
 * @param {object} [input.resume] `{ transcriptPath, promptId, offset, partial, tools, ended }`
 */
export async function runTurn({
  pty,
  message,
  projectsRoot,
  projectDir,
  transcriptPath,
  recentMs,
  promptMatchMs,
  pollMs,
  settleMs,
  maxWaitMs,
  onProgress,
  resume = null,
}) {
  const startedAt = Date.now();

  // A quale sessione siamo agganciati: serve solo a spiegare l'errore se il turno non parte.
  const attachedTo = pty?.projectPath ?? null;

  // Se il processo dell'agente muore, non c'è più niente da aspettare: si esce subito con un
  // errore che dice *cosa* è successo, invece di restare appesi fino alla scadenza lunga.
  const dead = () => pty.alive?.() === false;

  let readers;
  let watched;
  let assembler = null;
  let promptId = null;
  let pinned = null;

  if (resume) {
    // Il transcript è più corto di dove eravamo? Allora non è più lo stesso file (troncato,
    // sostituito, o un id riusato): riprendere da un punto che non esiste più rileggerebbe da
    // capo e **duplicherebbe** quello che l'assembler ha già. Meglio dirlo che restituire una
    // risposta con il testo due volte.
    const size = (() => {
      try {
        return fs.statSync(resume.transcriptPath).size;
      } catch {
        return 0;
      }
    })();
    if (size < (resume.offset ?? 0)) {
      return {
        status: 'error',
        error: 'the transcript changed during the turn (it is shorter than the resume point): not resuming',
        transcript: resume.transcriptPath,
        partial: resume.partial ?? '',
        elapsedMs: Date.now() - startedAt,
      };
    }

    pinned = new TailingReader(resume.transcriptPath);
    pinned.sync();
    pinned.seek(resume.offset ?? 0);
    readers = [pinned];
    watched = new Set([resume.transcriptPath]);
    promptId = resume.promptId ?? null;
    assembler = new ReplyAssembler({ settleMs }).seed({
      parts: resume.partial ? [resume.partial] : [],
      tools: resume.tools ?? [],
      endedAt: resume.ended === true ? startedAt : null,
    });
  } else {
    // Due modi di sapere dove sta la conversazione:
    //  - `transcriptPath`: il percorso è noto perché la sessione ha un id nostro. È il modo
    //    giusto quando si conosce la sessione (registro, `--session-id`): niente ricerche, niente
    //    "il file più recente", che con due chat nella stessa cartella è una scommessa.
    //  - `projectDir`: si cerca nella cartella (compatibilità con chi non ha l'id).
    if (transcriptPath) {
      const reader = new TailingReader(transcriptPath);
      reader.sync();
      readers = [reader];
      watched = new Set([transcriptPath]);
    } else {
      const pre = preflight({ projectsRoot, projectDir, recentMs });
      if (!pre.ok) return { status: 'error', error: pre.error, elapsedMs: Date.now() - startedAt };
      readers = pre.files.map((file) => {
        const reader = new TailingReader(file.path);
        reader.sync();
        return reader;
      });
      watched = new Set(readers.map((reader) => reader.path));
    }

    await pty.send(message);

    const matchDeadline = Date.now() + promptMatchMs;

    while (Date.now() < matchDeadline) {
      if (dead()) return { status: 'error', error: 'the agent process ended: no reply is coming', elapsedMs: Date.now() - startedAt };
      // Con l'id noto non c'è niente da cercare; senza, la sessione viva può scrivere il suo
      // transcript dopo di noi, quindi si ri-guarda la cartella a ogni giro.
      if (!transcriptPath) {
        for (const file of discoverCandidates({ root: projectsRoot, projectDir, recentMs }).files) {
          if (watched.has(file.path)) continue;
          watched.add(file.path);
          readers.push(new TailingReader(file.path));
        }
      }

      for (const reader of readers) {
        if (pinned && reader !== pinned) continue;
        for (const entry of reader.readNew()) {
          const text = userPromptText(entry);
          if (!pinned && entry.type === 'user' && !isToolResult(entry) && text && promptMatches(text, message)) {
            pinned = reader;
            promptId = entry.promptId ?? null;
            assembler = new ReplyAssembler({ settleMs });
            continue;
          }
          assembler?.add(entry);
        }
      }
      if (assembler) break;
      await sleep(pollMs);
    }

    if (!assembler) {
      return {
        status: 'error',
        error:
          `il prompt non ha raggiunto una sessione in ${projectDir || 'nessun progetto (auto-discovery)'}` +
          (attachedTo
            ? `: sono agganciato al terminale di ${attachedTo}`
            : '') +
          (samePath(attachedTo, projectDir)
            ? ', quindi il testo e\' arrivato ma non ha prodotto un turno riconoscibile'
            : ' — the WRA terminal is running in another project, or it is not open') +
          ': cambia con "rc target", o aggancia un client alla cartella giusta. Altre cause: il terminale è ancora in avvio, è al prompt di una shell, in vim, o fermo su un dialog di permesso.',
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  const replyDeadline = maxWaitMs ? Date.now() + maxWaitMs : null;
  let timedOut = false;

  while (!assembler.done) {
    // Si legge **prima** di guardare se il processo è vivo: un agente che ha finito e poi è
    // uscito lascia la risposta nel transcript, e dichiararlo morto senza leggerla perderebbe
    // l'unica cosa che conta. E se la fine del turno è già stata vista (`end_turn`), la morte
    // del processo non è una notizia: manca solo il tempo di quiete.
    for (const entry of pinned.readNew()) assembler.add(entry);
    if (assembler.done) break;
    if (!assembler.ended && dead()) {
      return { status: 'error', promptId, transcript: pinned.path, partial: assembler.text, offset: pinned.resumeOffset, elapsedMs: Date.now() - startedAt, error: 'the agent process ended during the turn' };
    }
    onProgress?.(assembler.text);
    if (replyDeadline && Date.now() >= replyDeadline) {
      timedOut = true;
      break;
    }
    await sleep(pollMs);
  }

  const elapsedMs = Date.now() - startedAt;
  const transcript = pinned.path;
  if (timedOut) {
    // Non è un fallimento: è la fine della **finestra di ascolto**. Il turno è ancora in corso,
    // e chi ci ha chiamato decide se riprendere a guardare (`offset`) o restituire il parziale.
    return {
      status: 'in_progress',
      promptId,
      transcript,
      partial: assembler.text,
      offset: pinned.resumeOffset,
      tools: assembler.toolNames,
      ended: assembler.ended,
      elapsedMs,
    };
  }
  return { status: 'done', promptId, transcript, reply: assembler.text, tools: assembler.toolNames, offset: pinned.resumeOffset, elapsedMs };
}
