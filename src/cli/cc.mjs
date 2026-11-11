#!/usr/bin/env node
// `cc` — the short form kept for backward compatibility. It opens a NEW conversation in this
// folder, attached to this window, with permissions bypassed (you are sitting at this machine).
//
//   cc        a new conversation in this folder
//   cc -c     the most recent conversation of this folder (creates one if there is none)
//   Ctrl+Q    detach (Ctrl+C goes to the agent: it does not detach)
//
// It is `wra attach --new --bypass`, and `wra attach` for `-c`.
const rest = process.argv.slice(2);
const first = rest[0];
const args = ['-c', '--continue', '--resume'].includes(first)
  ? rest.slice(1)
  : ['--new', '--bypass', ...(first === '-n' || first === '--new' ? rest.slice(1) : rest)];
process.argv = [process.argv[0], process.argv[1], ...args];
await import(new URL('./attach.mjs', import.meta.url));
