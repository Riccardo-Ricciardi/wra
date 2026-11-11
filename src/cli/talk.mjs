#!/usr/bin/env node
// `wra talk "message" [--session <id|name>]` — sends a turn to the selected chat and prints the
// reply. It goes through the server coordinator: if the chat is busy the turn is queued, and
// with the same request id it is not run twice.
import { call, findSession, readSelection } from './api.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};
const requestId = flag('request-id');
const explicit = flag('session');
const message = args.filter((arg, index) => {
  if (arg === '--session' || arg === '--request-id') return false;
  return args[index - 1] !== '--session' && args[index - 1] !== '--request-id';
}).join(' ').trim();

if (!message) {
  console.error('usage: wra talk "message" [--session <id|name>] [--request-id <id>]');
  process.exit(1);
}

const { sessions } = await call('/local/sessions');
let target = null;
if (explicit) {
  target = findSession(sessions, explicit);
  if (!target) {
    console.error(`no chat matches "${explicit}"`);
    process.exit(1);
  }
} else {
  const selected = readSelection();
  target = selected ? sessions.find((session) => session.sessionId === selected) : null;
  if (!target) {
    console.error('no chat selected: `wra use <id|name>` (or --session)');
    for (const session of sessions) console.error(`  ${session.sessionId.slice(0, 8)}  ${session.name}`);
    process.exit(1);
  }
}

console.error(`→ ${target.name} (${target.sessionId.slice(0, 8)})`);
const { turn } = await call('/local/talk', {
  method: 'POST',
  body: { sessionId: target.sessionId, message, requestId },
});

if (turn.state === 'done') {
  console.log(turn.reply ?? '(no text)');
  process.exit(0);
}
if (turn.state === 'queued') {
  console.error(`queued (${turn.position} ahead) — request id ${turn.requestId ?? turn.turnId}`);
  process.exit(1);
}
console.error(`state: ${turn.state}${turn.partial ? `\npartial: ${turn.partial}` : ''}${turn.error ? `\nerror: ${turn.error}` : ''}`);
process.exit(1);
