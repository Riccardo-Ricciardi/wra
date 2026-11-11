import fs from 'node:fs';
import path from 'node:path';

// Le conversazioni che esistono già su disco — quelle aperte dal vecchio rig, o dal `claude` a
// mano. Sono le stesse di prima: Claude Code scrive sempre in `~/.claude/projects/<cartella>/`,
// e il file si chiama come l'id della conversazione. Il vecchio rig non ha un formato suo da
// convertire: ha solo un registro più povero.
//
// Qui si **legge e basta**. Nessuna funzione di questo file scrive, sposta o cancella un
// transcript: la migrazione consiste nel registrarli nel registro nuovo, non nel toccarli.

/** Il percorso del progetto di una conversazione: il `cwd` vero, non lo slug (che è lossy). */
function projectOf(transcriptPath) {
  let handle;
  try {
    handle = fs.openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    // Basta l'inizio del file: la prima riga utile ha già `cwd` e `sessionId`.
    const buffer = Buffer.alloc(64 * 1024);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, read).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.cwd) return { cwd: entry.cwd, sessionId: entry.sessionId ?? null, version: entry.version ?? null };
      } catch {
        // riga tagliata dal limite di lettura: si prova la prossima
      }
    }
  } catch {
    return null;
  } finally {
    fs.closeSync(handle);
  }
  return null;
}

/**
 * Un titolo per una conversazione, se il transcript ne ha uno. Claude Code ne scrive uno da sé
 * (`ai-title`): usarlo è meglio che inventare un nome, e se non c'è si ripiega sul primo
 * messaggio dell'utente — che è comunque roba scritta da una persona, non da noi.
 */
function titleOf(transcriptPath) {
  let text = '';
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - 512 * 1024); // il titolo sta di solito in testa, ma non sempre
    const handle = fs.openSync(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
  let firstPrompt = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'ai-title' && entry.aiTitle) return { title: String(entry.aiTitle).slice(0, 60), from: 'title' };
    if (!firstPrompt && entry.type === 'user' && !entry.isSidechain) {
      const content = entry.message?.content;
      const value = typeof content === 'string'
        ? content
        : (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : '');
      if (value && value.trim() && !value.trim().startsWith('<')) firstPrompt = value.trim().replace(/\s+/g, ' ');
    }
  }
  return firstPrompt ? { title: firstPrompt.slice(0, 60), from: 'prompt' } : null;
}

/**
 * Tutte le conversazioni presenti su disco.
 *
 * @param {{projectsRoot?: string, limit?: number}} [options]
 * @returns {Array<{sessionId, transcript, projectPath, sizeBytes, modifiedAt, title, titleFrom}>}
 */
export function scanHistory({ projectsRoot, limit = 500 } = {}) {
  const root = projectsRoot;
  const found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }

  for (const dir of dirs) {
    const full = path.join(root, dir);
    let names = [];
    try {
      names = fs.readdirSync(full).filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const transcript = path.join(full, name);
      let stat;
      try {
        stat = fs.statSync(transcript);
      } catch {
        continue;
      }
      if (stat.size < 200) continue; // file appena creato: non è ancora una conversazione
      const meta = projectOf(transcript);
      if (!meta?.cwd) continue;
      const named = titleOf(transcript);
      found.push({
        sessionId: name.replace(/\.jsonl$/, ''),
        transcript,
        projectPath: meta.cwd,
        version: meta.version,
        sizeBytes: stat.size,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        title: named?.title ?? null,
        titleFrom: named?.from ?? null,
      });
    }
  }

  found.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  return found.slice(0, limit);
}

/**
 * Una conversazione si può riprendere con `--resume`?
 *
 * Il criterio è volutamente stretto: il file deve esistere, avere almeno una riga leggibile con
 * il **suo** id, e quel percorso deve stare sotto una radice consentita — perché riprenderla
 * vuol dire far partire un processo dentro quella cartella.
 */
export function resumable(entry, { exists = fs.existsSync, resolve = null } = {}) {
  if (!entry?.sessionId || !entry?.transcript) return { ok: false, reason: 'incomplete entry' };
  if (!exists(entry.transcript)) return { ok: false, reason: 'transcript missing' };
  let text = '';
  try {
    const handle = fs.openSync(entry.transcript, 'r');
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    return { ok: false, reason: `transcript unreadable: ${error.message}` };
  }
  const hasId = text.split('\n').some((line) => {
    if (!line.includes(entry.sessionId)) return false;
    try {
      return JSON.parse(line).sessionId === entry.sessionId;
    } catch {
      return false;
    }
  });
  if (!hasId) return { ok: false, reason: 'the transcript does not contain its id: it cannot be resumed with --resume' };
  if (resolve) {
    const checked = resolve(entry.projectPath);
    if (!checked.ok) return { ok: false, reason: checked.reason };
  }
  return { ok: true };
}
