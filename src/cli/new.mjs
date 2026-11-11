#!/usr/bin/env node
// `wra new [name]` — creates a chat in the folder you are in and opens it here, in an interactive
// terminal. Without a TTY it only creates it: a pipe cannot drive a chat.
import { call } from './api.mjs';
import { ensureServer } from './daemon.mjs';

const name = process.argv.slice(2).join(' ').trim() || null;
const server = await ensureServer();
if (!server.health) {
  console.error(server.unauthorized
    ? 'a server is running that does not recognise this token: did you rotate it?'
    : 'the server did not start: run `wra doctor` for the details');
  process.exit(1);
}
let created;
try {
  created = await call('/local/sessions', { method: 'POST', body: { projectPath: process.cwd(), name } });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const session = created.session;
console.log(`new chat: ${session.sessionId.slice(0, 8)} — ${session.name} (${session.projectPath})`);

if (process.stdin.isTTY && process.stdout.isTTY) {
  // Attach by id: `attach` would create another chat for the folder otherwise.
  process.argv = [process.argv[0], process.argv[1], session.sessionId];
  await import(new URL('./attach.mjs', import.meta.url));
} else {
  console.log(`to work on it here: wra attach ${session.sessionId.slice(0, 8)}`);
}
