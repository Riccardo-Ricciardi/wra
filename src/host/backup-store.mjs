// Backups: create them, list them, verify them, and **restore without losing anything**. They used
// to live inside `rc backup`; now they are here because the panel uses them too, and because a
// restore is the most dangerous thing this application knows how to do: the logic that decides
// whether to proceed must live in one place, and must be testable.
//
// What is saved: the conversation registry, its automatic backup, the turn journal, the project
// metadata (name, star, section) and the outside access choice. What is **not** saved: the
// transcripts — they belong to Claude Code, live in `~/.claude/projects`, and no restore touches
// them — and the token, which is a secret and in a backup lying around is one more risk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const stateFiles = (config) => [
  { name: 'sessions.json', file: config.stateFile, what: 'the conversations' },
  { name: 'sessions.json.bak', file: `${config.stateFile}.bak`, what: 'the previous registry' },
  { name: 'turns.json', file: config.turnJournalFile, what: 'requests already executed' },
  { name: 'projects.json', file: config.projectsFile, what: 'project names, stars and sections' },
  { name: 'access.json', file: config.accessFile, what: 'the outside access choice' },
];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stamp = (now) => new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** The conversations of a backup, for comparison. `null` if the file cannot be read. */
function chatsOf(folder) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(folder, 'sessions.json'), 'utf8'));
    return Array.isArray(parsed?.sessions) ? parsed.sessions : null;
  } catch {
    return null;
  }
}

export function createBackupStore({ config, now = () => Date.now() }) {
  const folder = path.join(path.dirname(config.stateFile), 'backups');

  const readManifest = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(folder, name, 'MANIFEST.json'), 'utf8'));
    } catch {
      return null;
    }
  };

  /**
   * A backup. It can be made **even with the server running**: the registry is written with
   * temp+rename, so what is on disk is always a whole version — never a half-written file. (A
   * restore, on the other hand, is not done with the server running: see `restore`.)
   */
  function create({ quiet = true, into = path.join(folder, stamp(now)) } = {}) {
    fs.mkdirSync(into, { recursive: true });
    const entries = [];
    for (const { name, file } of stateFiles(config)) {
      if (!fs.existsSync(file)) continue;
      const target = path.join(into, name);
      fs.copyFileSync(file, target);
      entries.push({ name, bytes: fs.statSync(target).size, sha256: sha256(target) });
    }
    const manifest = writeManifest(into, entries);
    if (!quiet) for (const entry of entries) console.log(`  ${entry.name.padEnd(20)} ${String(entry.bytes).padStart(9)} byte`);
    return { folder: into, manifest };
  }

  /**
   * The manifest of a backup folder: what is inside and with which fingerprint. Without it, a
   * folder of files is not a backup — it is a folder of files nobody knows anything about, and an
   * unverifiable restore is not a restore.
   *
   * The count is tolerant on purpose: it happens that a backup is made **precisely** when the
   * registry is unreadable — that is the case for restoring. The backup is made anyway and the
   * manifest says so (`readable: false`), instead of failing everything.
   */
  function writeManifest(into, entries) {
    const chats = entries.some((entry) => entry.name === 'sessions.json')
      ? (() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(into, 'sessions.json'), 'utf8')).sessions?.length ?? null;
        } catch {
          return null;
        }
      })()
      : null;
    const manifest = {
      version: 1,
      createdAt: new Date(now()).toISOString(),
      source: config.home,
      chats,
      readable: chats !== null,
      files: entries,
      // The transcripts are not here, and it must be said in every backup: it is the question
      // anyone looking at a backup folder asks before a restore.
      note: 'the Claude Code transcripts are not in this backup: they stay in ~/.claude/projects',
    };
    fs.writeFileSync(path.join(into, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  /** Recomputes the fingerprints: a backup that cannot be verified is not a backup. */
  function verify(name) {
    const target = path.isAbsolute(name) ? name : path.join(folder, name);
    const manifest = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(target, 'MANIFEST.json'), 'utf8'));
      } catch {
        return null;
      }
    })();
    if (!manifest) return { ok: false, missing: true, folder: target, manifest: null, bad: [] };
    const bad = [];
    for (const entry of manifest.files ?? []) {
      const file = path.join(target, entry.name);
      try {
        if (sha256(file) !== entry.sha256) bad.push(entry.name);
      } catch {
        bad.push(entry.name);
      }
    }
    return { ok: bad.length === 0, missing: false, folder: target, manifest, bad };
  }

  /** All backups, from the most recent. The manifest is read; fingerprints are recomputed separately. */
  function list() {
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      return [];
    }
    return names
      .filter((name) => fs.existsSync(path.join(folder, name, 'MANIFEST.json')))
      .sort()
      .reverse()
      .map((name) => {
        const manifest = readManifest(name);
        return {
          name,
          createdAt: manifest?.createdAt ?? null,
          chats: manifest?.chats ?? null,
          readable: manifest?.readable !== false,
          files: manifest?.files?.length ?? 0,
          bytes: manifest?.files?.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) ?? 0,
          verified: null, // unknown until asked: `verify` costs a full read
        };
      });
  }

  /**
   * What would change if it were restored now. It **touches nothing**: it is the answer to the
   * question "what am I about to do?", and it must be given before confirmation, not after.
   */
  function plan(name) {
    const check = verify(name);
    if (check.missing) return { ok: false, reason: `${name}: not a WRA backup (MANIFEST.json missing)` };
    if (!check.ok) return { ok: false, reason: `${name}: the backup is not intact (fingerprint mismatches: ${check.bad.join(', ')})` };

    const incoming = chatsOf(check.folder);
    const current = (() => {
      try {
        const parsed = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
        return Array.isArray(parsed?.sessions) ? parsed.sessions : null;
      } catch {
        return null;
      }
    })();
    const byId = (list) => new Map((list ?? []).map((entry) => [entry.sessionId, entry]));
    const before = byId(current);
    const after = byId(incoming);
    const added = [...after.keys()].filter((id) => !before.has(id));
    const removed = [...current === null ? [] : before.keys()].filter((id) => !after.has(id));
    const nameOf = (map, id) => map.get(id)?.name ?? id.slice(0, 8);

    return {
      ok: true,
      folder: check.folder,
      createdAt: check.manifest.createdAt,
      // What is lost and what is gained, by name: "2 conversations" does not say which ones, and
      // the difference between "I resume yesterday's work" and "I throw away this morning's" is
      // all there.
      added: added.slice(0, 20).map((id) => nameOf(after, id)),
      removed: removed.slice(0, 20).map((id) => nameOf(before, id)),
      counts: {
        now: current?.length ?? null,
        after: incoming?.length ?? null,
        added: added.length,
        removed: removed.length,
      },
      currentUnreadable: current === null && fs.existsSync(config.stateFile),
      // A restore is not undoable by accident: what is there is set aside first.
      safety: fs.existsSync(config.stateFile) ? path.join(folder, `pre-restore-${stamp(now)}`) : null,
      transcripts: 'Claude Code transcripts are not touched: this backup does not contain them and the restore does not look for them',
      warnings: [
        current === null && fs.existsSync(config.stateFile)
          ? 'the current registry cannot be read: it will be set aside as it is, not overwritten'
          : null,
        check.manifest.readable === false ? 'the backup contains an unreadable registry: that is what would be restored' : null,
      ].filter(Boolean),
    };
  }

  /**
   * Restores. The rule that makes this function usable is a single one: **what is there is set
   * aside first, and if that fails nothing is touched**. A restore that overwrites data that was
   * not copied is just a second way to lose it.
   *
   * @returns {{ok: boolean, reason?: string, safety?: string, restored?: string[], chats?: number|null, moved?: string[]}}
   */
  function restore(name) {
    const check = verify(name);
    if (check.missing || !check.ok) {
      return { ok: false, reason: check.missing ? 'not a WRA backup' : `backup not intact: ${check.bad.join(', ')}` };
    }

    // What is about to be written, and nothing more: a file we do not know (a backup from a
    // future version) is not copied blindly into someone else's state.
    const targets = (check.manifest.files ?? [])
      .map((entry) => ({ entry, target: stateFiles(config).find((row) => row.name === entry.name) }))
      .filter((row) => row.target);

    /**
     * Before writing, **every file about to be replaced** must be safe. Not "the current state"
     * as a whole: exactly those, one by one. The difference showed up in a test: a locked registry
     * (EPERM) cannot be copied, the others can, and the restore started anyway only to die
     * halfway — with one file already replaced and no way back.
     */
    const existing = targets.filter(({ target }) => fs.existsSync(target.file));
    const moved = [];
    const saved = [];
    let safety = null;
    if (existing.length) {
      safety = path.join(folder, `pre-restore-${stamp(now)}`);
      for (const { target } of existing) {
        const copy = path.join(safety, path.basename(target.file));
        try {
          fs.mkdirSync(safety, { recursive: true });
          fs.copyFileSync(target.file, copy);
          // "Verifiable" means verified: a copy that cannot be checked is not a net, it is a hope.
          if (fs.statSync(copy).size !== fs.statSync(target.file).size) throw new Error('the copy does not match');
          saved.push({ name: path.basename(target.file), bytes: fs.statSync(copy).size, sha256: sha256(copy) });
          continue;
        } catch {
          // It could not be copied: almost always because the file cannot be opened (EPERM) and
          // copying requires reading it. So it is **moved** — moving does not require opening it —
          // and it stays in place under another name.
        }
        const aside = `${target.file}.pre-restore-${stamp(now)}`;
        try {
          fs.renameSync(target.file, aside);
          moved.push(aside);
        } catch (error) {
          return {
            ok: false,
            reason: `cannot set aside ${path.basename(target.file)} (${error.code || error.message}): restoring nothing. `
              + 'On Windows this is almost always broken permission inheritance: icacls "<folder>" /reset /t',
          };
        }
      }
      // The safety copy is a backup like the others, with its manifest: thus it can be **verified**
      // before trusting it, and it shows up in the list if the restore was wrong.
      if (saved.length) writeManifest(safety, saved);
      else {
        fs.rmSync(safety, { recursive: true, force: true });
        safety = null;
      }
    }

    const restored = [];
    const failed = [];
    for (const { entry, target } of targets) {
      try {
        fs.mkdirSync(path.dirname(target.file), { recursive: true });
        fs.copyFileSync(path.join(check.folder, entry.name), target.file);
        restored.push(entry.name);
      } catch (error) {
        // From here on nothing is thrown: whoever reads must know **what** went through and what
        // did not, and that the previous state is safe somewhere.
        failed.push(`${entry.name} (${error.code || error.message})`);
      }
    }
    return {
      ok: true,
      safety,
      moved,
      restored,
      failed,
      partial: failed.length > 0 && restored.length > 0,
      chats: check.manifest.chats ?? null,
    };
  }

  return { folder, create, list, verify, plan, restore };
}