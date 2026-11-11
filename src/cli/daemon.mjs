import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { baseUrl, token } from './api.mjs';

// Starting the server only once. Two servers on the same machine cannot see each other: each has
// its own registry and its own terminals, and the chat you think you opened is not the one you are
// looking at from the phone. So first it asks whether one is already there, and only if not does it start.

const serveScript = fileURLToPath(new URL('./serve.mjs', import.meta.url));

/**
 * The startup lock sits **next to the registry**, like `server.json`: if the registry is in a
 * place of its own (a test, a second rig), the lock is too. It used to be nailed to
 * `~/.cc-remote/serve.lock`, so every test that started a server touched the lock of whoever uses
 * the machine, and two different rigs contended for the same lock.
 */
const lockFile = () => path.join(
  path.dirname(process.env.CR_STATE_FILE || path.join(os.homedir(), '.cc-remote', 'sessions.json')),
  'serve.lock',
);

/** Is the process with that pid still alive? (`0` is the signal that sends nothing.) */
function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Does the server answer? If so, its state comes back; if not, `null`.
 *
 * `{ unauthorized: true }` is different from `null`: there is **something** listening that does not
 * recognise this token. It happens when the token is rotated while the server is still up, and it
 * must be said: without this distinction the message was "the server did not start", which sends
 * you looking for a fault that is not there.
 */
export async function ping({ timeoutMs = 1_500 } = {}) {
  try {
    const response = await fetch(`${baseUrl()}/healthz`, {
      headers: { 'x-cc-remote-token': token() },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401) return { unauthorized: true };
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export const isUp = (health) => Boolean(health && !health.unauthorized);

/**
 * Where the file describing the running server lives: **next to the registry**. If the registry is
 * in a place of its own — a test, a second rig, a throwaway folder — this is too.
 *
 * It is not a matter of taste: it used to be nailed to `~/.cc-remote/server.json`, so the test
 * suite, which starts real servers on ephemeral ports, wrote into the user's file. The pid it left
 * there was that of an already dead server — that is, on the first reuse of that number, someone
 * else's pid: `wra stop`, which reads there for the rotated-token case, could have stopped a
 * process that had nothing to do with it.
 */
const serverFile = () => path.join(
  path.dirname(process.env.CR_STATE_FILE || path.join(os.homedir(), '.cc-remote', 'sessions.json')),
  'server.json',
);

/**
 * The pid of the running server. It serves one case only, but a real one: if the token is rotated
 * while the server is up, that process no longer recognises anyone — and `wra stop`, which talks
 * with the token, can no longer stop it. Without this file the only way would be to find the pid by hand.
 */
export function writeServerFile(info) {
  try {
    fs.mkdirSync(path.dirname(serverFile()), { recursive: true });
    fs.writeFileSync(serverFile(), `${JSON.stringify({ ...info, startedAt: new Date().toISOString() }, null, 2)}\n`);
  } catch {
    // not essential: if it is not written, only the recovery path is lost
  }
}

export function clearServerFile() {
  try {
    fs.rmSync(serverFile(), { force: true });
  } catch {
    // already gone
  }
}

/**
 * The last lines of the log. The server starts detached, without a console: if it does not start,
 * the reason is only here — and without this you would only see "did not start".
 */
export function logTail(lines = 8) {
  const file = process.env.CR_LOG_FILE || path.join(os.tmpdir(), 'cc-remote.log');
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * When the process with that pid started (ISO UTC), or `null` if it cannot be known.
 *
 * It serves one thing only, and an important one: **a pid does not identify a process**. Pids are
 * reused — it is the norm, not a rare case — so "pid 23112" can be our server from this morning or
 * someone else's program opened a minute ago. The pair (pid, start time) does identify: if the time
 * is not the one we wrote, that pid is not our server, and it is not touched.
 *
 * `null` means "I do not know" (the process is not there, or cannot be queried): callers must treat
 * it as "do not touch", not as "go ahead".
 */
export function processStartedAt(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${id} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')`],
      { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const value = out.trim();
      return /^\d{4}-\d{2}-\d{2}T/.test(value) ? value : null;
    }
    // Unix: `etimes` is "how many seconds it has been alive", so there is no date to interpret (and
    // no language to guess).
    const seconds = Number(execFileSync('ps', ['-o', 'etimes=', '-p', String(id)], { encoding: 'utf8', timeout: 5_000, windowsHide: true }).trim());
    if (!Number.isFinite(seconds)) return null;
    return new Date(Date.now() - seconds * 1000).toISOString();
  } catch {
    return null;
  }
}

export function readServerFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(serverFile(), 'utf8'));
    return Number.isInteger(parsed?.pid) ? parsed : null;
  } catch {
    return null;
  }
}

async function waitFor(ms, stillAlive = () => true) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // A child that has already exited will never answer: waiting the same forty seconds only to
    // say "did not start" is the way to make a fault that is already known look slow.
    if (!stillAlive()) return null;
    const health = await ping({ timeoutMs: 1_000 });
    if (isUp(health)) return health;
    await sleep(250);
  }
  return null;
}

/** Takes the startup lock. `false` means someone else is working on it. */
function takeLock() {
  const file = lockFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    // The lock is there. It is thrown away **only** if its holder is no longer alive: it used to
    // look at age (30 seconds), but a waiter can legitimately hold it for up to 40 — so a live,
    // slow owner saw it taken away, and two servers started.
    try {
      const holder = Number(fs.readFileSync(file, 'utf8').trim());
      const age = Date.now() - fs.statSync(file).mtimeMs;
      // Alive and within the maximum wait time (with a margin): it is theirs, so wait.
      if (processAlive(holder) && age < 120_000) return false;
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The server is there, and if it is not it is started — in the background, without windows,
 * detached from this process: closing the terminal must not shut down the chats.
 */
export async function ensureServer({ waitMs = 40_000 } = {}) {
  const running = await ping();
  if (isUp(running)) return { started: false, health: running };
  // There is already a server, but with another token: starting a second one would be useless
  // (the port is taken) — that one must be stopped and started again with the new token.
  if (running?.unauthorized) return { started: false, health: null, unauthorized: true };

  if (!takeLock()) {
    // Another `wra` is starting it: wait for that one instead of adding a second server.
    const health = await waitFor(waitMs);
    return { started: false, health };
  }

  try {
    const child = spawn(process.execPath, [serveScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    const health = await waitFor(waitMs, () => child.exitCode === null);
    return { started: true, health, exitCode: child.exitCode ?? null };
  } finally {
    fs.rmSync(lockFile(), { force: true });
  }
}