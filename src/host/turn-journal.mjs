import fs from 'node:fs';
import path from 'node:path';

// The turn journal: the latest `requestId`s executed and how they ended.
//
// It serves one purpose only, but a precious one: idempotency must survive a restart. In memory a
// `Map` is enough, but an MCP client that retries after a server restart finds nothing and starts
// the same request again — that is, a second prompt in the same conversation, which is exactly the
// damage to avoid. Here the reply stays written, and the same `requestId` receives the same reply
// instead of being executed again.
//
// It is not a complete turn registry: only the latest `size` are kept, and it is written only when
// a turn with a `requestId` ends (or is rejected).

// How much of a partial is kept for an expired turn. The transcript remains the complete memory:
// here only what is needed to avoid leaving the client empty-handed.
const PARTIAL_CHARS = 4_000;

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function createTurnJournal({ file, size = 200, now = () => Date.now() }) {
  let entries = []; // the most recent at the end

  const load = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(parsed?.turns) ? parsed.turns : [];
      entries = list.filter((entry) => entry && typeof entry.requestId === 'string' && entry.requestId);
      // The cap applies here too: it used to be applied only when *adding*, so a file longer than
      // the cap (because the cap was lowered, or because it grew elsewhere) stayed whole in memory
      // and was rewritten as it was.
      if (entries.length > size) entries = entries.slice(-size);
    } catch {
      // An unreadable journal must not prevent the server from starting: at most the memory of
      // already executed requests is lost, and the client retries once too often.
      entries = [];
    }
    return entries;
  };

  const save = () => {
    writeAtomic(file, `${JSON.stringify({ version: 1, savedAt: new Date(now()).toISOString(), turns: entries }, null, 2)}\n`);
  };

  load();

  return {
    /**
     * Remembers how a turn with a `requestId` ended. It is written only for identified turns:
     * without a `requestId` there is nothing to make idempotent.
     */
    remember(turn) {
      if (!turn?.requestId) return null;
      const entry = {
        requestId: turn.requestId,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        state: turn.state,
        reply: turn.reply ?? null,
        // The partial is kept only for turns that did **not** end well: it is the only thing left of
        // an expired turn, and without it whoever retries the same `requestId` would receive
        // nothing instead of what the agent had already written. With a cap, because the journal is
        // not a transcript archive.
        partial: turn.state === 'done' ? null : (turn.partial ? String(turn.partial).slice(0, PARTIAL_CHARS) : null),
        error: turn.error ?? null,
        finishedAt: new Date(turn.finishedAt ?? now()).toISOString(),
      };
      entries = [...entries.filter((known) => known.requestId !== entry.requestId), entry];
      while (entries.length > size) entries.shift();
      try {
        save();
      } catch {
        // the journal is an extra: if the disk does not cooperate, we carry on anyway
      }
      return entry;
    },

    get: (requestId) => entries.find((entry) => entry.requestId === requestId) ?? null,
    /** The latest remembered turn of a session: the reply for whoever lost the `requestId`. */
    latestFor: (sessionId) => [...entries].reverse().find((entry) => entry.sessionId === sessionId) ?? null,
    list: () => [...entries],
    size: () => entries.length,
    file,
  };
}