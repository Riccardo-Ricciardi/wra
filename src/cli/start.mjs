#!/usr/bin/env node
// `wra start` — the server up, if it is not already, without keeping this window busy.
// It is what `wra attach` uses: there is no step before `wra attach`.
import { baseUrl } from './api.mjs';
import { ensureServer, logTail } from './daemon.mjs';

const { started, health, unauthorized } = await ensureServer();

if (unauthorized) {
  console.error('a server is running that does not recognise this token: did you rotate it?');
  console.error('stop it and start it again:  wra stop  →  wra start   (the old token stays valid as long as that process is alive)');
  process.exit(1);
}
if (!health) {
  console.error(`the server did not start on ${baseUrl()}.`);
  const tail = logTail(6);
  if (tail) console.error(`\nlast log lines:\n${tail}`);
  else console.error('no lines in the log: run it in the foreground with `wra serve` to see the error.');
  process.exit(1);
}

console.log(started
  ? `server started in the background: ${baseUrl()} (${health.sessions.length} chats)`
  : `server already running: ${baseUrl()} (${health.sessions.length} chats) — no second process`);
