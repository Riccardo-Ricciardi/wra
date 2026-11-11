import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { framePrompt } from '../core/prompt.mjs';
import { writeFileAtomic } from '../core/atomic.mjs';
import { pathKey } from '../core/workspace.mjs';
import { createInputModeFilter } from '../core/input-mode.mjs';
import { linkInPath } from '../core/paths.mjs';
import { spawnClaude, transcriptDirFor } from './pty-host.mjs';
import { createProcessLedger, ledgerFile } from './process-ledger.mjs';

const hookScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'perm-hook.mjs');

/**
 * The settings we pass to a session's `claude` with `--settings`: a `PermissionRequest` hook that
 * is our bridge to the browser.
 *
 * `--settings` **adds**, it does not replace: the user's hooks and permissions stay as they are.
 * The command is quoted because the Node path on Windows almost always has a space.
 */
export function approvalSettings({ script = hookScript, node = process.execPath, timeoutS = 150 } = {}) {
  return JSON.stringify({
    hooks: {
      PermissionRequest: [{
        hooks: [{ type: 'command', command: `"${node}" "${script}"`, timeout: timeoutS }],
      }],
    },
  });
}

/**
 * Where a session may run. The path comes from outside (a client writes it, or a `?dir=` link),
 * and goes straight into a process's `cwd`: without this check a `?dir=\\server\share` link would
 * make the machine authenticate to someone else's server (NTLM credential theft/relay) or would
 * start the agent inside a folder planted by third parties.
 *
 * Rules: absolute local path, no UNC, no link along the way, it must exist, and it must be under
 * one of the allowed roots (default: the user folder). `CR_ALLOWED_ROOTS` changes them.
 */
export function resolveProjectDir(input, { allowedRoots = [], home = os.homedir() } = {}) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'missing project path' };

  const raw = input.trim();
  if (/^[\\/]{2}/.test(raw)) return { ok: false, reason: 'network paths (UNC) are not allowed' };

  let resolved;
  try {
    resolved = path.resolve(raw);
  } catch {
    return { ok: false, reason: 'invalid path' };
  }

  const roots = allowedRoots.length ? allowedRoots : [home];
  const norm = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  const target = norm(resolved);
  // The narrowest allowed root that contains the path: links are checked under that one, because
  // that is where someone could plant one.
  const allowed = roots
    .map(norm)
    .filter((base) => target === base || target.startsWith(base + path.sep))
    .sort((a, b) => b.length - a.length)[0];
  if (!allowed) return { ok: false, reason: `folder outside the allowed roots: ${resolved}` };

  const link = linkInPath(resolved, allowed);
  if (link) {
    return { ok: false, reason: `a component of the path is a link (${link}): paths that go through a link are not allowed` };
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, reason: `the folder does not exist: ${resolved}` };
  }
  if (!stat.isDirectory()) return { ok: false, reason: `not a folder: ${resolved}` };

  return { ok: true, path: resolved };
}

/** the transcript path of a session: with the id we chose, it is deterministic */
export function transcriptFor(session, projectsRoot) {
  return path.join(transcriptDirFor(session.projectPath, projectsRoot), `${session.sessionId}.jsonl`);
}

// Tail of the last bytes, for whoever attaches later: without it, a client arriving late would see
// an empty screen and it would look broken.
//
// ponytail: whole chunks are kept and the oldest are dropped; the cut can fall in the middle of an
// ANSI sequence, so the first lines of the replay may come out dirty. That is fine: the replay is
// there to *see where you are*, not to reconstruct history.
class Replay {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.size = 0;
  }

  add(data) {
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.limit && this.chunks.length > 1) this.size -= this.chunks.shift().length;
  }

  text() {
    return this.chunks.join('');
  }
}

/** Atomic write: the sessions file must not remain half-written if the process dies. */
function writeAtomic(file, text) {
  return writeFileAtomic(file, text, {
    // A backup is written only from a verified primary state, never from corrupted data.
    verify: (parsed) => { if (!Array.isArray(parsed?.sessions)) throw new Error('invalid sessions state'); },
  });
}

/**
 * The durable state of sessions: id (which is also the conversation id), name, folder, whether it
 * is allowed for MCP. It lives in a file, because the PTY process is expendable but the conversation
 * is not: on restart it resumes from here, with the right id, never "the most recent transcript"
 * (with several chats in the same folder that would be a gamble).
 */
function createStore({ file, now = () => Date.now() }) {
  let sessions = [];

  const load = () => {
    const read = (filename) => {
      const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!Array.isArray(parsed?.sessions)) throw new Error('invalid session registry');
      const valid = parsed.sessions.filter((entry) => entry && typeof entry.sessionId === 'string' && typeof entry.projectPath === 'string' && entry.sessionId && entry.projectPath);
      // Two entries with the same id are a corrupted registry (written by hand, or badly merged by
      // someone). The **first** is kept and the rest are discarded: without this, `list()` showed
      // two of them, `get()` saw one, and `forget` deleted two — that is, a conversation nobody had
      // asked to remove was lost.
      const seen = new Set();
      const unique = valid.filter((entry) => {
        if (seen.has(entry.sessionId)) return false;
        seen.add(entry.sessionId);
        return true;
      });
      if (unique.length !== valid.length) {
        console.warn(`the registry had ${valid.length - unique.length} entries with a repeated id: the first of each was kept`);
      }
      return unique;
    };
    if (!fs.existsSync(file)) {
      sessions = [];
      return sessions;
    }
    try {
      sessions = read(file);
    } catch (primaryError) {
      // Fail closed: never silently replace a damaged registry with an empty one.
      let recovered;
      try {
        recovered = read(`${file}.bak`);
      } catch (backupError) {
        const why = (error) => error?.code || error?.message || 'unknown reason';
        throw new Error(`Cannot load session registry (${file}); primary and backup invalid (primary: ${why(primaryError)}; backup: ${why(backupError)}). Refusing to overwrite user sessions.`, { cause: new AggregateError([primaryError, backupError]) });
      }
      // The backup is there and reads: start from it. The primary, however, does not read — and
      // "does not read" is not "is broken": it may be a permissions problem, and then moving it
      // fails too. That failure used to end in the same `catch` as the backup read, so the message
      // blamed the backup ("primary and backup invalid") while the backup was perfectly healthy:
      // 02/11 cost half a day of diagnosis.
      const damaged = `${file}.corrupt-${Date.now()}`;
      let quarantined = null;
      try {
        fs.renameSync(file, damaged);
        quarantined = damaged;
      } catch { /* unreadable and not movable: it stays where it is, and is not touched */ }
      try {
        fs.copyFileSync(`${file}.bak`, file);
        console.warn(`Session registry restored from backup; damaged original saved as ${quarantined ?? '— not movable, left in place'}`);
      } catch (writeError) {
        // The registry is in memory and the conversations are visible, but the file on disk cannot
        // be replaced: saves will be refused (see `writeFileAtomic`) until the permission is fixed.
        // Better to say it here than to discover it on the first lost save.
        console.warn(`Session registry loaded from ${file}.bak (${recovered.length} conversations); ${file} is neither readable nor replaceable (${writeError.code}): saves will be refused as long as that file stays like this`);
      }
      sessions = recovered;
    }
    return sessions;
  };

  /**
   * Saves **the version passed to it**, and only then makes it the in-memory one.
   *
   * Order matters: write first, then update `sessions`. If it updated first — as it used to — a
   * failed write left a conversation that existed for the interface and not on disk: it showed in
   * the list, was renamed, and was gone after a restart.
   */
  const save = (next = sessions) => {
    const { quarantined } = writeAtomic(file, `${JSON.stringify({ version: 1, savedAt: new Date(now()).toISOString(), sessions: next }, null, 2)}\n`);
    if (quarantined) {
      console.warn(`the registry was unreadable: the broken version is in ${quarantined}, and a new one was written`);
    }
    sessions = next;
    return sessions;
  };

  return {
    load,
    save,
    all: () => sessions,
    get: (id) => sessions.find((entry) => entry.sessionId === id) ?? null,
    upsert: (record) => {
      const index = sessions.findIndex((entry) => entry.sessionId === record.sessionId);
      const next = index === -1
        ? [...sessions, record]
        : sessions.map((entry, at) => (at === index ? { ...entry, ...record } : entry));
      save(next);
      return sessions.find((entry) => entry.sessionId === record.sessionId);
    },
    /**
     * Updates a chat that already exists, and **does not** create it if it is not there. The
     * difference matters: the process of a forgotten chat exits an instant later, and with `upsert`
     * that goodbye resurrected the record — without folder and without name, that is, a ghost chat
     * that then made the server crash on restart.
     */
    touch: (id, fields) => {
      const index = sessions.findIndex((entry) => entry.sessionId === id);
      if (index === -1) return null;
      save(sessions.map((entry, at) => (at === index ? { ...entry, ...fields } : entry)));
      return sessions.find((entry) => entry.sessionId === id);
    },
    remove: (id) => {
      const next = sessions.filter((entry) => entry.sessionId !== id);
      if (next.length === sessions.length) return false;
      save(next);
      return true;
    },
  };
}

/**
 * The registry: one session per conversation, with its process. It is the lock against two
 * processes on the same conversation — the rule that was paid for dearly on 27/10 — and now it is
 * also the place where a chat *exists* even when its process is off.
 */
export function createRegistry({ config, spawn = spawnClaude, now = () => Date.now() }) {
  const store = createStore({ file: config.stateFile, now });
  // What we started: it recognizes processes left behind after a forced shutdown (see
  // `process-ledger.mjs`). Writing here cannot break a session: every error is swallowed.
  const ledger = createProcessLedger({ file: ledgerFile(config), now });
  const live = new Map(); // sessionId -> { shell, replay, state, pid, lastOutputAt }
  const listeners = new Set();
  /**
   * The conversations whose process is **dead**. `exited` is not `offline`, and the difference
   * matters twice: for whoever is watching — a window attached to a finished conversation must be
   * able to know it, instead of staying mute forever — and for whoever reads the state later,
   * because a killed process is not a process that was never started. This information used to be
   * lost: the live record was removed from the map *before* building the view, so every death
   * became "off", identical to an imported chat that was never started.
   *
   * It is deliberately not durable: after a server restart it is no longer known how a conversation
   * ended, and inventing it would be worse than saying "off".
   */
  const exited = new Set();

  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };

  const record = (id) => store.get(id) ?? null;

  const modeOf = (entry) => entry.permissionMode ?? config.permissionMode;

  /**
   * Is the consent to bypass exposure still valid?
   *
   * **It expires.** A consent given once and forgotten is a consent valid forever, and the thing
   * the consent authenticates is the *moment* it was given, not the traffic that comes after: if the
   * owner no longer remembers it, the window closes by itself. The value is read from the written
   * date, so there is nothing to rewrite and nothing that can stay on by inertia.
   * `CR_MCP_BYPASS_TTL_S=0` removes the expiry — an explicit choice, not the default.
   */
  const consentValid = (entry) => {
    if (!entry.mcpBypassAt) return false;
    const ttlMs = (config.mcpBypassTtlSeconds ?? 43_200) * 1_000;
    if (!ttlMs) return true;
    const at = Date.parse(entry.mcpBypassAt);
    return Number.isFinite(at) && now() - at < ttlMs;
  };

  /**
   * Is the chat **really** reachable from MCP?
   *
   * `mcpAllowed` alone is not enough: a chat in bypass is reachable only if the owner accepted
   * **that exposure** (`mcpBypassAt`, dated) and that consent has not expired. The conjunction is
   * applied here, at read time, and not only where it is written: thus a hand-modified registry, or
   * state left from a previous version, cannot expose a chat in bypass without a recorded and fresh
   * consent.
   */
  const reachable = (entry) =>
    Boolean(entry.mcpAllowed)
    && !entry.archived
    && (modeOf(entry) !== 'bypassPermissions' || consentValid(entry));

  /** What the confirmation must repeat: the chat name, or the start of the id if it has no name. */
  const confirmToken = (entry) => entry.name || entry.sessionId.slice(0, 8);

  const view = (entry) => {
    const running = live.get(entry.sessionId);
    return {
      sessionId: entry.sessionId,
      name: entry.name,
      projectPath: entry.projectPath,
      // The project key, computed here once: the browser groups by this instead of rewriting the
      // Windows path rules — which is how two implementations of the same thing diverge.
      projectKey: pathKey(entry.projectPath),
      // The owner's switch, as it is on disk. It is used to draw the switch and to know what was
      // chosen: it is **not** the answer to "can ChatGPT talk to it".
      mcpAllowed: Boolean(entry.mcpAllowed),
      // That answer. This is the one to use for deciding, and for showing the badge.
      mcpReachable: reachable(entry),
      // When the owner accepted exposing **this** chat in bypass. `null` = no consent: and then a
      // chat in bypass is not reachable, period.
      mcpBypassAt: entry.mcpBypassAt ?? null,
      // Visible in the interface: a chat with permissions skipped must say so, not look like the
      // others.
      permissionMode: modeOf(entry),
      // `null` = "the project's applies", `true`/`false` = this conversation's choice. The view
      // carries the raw choice on purpose: whoever draws the switch also knows what the project
      // says, and resolving it here would hide *who* decided.
      autoApprove: entry.autoApprove ?? null,
      // Pinned at the top of its project, and the section it belongs to: two ways of organizing the
      // list that touch neither the real project nor the transcript.
      favorite: Boolean(entry.favorite),
      label: entry.label ?? null,
      archived: Boolean(entry.archived),
      imported: Boolean(entry.imported),
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt ?? null,
      state: running ? running.state : (exited.has(entry.sessionId) ? 'exited' : 'offline'),
      pid: running?.pid ?? null,
      cols: running?.cols ?? config.cols,
      rows: running?.rows ?? config.rows,
      transcript: transcriptFor(entry, config.projectsRoot),
      busy: Boolean(running?.busyTurn),
    };
  };

  store.load();

  const quiet = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // "Ready" = it has already written something and was quiet for a moment: the TUI has finished
  // drawing. Sending the prompt during startup makes it get eaten by the splash screen.
  async function ready(entry, { quietMs = 900, timeoutMs = 30_000 } = {}) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const running = live.get(entry.sessionId);
      if (!running || running.shell.exited) return;
      const since = running.lastOutputAt ? now() - running.lastOutputAt : null;
      if (since !== null && since >= quietMs) return;
      await quiet(150);
    }
  }

  function spawnShell(entry, { resume = false } = {}) {
    const args = [...config.claudeArgs];
    // We decide the conversation id: thus the transcript is at a known path and resuming a chat is
    // an exact thing, not a search for the most recent file.
    if (resume) args.push('--resume', entry.sessionId);
    else args.push('--session-id', entry.sessionId);
    // The mode belongs to the conversation, not the server: the choice made when opening the chat
    // survives `--resume`, and different chats can have two different ones.
    const mode = entry.permissionMode ?? config.permissionMode;
    if (mode) args.push('--permission-mode', mode);

    // The bridge for approvals. The token goes in the environment and not on the command line,
    // where anyone on the machine would read it from a process list.
    const env = { ...process.env };
    if (config.hooks) {
      args.push('--settings', approvalSettings({ timeoutS: Math.ceil(config.approvalTtlMs / 1000) + 30 }));
      env.CR_APPROVE_URL = `http://127.0.0.1:${config.port}/local/approve`;
      env.CR_APPROVE_TOKEN = config.token;
      env.CR_APPROVE_SESSION = entry.sessionId;
      env.CR_APPROVE_TTL_MS = String(config.approvalTtlMs);
    }

    const state = {
      shell: null,
      replay: new Replay(config.replayBytes),
      state: 'starting',
      pid: null,
      cols: config.cols,
      rows: config.rows,
      lastOutputAt: null,
      busyTurn: false,
      // The Windows PTY asks the terminal to change the key encoding (`ESC[?9001h`). That request
      // applies to the program inside the PTY, not to whoever attaches: if it reaches the watcher's
      // terminal, Ctrl+Q is no longer a byte and detaching stops working. It is removed here, once,
      // for all clients.
      filter: createInputModeFilter(),
    };

    exited.delete(entry.sessionId); // it is restarting: no longer "finished"

    /**
     * The process living **right now** in this conversation: `live` is the truth, and whoever
     * receives a callback must still be that one.
     *
     * Why it is needed: `stop()` followed by `start()` (permission mode change, chat restart) leaves
     * the old process around, dying an instant later. Its `onExit` did `live.delete(sessionId)` —
     * that is, it deleted the **new** process's entry. From there: the chat appeared to have no
     * process (not writable, `stop` could no longer reach it), and `sinkFor` — not finding it alive
     * — started **a second `--resume` on the same conversation**: exactly the double process the
     * registry exists to prevent.
     *
     * `live.has` before the comparison: during `spawn` the entry is not registered yet, and that
     * window is not a replacement — it is the start.
     */
    const isCurrent = () => !live.has(entry.sessionId) || live.get(entry.sessionId) === state;

    state.shell = spawn({
      projectDir: entry.projectPath,
      command: config.claudeCmd,
      cols: config.cols,
      rows: config.rows,
      args,
      env,
      onData: (raw) => {
        if (!isCurrent()) return; // output from a process that is no longer the session's
        const data = state.filter.write(raw);
        if (!data) return;
        state.replay.add(data);
        state.lastOutputAt = now();
        if (state.state === 'starting') {
          state.state = 'ready';
          emit({ type: 'state', session: view(entry) });
        }
        emit({ type: 'output', session: view(entry), data });
      },
      onExit: (event) => {
        state.state = 'exited';
        ledger.forget(state.pid); // really exited: no longer a clue about anything
        if (!isCurrent()) return; // the session already belongs to another process: this exit is not about it
        live.delete(entry.sessionId);
        // A requested shutdown is not a death: `stop()` marks it, and the state stays "off" (which
        // is what the interface menu must see in order to turn it back on).
        if (!state.stopping) exited.add(entry.sessionId);
        store.touch(entry.sessionId, { lastActivityAt: new Date(now()).toISOString() });
        emit({ type: 'state', session: view(entry), exitCode: event?.exitCode ?? null });
      },
    });

    state.pid = state.shell.pid ?? null;
    ledger.note({ pid: state.pid, sessionId: entry.sessionId, name: entry.name });
    live.set(entry.sessionId, state);
    emit({ type: 'state', session: view(entry) });
    return state;
  }

  const assertAllowed = (projectPath) => {
    const resolved = resolveProjectDir(projectPath, { allowedRoots: config.allowedRoots, home: config.home });
    if (!resolved.ok) {
      const error = new Error(resolved.reason);
      error.code = 'BAD_PROJECT_DIR';
      throw error;
    }
    return resolved.path;
  };

  /** The same path, written in a comparable way. */
  const samePath = (a, b) => path.resolve(a).replace(/[\\/]+$/, '').toLowerCase()
    === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();

  const inProject = (projectPath) => store.all().filter((entry) => samePath(entry.projectPath, projectPath));

  /**
   * The automatic name matters **within the project**: with a global counter, "chat 1" ended up in
   * two different projects and the list no longer made clear which was which.
   */
  const freeName = (projectPath, wanted) => {
    const taken = new Set(inProject(projectPath).map((entry) => entry.name.toLowerCase()));
    if (wanted?.trim()) {
      const clean = wanted.trim().slice(0, 60);
      if (!taken.has(clean.toLowerCase())) return clean;
      // A requested name already taken gets a number: better "name 2" than two identical rows.
      for (let n = 2; n < 999; n += 1) if (!taken.has(`${clean} ${n}`.toLowerCase())) return `${clean} ${n}`;
      return clean;
    }
    for (let n = inProject(projectPath).length + 1; n < 999; n += 1) {
      if (!taken.has(`chat ${n}`.toLowerCase())) return `chat ${n}`;
    }
    return `chat ${crypto.randomUUID().slice(0, 4)}`;
  };

  return {
    /** A new chat in a folder: our id, `mcpAllowed` off until you turn it on. */
    create({ projectPath, name = null, start = true, sessionId = null, imported = false, permissionMode = null, autoApprove = null } = {}) {
      const resolvedPath = assertAllowed(projectPath);
      // The same closed list as `setPermissionMode`, and for the same reason: this value ends up in
      // `claude --permission-mode`, and a value coming from outside must not be able to become an
      // arbitrary argument on `claude`'s command line.
      //
      // `setPermissionMode` checked it and `create` did not: the creation route accepted any string,
      // and it was the widest door through which entered a mode the interface cannot describe.
      // Found by a security review, not by a test.
      if (permissionMode !== null && !config.permissionModes.includes(permissionMode)) {
        const error = new Error(`unrecognized mode: ${permissionMode} (allowed: ${config.permissionModes.join(', ')})`);
        error.code = 'BAD_PERMISSION_MODE';
        throw error;
      }
      if (store.all().length >= config.maxSessions) {
        const error = new Error(`too many saved sessions (max ${config.maxSessions}): close one`);
        error.code = 'TOO_MANY_SESSIONS';
        throw error;
      }
      // A per-project cap, if desired: the global cap protects the machine, this one protects a
      // single project from becoming a dump.
      const perProject = config.maxSessionsPerProject ?? 0;
      if (perProject > 0 && inProject(resolvedPath).length >= perProject) {
        const error = new Error(`this project already has ${perProject} conversations (CR_MAX_SESSIONS_PER_PROJECT)`);
        error.code = 'TOO_MANY_SESSIONS';
        throw error;
      }

      const id = sessionId ?? crypto.randomUUID();
      const existing = record(id);
      if (existing) {
        // Bringing back a conversation that already exists is not an error: it is updated.
        return view(existing);
      }

      const entry = store.upsert({
        sessionId: id,
        name: freeName(resolvedPath, name),
        projectPath: resolvedPath,
        mcpAllowed: false,
        // The permission mode is born with the conversation and stays its own. Whoever does not
        // state it takes the server's (the normal one); `cc` requests bypass for the chat it opens.
        permissionMode: permissionMode ?? config.permissionMode,
        // Controlled auto-approval: off at the start, and **never** turned on as a consequence of
        // something else. `null` means "I did not decide: the project's applies"; a conversation
        // saying `false` stays off even inside a project that turned it on.
        autoApprove: autoApprove === true ? true : autoApprove === false ? false : null,
        // `imported` distinguishes a recovered conversation from one opened here: it shows in the
        // list, and says where it came from without having to guess.
        imported: Boolean(imported),
        archived: false,
        createdAt: new Date(now()).toISOString(),
        lastActivityAt: null,
      });

      // An imported conversation is not started: the process starts when someone uses it.
      if (start && !imported) spawnShell(entry, { resume: false });
      return view(entry);
    },

    /** Resumes an existing chat: same id, therefore same conversation. */
    start(sessionId) {
      const entry = record(sessionId);
      if (!entry) throw new Error(`unknown session: ${sessionId}`);
      const running = live.get(sessionId);
      if (running && !running.shell.exited) return view(entry);

      const needsResume = fs.existsSync(transcriptFor(entry, config.projectsRoot));
      spawnShell(entry, { resume: needsResume });
      return view(entry);
    },

    /** Turns off the process, not the chat: the record stays and resumes with the same id. */
    stop(sessionId) {
      const entry = record(sessionId);
      const running = live.get(sessionId);
      if (running) {
        running.stopping = true; // requested from here: not a death, a shutdown
        running.shell.kill();
        live.delete(sessionId);
      }
      exited.delete(sessionId);
      if (entry) {
        store.touch(sessionId, { lastActivityAt: new Date(now()).toISOString() });
        emit({ type: 'state', session: view(entry) });
      }
      return entry ? view(entry) : null;
    },

    /** Removes the chat from the list (the transcript on disk is not touched). */
    forget(sessionId) {
      this.stop(sessionId);
      return store.remove(sessionId);
    },

    rename(sessionId, name) {
      const entry = record(sessionId);
      if (!entry) throw new Error(`unknown session: ${sessionId}`);
      const wanted = String(name).trim().slice(0, 60);
      if (wanted) {
        const clash = inProject(entry.projectPath).find(
          (other) => other.sessionId !== sessionId && other.name.toLowerCase() === wanted.toLowerCase(),
        );
        if (clash) {
          const error = new Error(`this project already has a conversation named "${clash.name}"`);
          error.code = 'NAME_TAKEN';
          throw error;
        }
      }
      store.touch(sessionId, { name: wanted || entry.name });
      emit({ type: 'state', session: view(record(sessionId)) });
      return view(record(sessionId));
    },

    /**
     * Archives: the conversation stays in the registry and its transcript is not touched, but it
     * leaves the list. It closes work without losing it — "remove from list" deletes the entry,
     * this puts it away.
     */
    setArchived(sessionId, archived = true) {
      const entry = record(sessionId);
      if (!entry) throw new Error(`unknown session: ${sessionId}`);
      // Archiving drops the high-privilege consent: putting a chat away is not a decision about
      // privileges, and bringing it back from the archive must not turn back on by itself a
      // combination the owner may have forgotten in the meantime. Normal exposure remains: that one
      // has nothing to reconfirm.
      store.touch(sessionId, archived ? { archived: true, mcpBypassAt: null } : { archived: false });
      if (archived) this.stop(sessionId); // an archived conversation does not keep a process running
      emit({ type: 'state', session: view(record(sessionId)) });
      return view(record(sessionId));
    },

    /** The star: pins a conversation at the top of its project. Changes nothing else. */
    setFavorite(sessionId, favorite = true) {
      const entry = record(sessionId);
      if (!entry) throw new Error(`unknown session: ${sessionId}`);
      store.touch(sessionId, { favorite: Boolean(favorite) });
      emit({ type: 'state', session: view(record(sessionId)) });
      return view(record(sessionId));
    },

    /**
     * The section a conversation belongs to: a label, not a move. The project folder and the
     * transcript stay where they are — organizing the list must not be able to break a
     * conversation.
     */
    setLabel(sessionId, label) {
      const entry = record(sessionId);
      if (!entry) throw new Error(`unknown session: ${sessionId}`);
      // The type is checked here, at the boundary: `String({})` is not an error, it is
      // "[object Object]" — that is, a section nobody wrote, saved forever.
      if (label !== null && typeof label !== 'string') {
        const error = new Error('the section must be text');
        error.code = 'BAD_LABEL';
        throw error;
      }
      const clean = String(label ?? '').trim().slice(0, 30);
      store.touch(sessionId, { label: clean || null });
      emit({ type: 'state', session: view(record(sessionId)) });
      return view(record(sessionId));
    },

    /**
     * The switch that exposes a chat to MCP: off by default, turned on by hand.
     *
     * On a chat **in bypass** exposure is a different and more serious thing, and it is not turned
     * on by accident: it requires a `confirm` that repeats the chat name (the server compares it, not
     * a window in the browser) and it remains written **when** it was given (`mcpBypassAt`).
     *
     * Why it is more serious, without beating around the bush: in bypass the agent never asks, so
     * the permission request — the only point where the person decides — does not exist. With the
     * chat exposed, a remote model composes the message, and an agent with the Windows user's
     * privileges executes it. It is not a sandbox: there is nothing in here that stops a command.
     * What this mode guarantees is that **nobody turned it on for you**.
     */
    setMcpAllowed(sessionId, allowed, { confirm = null } = {}) {
      const entry = record(sessionId);
      if (!entry) throw new Error(`unknown session: ${sessionId}`);

      if (allowed && modeOf(entry) === 'bypassPermissions') {
        const wanted = confirmToken(entry);
        // A **string** is required, not something that looks like it: `['giulia']` and `['giulia'] + ''`
        // give the same text, and a confirmation that can be written in two ways is a confirmation
        // that can be given unwillingly. The comparison stays exact.
        if (typeof confirm !== 'string' || confirm !== wanted) {
          const error = new Error(
            'this chat skips permissions: exposing it to ChatGPT means a remote client drives it '
            + 'without anyone approving anything. The explicit confirmation repeating the name is required: '
            + `confirm = "${wanted}"`,
          );
          error.code = 'BYPASS_NEEDS_CONFIRM';
          error.confirm = wanted;
          throw error;
        }
        // The registry clock, not `new Date()`: the consent expiry is measured from here, and two
        // different clocks in the same class are two different expiries.
        store.touch(sessionId, { mcpAllowed: true, mcpBypassAt: new Date(now()).toISOString() });
        emit({ type: 'state', session: view(record(sessionId)) });
        return view(record(sessionId));
      }

      // Outside bypass the consent has nothing left to refer to: it is removed, so that returning
      // to bypass one day requires a new decision instead of inheriting an old one.
      store.touch(sessionId, { mcpAllowed: Boolean(allowed), mcpBypassAt: null });
      emit({ type: 'state', session: view(record(sessionId)) });
      return view(record(sessionId));
    },

    /**
     * The "controlled automatic MCP" switch on a conversation: it accepts permission requests the
     * policy can verify (a path inside the project, no credentials, no security configuration) and
     * keeps asking for everything else.
     *
     * Off at the start, and only turned on here: no environment variable, no implicit inheritance.
     * A conversation in bypass **cannot** turn it on — in bypass the hook is not even run, so the
     * switch would decide nothing and the person would believe they had a boundary that is not
     * there.
     */
    setAutoApprove(sessionId, enabled) {
      const entry = record(sessionId);
      if (!entry) throw new Error(`unknown session: ${sessionId}`);
      if (enabled && (entry.permissionMode ?? config.permissionMode) === 'bypassPermissions') {
        const error = new Error('this chat skips permissions: in bypass nobody asks, so the policy would decide nothing. Bring it back to the normal mode (`wra permissions default`)');
        error.code = 'AUTO_NOT_BYPASSABLE';
        throw error;
      }
      store.touch(sessionId, { autoApprove: Boolean(enabled) });
      emit({ type: 'state', session: view(record(sessionId)) });
      return view(record(sessionId));
    },

    /**
     * Changes the permission mode of a conversation. `--permission-mode` is read only when `claude`
     * starts, so the live process must be restarted: the conversation is the same (`--resume`, same
     * id), but the new process starts with the chosen mode. A busy process is not touched — a
     * running turn would be lost — and it says so.
     */
    setPermissionMode(sessionId, mode) {
      const entry = record(sessionId);
      if (!entry) throw new Error(`unknown session: ${sessionId}`);
      if (!config.permissionModes.includes(mode)) {
        const error = new Error(`unrecognized mode: ${mode} (allowed: ${config.permissionModes.join(', ')})`);
        error.code = 'BAD_PERMISSION_MODE';
        throw error;
      }
      // Nor the other way around: a chat already exposed to ChatGPT is not put in bypass, for the
      // same reason. The order is: remove exposure, set bypass, then turn exposure back on accepting
      // the warning — three gestures, and none of the three is a silent privilege escalation.
      //
      // Only on a **transition**: setting again the mode the chat already has is not a privilege
      // jump, and refusing it would mean a bypass chat exposed with consent cannot even be
      // reconfirmed as it is. (Found by a test case, not by reasoning.)
      if (mode === 'bypassPermissions' && modeOf(entry) !== 'bypassPermissions' && entry.mcpAllowed) {
        const error = new Error('this chat is exposed to ChatGPT: turn off "Allow ChatGPT", then set bypass, then turn exposure back on accepting the warning');
        error.code = 'BYPASS_NOT_EXPOSABLE';
        throw error;
      }
      // Third door of the same room: bypass turns off the hook, so it would make the automatic
      // policy a decoration. First the policy is turned off, then everything is skipped — never the
      // other way around, which is the order in which the person believes they have two protections
      // and has zero.
      if (mode === 'bypassPermissions' && entry.autoApprove === true) {
        const error = new Error('"controlled automatic MCP" is on for this chat: in bypass it would not be applied. Turn off the automatic policy before skipping permissions');
        error.code = 'BYPASS_NOT_AUTO';
        throw error;
      }
      const running = live.get(sessionId);
      if (running?.busyTurn) {
        const error = new Error('the chat is working: wait for the turn to end before changing permissions');
        error.code = 'BUSY';
        throw error;
      }
      // Changing mode drops the bypass exposure consent: it was a consent to *that* configuration,
      // not to the chat. It also applies when returning to bypass later — the old consent is not
      // inherited, and whoever wants that combination again must request it.
      // (Setting the same mode again is not a change, and drops nothing.)
      const changed = modeOf(entry) !== mode;
      store.touch(sessionId, changed ? { permissionMode: mode, mcpBypassAt: null } : { permissionMode: mode });
      if (running && !running.shell.exited) {
        this.stop(sessionId);
        this.start(sessionId);
      }
      emit({ type: 'state', session: view(record(sessionId)) });
      return view(record(sessionId));
    },

    /**
     * Removes **all** bypass exposure consents, and says which ones they were.
     *
     * It serves one case only, and it is the one that matters: a restore from a backup. Restoring
     * puts the registry back as it was, but consent is a **privilege**, and a privilege must not
     * come back from a backup without someone granting it again: a backup made before a revocation
     * would bring the revocation back. Everything else is restored, and whoever wants that
     * combination again must request it.
     */
    clearBypassConsents() {
      const had = store.all().filter((entry) => entry.mcpBypassAt);
      for (const entry of had) store.touch(entry.sessionId, { mcpBypassAt: null });
      if (had.length) emit({ type: 'state', session: null });
      return had.map((entry) => ({ sessionId: entry.sessionId, name: entry.name, at: entry.mcpBypassAt }));
    },

    list: () => store.all().map(view),
    get: (sessionId) => (record(sessionId) ? view(record(sessionId)) : null),
    /**
     * The chats an MCP client can see — and they are **only** these: the list is the conjunction
     * (switch on, not archived, and in bypass only with a recorded consent). It is the same function
     * that decides the badge, so what is seen and what can be touched cannot diverge.
     */
    mcpAllowed: () => store.all().filter(reachable).map(view),
    exists: (sessionId) => Boolean(record(sessionId)),

    /** The live state of a session (for the turn coordinator). */
    runtime: (sessionId) => live.get(sessionId) ?? null,
    markBusy: (sessionId, busy) => {
      const running = live.get(sessionId);
      if (running) running.busyTurn = Boolean(busy);
    },
    setSize(sessionId, cols, rows) {
      const running = live.get(sessionId);
      if (!running) return false;
      if (running.cols === cols && running.rows === rows) return false;
      running.cols = cols;
      running.rows = rows;
      running.shell.resize(cols, rows);
      return true;
    },

    /** The last screen bytes of a live session (for whoever attaches later). */
    replay(sessionId) {
      return live.get(sessionId)?.replay.text() ?? '';
    },

    /** What the turn engine needs: `send(text)` and the session id. */
    sinkFor(sessionId) {
      const entry = record(sessionId);
      if (!entry) throw new Error(`unknown session: ${sessionId}`);
      if (!live.has(sessionId)) this.start(sessionId);
      return {
        sessionId,
        projectPath: entry.projectPath,
        transcriptPath: transcriptFor(entry, config.projectsRoot),
        /**
         * Is the process still alive? It is needed by a running turn: if the `claude` dies (crash,
         * user close, `taskkill`), without this answer the turn would stay hanging waiting for a
         * reply that will never arrive, until its long expiry.
         */
        alive: () => {
          const running = live.get(sessionId);
          return Boolean(running) && !running.shell.exited;
        },
        send: async (text) => {
          await ready(entry);
          const running = live.get(sessionId);
          if (!running) throw new Error(`session ${sessionId} is no longer alive`);
          running.shell.write(framePrompt(text));
          store.touch(sessionId, { lastActivityAt: new Date(now()).toISOString() });
        },
      };
    },

    closeAll: () => {
      for (const [id, running] of live) {
        running.shell.kill();
        live.delete(id);
      }
      // Everything is shutting down, and from here on nothing of ours is running: the process
      // ledger is cleared. It serves the only case that does not pass through here — a forced
      // shutdown, where no code runs and the pids remain written: that is what is looked for.
      ledger.clear();
    },

    /**
     * Re-reads the registry from disk, after a restore. The conversations become **other ones**, and
     * the running processes belong to the previous ones: they are shut down, one by one and in an
     * orderly way, as `rc stop` promises. It is not a death, so they do not end up in `exited`.
     *
     * The event is `reload` and not `state`: whoever listens to `state` assumes there is a session
     * inside (`event.session.state`), and an event containing `null` would make it crash.
     */
    reload() {
      this.closeAll(); // stops the processes and clears the process ledger
      exited.clear();
      store.load();
      emit({ type: 'reload' });
      return store.all().length;
    },

    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}