#!/usr/bin/env node
// `wra restart` — stops and starts again, in a single command.
//
// It exists because a restart is needed at two moments that used to require two commands (and
// remembering the order): after a restore, and after changing a setting — which is read at startup.
// The panel calls it itself (`/local/admin/restart`), launching it **detached**: this process
// survives the one it is stopping, otherwise it would not start anything again.
import { baseUrl, token } from './api.mjs';
import { ensureServer, isUp, ping } from './daemon.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isUpNow = async () => isUp(await ping({ timeoutMs: 1_000 }));

if (isUp(await ping())) {
  // The server is asked to shut down **in an orderly way** (it closes the PTYs, removes its own
  // reference and exits with 0): it is not sent a signal, which on Windows is `TerminateProcess`
  // — that is, no cleanup, and that is why `wra stop` talks instead of killing.
  try {
    await fetch(`${baseUrl()}/local/shutdown`, { method: 'POST', headers: { 'x-cc-remote-token': token() } });
  } catch {
    // the request can fail because the server is already down: wait and move on
  }
}

// Wait for the port to be released: starting again while the old one is still listening
// would mean losing the race and starting nothing.
const deadline = Date.now() + 25_000;
while (Date.now() < deadline && await isUpNow()) await sleep(250);

const result = await ensureServer({ waitMs: 40_000 });
if (isUp(result.health)) {
  console.log(`WRA restarted on ${baseUrl()}`);
  process.exit(0);
}
console.error('the server did not restart: check the log, then try again with `wra start`');
process.exit(1);
