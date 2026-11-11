#!/usr/bin/env node
// `wra stop` — stops the server (and the terminals with it: the chats stay in the registry and are
// resumed with the same id).
//
// The normal path is asking the server to shut down, and it always works. The recovery path — the
// one needed when the token was rotated while the server was up — must kill a process **without
// being able to talk to it**, and there a pid is not enough: pids are reused, and killing "pid
// 1234" can mean killing someone else's program opened a minute ago. So identity is verified: pid
// **and** start time, compared with what the server had written about itself. If it cannot be
// verified, nothing is touched and it is said.
import { execFileSync } from 'node:child_process';
import { call } from './api.mjs';
import { clearServerFile, processStartedAt, readServerFile } from './daemon.mjs';

// How much difference to tolerate between the process start time and the one written in the file:
// the file is written when the port is already listening, so a moment after the process starts.
const TOLERANCE_MS = 15_000;

try {
  await call('/local/shutdown', { method: 'POST' });
  console.log('server stopped. The chats stay in the registry: resume with `wra -c` or `wra start`.');
} catch (error) {
  const known = readServerFile();
  if (!known) {
    console.error(error.message);
    process.exit(1);
  }

  const startedAt = processStartedAt(known.pid);
  const recorded = Date.parse(known.startedAt ?? '');
  // `startedAt` is already in ISO UTC, so it is compared with Date.parse. The tolerance covers
  // the delay between the process start and the writing of the file.
  const same = Boolean(startedAt) && Number.isFinite(recorded)
    && Math.abs(Date.parse(startedAt) - recorded) <= TOLERANCE_MS;

  if (!startedAt) {
    // It is not there (already gone), or it is there but cannot be queried. In both cases it is not
    // killed: the reference is kept, so a second attempt still finds it.
    console.error(error.message);
    console.error(`I cannot verify that process ${known.pid} is the WRA server: I am not stopping it.`);
    console.error(`if you are sure it is it: ${process.platform === 'win32' ? `taskkill /PID ${known.pid} /T /F` : `kill -TERM ${known.pid}`}`);
    console.error('The chats stay in the registry: resume with `wra start`.');
    process.exit(1);
  }

  if (!same) {
    // The pid exists, but it belongs to another process: the one we recorded is dead and its
    // number was reused. Killing it would be killing a stranger.
    console.error(error.message);
    console.error(`pid ${known.pid} now belongs to another process: started ${startedAt}, while the server had been started ${known.startedAt ?? '(unknown)'}.`);
    console.error('I am not touching it. The reference to the old server was left over: I am removing it.');
    clearServerFile();
    process.exit(1);
  }

  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(known.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(known.pid, 'SIGTERM');
    clearServerFile();
    console.error(`the running server (pid ${known.pid}, started ${known.startedAt}) no longer answered the token: stopped by force.`);
    console.error('The chats stay in the registry: resume with `wra start`.');
  } catch {
    clearServerFile();
    console.error(`${error.message}\n(the process ${known.pid} is gone: I cleaned up the reference)`);
    process.exit(1);
  }
}