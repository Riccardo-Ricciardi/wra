#!/usr/bin/env node
// `wra permissions [mode] [--session <id|name>]` — the permission mode of a chat.
//
//   wra permissions                    shows it (of the selected chat, or of this folder)
//   wra permissions default            goes back to the normal mode
//   wra permissions bypassPermissions  skips permissions (local chats only)
//
// The mode belongs to the conversation, not the server: it survives resume (`wra -c`) and does
// not touch the other chats. Changing it restarts the live process (with `--resume`, same id): the
// mode is only read when `claude` starts.
import path from 'node:path';
import { call, findSession, readSelection } from './api.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};
const explicit = flag('session');
const mode = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--session').join(' ').trim();

const { sessions } = await call('/local/sessions');

let target = null;
if (explicit) {
  target = findSession(sessions, explicit);
  if (!target) {
    console.error(`no chat matches "${explicit}"`);
    process.exit(1);
  }
} else {
  const here = process.cwd();
  const selected = readSelection();
  target = sessions.find((session) => session.sessionId === selected && path.resolve(session.projectPath) === path.resolve(here))
    ?? sessions.filter((session) => path.resolve(session.projectPath) === path.resolve(here)).at(-1)
    ?? null;
  if (!target) {
    console.error('no chat here: open one with `wra attach`, or pass --session <id|name>');
    process.exit(1);
  }
}

// No arguments: just show it.
if (!mode) {
  console.log(`${target.name} (${target.sessionId.slice(0, 8)}): ${target.permissionMode}`);
  console.log('to change it: wra permissions <mode> [--session <id|name>]');
  process.exit(0);
}

const { session } = await call(`/local/sessions/${target.sessionId}/permissions`, {
  method: 'POST',
  body: { mode },
});
console.log(`${session.name}: ${session.permissionMode}`);
if (session.permissionMode === 'bypassPermissions') {
  console.log('permissions are bypassed in this conversation: every agent action goes through without asking');
}
