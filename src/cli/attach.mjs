#!/usr/bin/env node
// `wra attach <id|name>` — attaches THIS window to a chat that lives in the server: it becomes
// another screen on the same conversation, live, like the browser. It is the `tmux attach` that
// does not exist on Windows, and what `wra` needs.
//
//   wra attach            the project chat of this folder (creates it if missing)
//   wra attach <id|name>  a specific chat
//   wra attach --new      a new chat in this folder, even if one already exists
//   wra attach --bypass   the chat it creates skips permissions (what the `cc` alias does)
//   wra attach --view     read-only (does not write and does not change width)
//   Ctrl+Q               to detach: the chat stays alive in the server
//
// Ctrl+Q is not the only way: Ctrl+] does the same, and `wra detach` (from another window)
// detaches this one without touching the conversation. A single way out is a single way to
// stay stuck inside.
//
// If the server is not there, it starts it: `wra attach` must be one command, not two.
import { createRequire } from 'node:module';
import { baseUrl, call, findSession, readSelection, token } from './api.mjs';
import { ensureServer } from './daemon.mjs';
import { detachAt, latestForProject } from '../core/attach-plan.mjs';
// The sequences that put the terminal back in order: the same ones the browser's Terminal tab
// uses, so the two views cannot diverge on what needs to be turned off.
import { TERMINAL_RESET } from '../web/ui/terminal-reset.mjs';

const require = createRequire(new URL('../../', import.meta.url));
const WebSocket = require('ws');

const args = process.argv.slice(2);
const viewOnly = args.includes('--view');
const wantNew = args.includes('--new');
// The permission mode is asked here, and applies only to the chat this window **creates**: one
// that already exists keeps its own (that is the rule of `wra -c`). Only the CLI asks for bypass,
// that is, a person in front of this machine: the site and remote clients never do.
const bypass = args.includes('--bypass');
const permissionMode = bypass ? 'bypassPermissions' : null;
const needle = args.filter((arg) => !arg.startsWith('--')).join(' ').trim();

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('wra attach must be run in a real terminal');
  process.exit(1);
}
if (!token()) {
  console.error('no token: start the server with `wra start` (it writes it to ~/.cc-remote/token)');
  process.exit(1);
}

const here = process.cwd();

// A single server: if there is one it is used, if there is not one is started (and only one, even
// if two `wra attach` start at the same moment).
const server = await ensureServer();
if (!server.health) {
  console.error(`the server does not answer at ${baseUrl()}`);
  process.exit(1);
}
if (server.started) console.error(`server started: ${baseUrl()}`);

const { sessions } = await call('/local/sessions');

const create = async (why) => {
  const created = await call('/local/sessions', { method: 'POST', body: { projectPath: here, permissionMode } });
  console.error(`${why}: ${created.session.sessionId.slice(0, 8)} in ${here}`);
  if (created.session.permissionMode === 'bypassPermissions') {
    console.error('permissions: bypass active in this conversation (to go back: wra permissions default)');
  }
  return created.session;
};

let target = null;
if (needle) {
  target = findSession(sessions, needle);
  if (!target) {
    console.error(`no chat matches "${needle}"`);
    process.exit(1);
  }
} else if (wantNew) {
  target = await create('new chat');
} else {
  // the chat of this folder: the one chosen by hand, or the most recent one from here, or a new one
  target = latestForProject(sessions, here, readSelection());
  if (!target) target = await create('nothing to resume here: new chat');
}

const url = baseUrl().replace('http://', 'ws://').replace('https://', 'wss://');
const ws = new WebSocket(`${url}/ws`, [`bearer.${token()}`]);

/**
 * The sequences that put a terminal back in order.
 *
 * They are written **always** on exit, and not because they are polite: the remote TUI turns on the
 * alternate screen, mouse, focus reporting and bracketed paste, and if it dies without turning them
 * off the viewer's terminal stays in that state. That is: the mouse key sequences go nowhere, the
 * cursor is invisible, and the shell looks stuck. There is no telling what it turned on, so
 * everything is turned off.
 */
let done = false;
let greeted = false; // the attachment is announced once, not on every server message
function leave(note) {
  if (done) return;
  done = true;
  try {
    process.stdin.setRawMode(false);
  } catch {
    // already closed
  }
  process.stdin.pause();
  // Exit **when the bytes have really left**. `process.exit()` discards what is still queued,
  // and on a pipe (not on a console) that queue exists: the reset would be lost and the terminal
  // would stay as it was, which is the defect this line exists to close.
  process.exitCode = 0;
  process.stdout.write(`${note ?? ''}${TERMINAL_RESET}`, () => process.exit(0));
  // Safety net for a blocked pipe: do not hang forever for a reset.
  setTimeout(() => process.exit(0), 1_000).unref();
}

// The last line of defence: whatever path the exit takes — an unhandled error, a signal,
// `process.exit()` called elsewhere — the terminal goes back to how it was. On a console the
// `write` is synchronous, so nothing is lost here.
process.on('exit', () => {
  try {
    process.stdout.write(TERMINAL_RESET);
  } catch {
    // nothing to do: we are exiting
  }
});

// Signal handlers are registered **before** any wait. Between startup and attachment there is a
// window where the console is not raw yet: there Ctrl+C arrives as a signal, and without a handler
// it would take Node's default path — it exits, but without saying why or what happens to the
// conversation.
process.on('SIGINT', () => leave('\r\n[WRA] detached: the chat stays alive in the server.\r\n'));
process.on('SIGTERM', () => leave('\r\n[WRA] detached: the chat stays alive in the server.\r\n'));

ws.on('open', () => {
  ws.send(JSON.stringify({
    t: 'hello',
    proto: 2,
    role: viewOnly ? 'viewer' : 'terminal',
    // "I am an attached window": it is the only thing `wra detach` can detach.
    attach: true,
    sessionId: target.sessionId,
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
  }));
});

ws.on('message', (raw) => {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (message.t === 'detach') {
    leave('\r\n[WRA] detached on request: the chat stays alive in the server.\r\n');
    return;
  }
  if (message.t === 'welcome' || message.t === 'opened') {
    if (message.replay) process.stdout.write(message.replay);
    if (message.session && message.session.sessionId !== target.sessionId) return;
    // The server sends `welcome` and then `opened`: it is the same attachment, and the line is said once.
    if (!greeted) {
      greeted = true;
      process.stdout.write(`\x1b[2m[${viewOnly ? 'read-only' : 'attached'}: ${target.name} · Ctrl+Q to detach (if the key does not arrive: wra detach)]\x1b[0m\r\n`);
    }
    return;
  }
  // The server sends the state of all conversations on every change. A session that ends
  // (`exited`) is an ending, not an absence: staying attached to a dead conversation means a mute
  // window that no longer answers anything — and it looks like a stuck shell, while it is only a
  // client attached to something that is no longer there.
  if (message.t === 'sessions') {
    const mine = (message.sessions ?? []).find((session) => session.sessionId === target.sessionId);
    if (mine?.state === 'exited') {
      leave('\r\n[WRA] the session has ended: the conversation stays in the registry (wra attach to resume it).\r\n');
    }
    return;
  }
  if (message.t === 'output' && message.sessionId === target.sessionId) {
    process.stdout.write(message.data);
    return;
  }
  if (message.t === 'error') {
    process.stderr.write(`\r\n[server] ${message.message}\r\n`);
  }
});

ws.on('close', () => leave('\r\n[WRA] connection closed: the chat stays alive in the server.\r\n'));
ws.on('error', (error) => leave(`\r\n[WRA] error: ${error.message}\r\n`));

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (buffer) => {
  // Only the detach byte counts: `input` is not "everything else", it is everything that does not detach.
  if (detachAt(buffer) !== -1) {
    leave('\r\n[WRA] detached: the chat stays alive in the server.\r\n');
    return;
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', data: buffer.toString('utf8') }));
});

process.stdout.on('resize', () => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'resize', cols: process.stdout.columns || 100, rows: process.stdout.rows || 30 }));
  }
});