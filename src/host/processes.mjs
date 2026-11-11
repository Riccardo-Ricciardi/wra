// The `claude` processes, seen from outside: who is running right now on the machine, which of
// them is ours, and which one was left orphaned.
//
// The rule that makes this list **safe to look at** (and to close) is how a process of ours is
// recognized: not by the executable name — on this machine `claude` also runs for the interactive
// session of whoever uses the PC, for the old `claude-remote` rig and for the agent writing this
// file — but by the **`--session-id`/`--resume` we passed it**: an id that is in our registry. A
// process carrying the id of one of our conversations, and which the registry is not managing, is
// an orphan. Everything else is not our business and is not touched: a `taskkill` that fishes by
// name is exactly how someone else's work gets killed.
import { execFileSync } from 'node:child_process';

/** The ids passed to `claude` on the command line: `--session-id X` or `--resume X`. */
export function sessionIdOf(commandLine) {
  const match = /--(?:session-id|resume)[=\s]+("?)([0-9a-fA-F-]{8,})\1/.exec(String(commandLine ?? ''));
  return match ? match[2] : null;
}

/**
 * The processes that carry the id of one of **our** conversations on the command line.
 *
 * @param {Array<{pid: number, ppid?: number, startedAt?: string|null, commandLine?: string}>} rows
 * @param {Set<string>|Array<string>} known  the registry ids
 */
export function ours(rows, known) {
  const ids = known instanceof Set ? known : new Set(known);
  return rows
    .filter((row) => Number.isInteger(row?.pid) && row.pid > 0)
    .map((row) => ({ ...row, sessionId: sessionIdOf(row.commandLine) }))
    .filter((row) => row.sessionId && ids.has(row.sessionId));
}

/**
 * Who is managed, who is left, and what is not known.
 *
 * - **managed**: the server has a live process for that conversation, and it is this one;
 * - **leftover**: the server had started it and did not close it (forced shutdown), and it is
 *   still alive. It is the only case in which closing something makes sense, and the proof is the
 *   process ledger;
 * - **window**: carries the id of one of our conversations but was not started by the server — it
 *   is the `claude` of a `cc` or of an `rc attach` window. **It is not a leftover**: it is work in
 *   progress, and closing it would mean interrupting it;
 * - **gone**: was in the process ledger and is no longer there: just a line to remove.
 *
 * The distinction between "leftover" and "window" is the only thing that makes this list usable.
 * Without it, the `claude` of the conversation being used right now would show up as an orphan to
 * close: a button that interrupts your own work.
 */
export function classify({ processes = [], managed = [], leftovers = [], known = [] } = {}) {
  const mine = ours(processes, known);
  const managedPids = new Set(managed.map((entry) => entry.pid).filter(Boolean));
  const byPid = new Map(processes.map((row) => [row.pid, row]));

  const rows = [];
  for (const entry of managed) {
    const seen = byPid.get(entry.pid);
    rows.push({
      ...entry,
      kind: 'managed',
      startedAt: seen?.startedAt ?? null,
      line: seen?.commandLine ?? null,
      why: 'the server is using it right now',
    });
  }
  for (const row of mine) {
    if (managedPids.has(row.pid)) continue;
    if (leftovers.some((entry) => entry.pid === row.pid)) continue; // explained by the loop below
    rows.push({
      pid: row.pid,
      sessionId: row.sessionId,
      name: null,
      startedAt: row.startedAt ?? null,
      line: row.commandLine,
      kind: 'window',
      why: 'opened by another window (`cc`, `rc attach`), not by the server: it is work in progress',
    });
  }
  for (const entry of leftovers) {
    if (managedPids.has(entry.pid) || rows.some((row) => row.pid === entry.pid)) continue;
    const seen = byPid.get(entry.pid);
    rows.push({
      pid: entry.pid,
      sessionId: entry.sessionId,
      name: entry.name ?? null,
      startedAt: seen?.startedAt ?? entry.startedAt ?? null,
      line: seen?.commandLine ?? null,
      kind: seen ? 'leftover' : 'gone',
      why: seen
        ? 'started by the server and never closed: it remained after a forced shutdown'
        : 'it was in the process ledger but is no longer there',
    });
  }
  const inRows = new Set(rows.map((row) => row.pid));
  return {
    rows,
    managed: rows.filter((row) => row.kind === 'managed'),
    // Only these can be closed, and only after being recognized.
    orphans: rows.filter((row) => row.kind === 'leftover'),
    windows: rows.filter((row) => row.kind === 'window'),
    gone: rows.filter((row) => row.kind === 'gone'),
    // With an assigned conversation that is not ours: the old rig, another WRA instance, a test.
    // They are looked at and that is all.
    foreign: processes.filter((row) => !inRows.has(row.pid) && sessionIdOf(row.commandLine) !== null),
  };
}

/** True if the process with that pid is still there. `0` is the signal that sends nothing. */
export function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The system process list that **could** be ours. A wide scan (`claude` on the command line) and
 * then it is filtered: the part that decides is `classify`, which needs the registry ids.
 *
 * It costs one PowerShell process (~300 ms): it is called when someone looks, not on every refresh.
 */
export function listProcesses({ probes = {} } = {}) {
  const run = probes.run ?? ((command, args) => execFileSync(command, args, {
    encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }));
  const now = probes.now ?? (() => Date.now());
  try {
    if ((probes.platform ?? process.platform) === 'win32') {
      // The filter is deliberately narrow: `--session-id`/`--resume` is what `claude` receives
      // **only** when a conversation is assigned to it. With a wide filter ("claude" on the
      // command line) MCP servers, shell wrappers and the interactive session of whoever uses the
      // PC are pulled in: noise that then has to be told apart by hand, that is, one more chance
      // to make a mistake.
      const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "--session-id|--resume" } | '
        + 'Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress',
      ]);
      const parsed = JSON.parse(out || '[]');
      return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
        pid: Number(row.ProcessId),
        ppid: Number(row.ParentProcessId),
        // `CreationDate` arrives as `/Date(1762000000000)/` from this cmdlet: the number is read.
        startedAt: (() => {
          const at = /\/Date\((\d+)\)\//.exec(String(row.CreationDate ?? ''))?.[1];
          return at ? new Date(Number(at)).toISOString() : null;
        })(),
        commandLine: String(row.CommandLine ?? ''),
      }));
    }
    const out = run('ps', ['-eo', 'pid=,ppid=,etimes=,args=']);
    return out.split('\n').map((line) => {
      // see above: only processes that were assigned a conversation are kept
      if (!/--session-id|--resume/.test(line)) return null;
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        startedAt: new Date(now() - Number(match[3]) * 1000).toISOString(),
        commandLine: match[4],
      };
    }).filter((row) => row && row.commandLine.includes('claude'));
  } catch {
    // Without a process list diagnostics says "I don't know", which is different from "there is
    // nobody".
    return null;
  }
}

/**
 * Closes a process **after recognizing it**. The verification is not "the pid is alive" (a pid does
 * not identify a process: they are reused, and that is the norm) but "that pid is still working on
 * **this** conversation": the command line is re-read and the id compared.
 *
 * If it cannot be verified, **it is not closed**. It is the same rule as `rc stop`, and it matters
 * more here: there it is our server, here it is a `claude` that could be someone else's work.
 *
 * @param {object} input
 * @param {number} input.pid
 * @param {string} input.sessionId  the conversation that process must be working on
 * @param {(pid: number) => ({alive: boolean, sessionId: string|null})} input.verify
 * @returns {{ok: boolean, reason?: string}}
 */
export function killVerified({ pid, sessionId, verify, kill = null }) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'invalid pid' };
  if (typeof verify !== 'function') return { ok: false, reason: 'without a way to verify the process, I will not close it' };
  const seen = verify(id);
  if (!seen?.alive) return { ok: false, reason: `process ${id} is gone` };
  if (!seen.sessionId) {
    return { ok: false, reason: `process ${id} cannot be recognized (no readable --session-id): close it by hand if you are sure` };
  }
  if (sessionId && seen.sessionId !== sessionId) {
    return { ok: false, reason: `pid ${id} is now working on another conversation (${seen.sessionId.slice(0, 8)}): not touching it` };
  }
  try {
    if (kill) kill(id);
    else if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(id), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(id, 'SIGTERM');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/**
 * When the process with that pid was started (ISO UTC), or `null` if it cannot be known.
 *
 * It serves one purpose only, and an important one: **a pid does not identify a process**. Pids are
 * reused — that is normal, not a rare case — so "pid 23112" may be our server from this morning or
 * someone else's program opened a minute ago. The pair (pid, start time) does identify it: if the
 * time is not the one we wrote, that pid is not ours, and it is not touched.
 *
 * `null` means "I don't know" (the process is gone, or cannot be queried): the caller must treat it
 * as "do not touch", not as "go ahead".
 */
export function processStartedAt(pid, { run = null } = {}) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return null;
  const call = run ?? ((command, args) => execFileSync(command, args, {
    encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }));
  try {
    if (process.platform === 'win32') {
      const out = call('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${id} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')`]);
      const value = String(out).trim();
      return /^\d{4}-\d{2}-\d{2}T/.test(value) ? value : null;
    }
    // Unix: `etimes` is "how many seconds it has been alive", so there is no date to interpret (and
    // no language to guess).
    const seconds = Number(String(call('ps', ['-o', 'etimes=', '-p', String(id)])).trim());
    if (!Number.isFinite(seconds)) return null;
    return new Date(Date.now() - seconds * 1000).toISOString();
  } catch {
    return null;
  }
}