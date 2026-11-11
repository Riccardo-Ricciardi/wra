#!/usr/bin/env node
// WRA — one command that dispatches subcommands. Each subcommand is its own module, so it can be
// tested alone and there is no file that knows everything.
import { existsSync, readFileSync } from 'node:fs';

/**
 * The version, from **one place only**: `package.json`. It is read here instead of being written
 * into a constant because a constant is one more thing to remember to change at release time, and
 * the time you forget it the number you read is wrong.
 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '?';
  } catch {
    return '?';
  }
})();

const COMMANDS = {
  start: 'start the server in the background, if it is not already running (one server, never two)',
  serve: 'run the server in the foreground: chat, terminals, MCP bridge',
  migrate: 'find the conversations that already exist on disk and bring them into the registry (without touching them)',
  backup: 'safety copy of the registry, and restore (backup | --list | --verify <folder> | restore <folder>)',
  attach: 'attach this window to a conversation (no arguments: the one for this folder, creating it if needed)',
  detach: 'detach the attached windows (Ctrl+Q does the same; this command works even if the terminal eats the key)',
  new: 'open a new conversation in this folder',
  permissions: 'the permission mode of a conversation (no arguments: show it; `wra permissions default` resets it)',
  sessions: 'list the conversations, with state and MCP authorisation',
  use: 'choose the conversation for this machine (CLI and local `talk`)',
  talk: 'send a turn to the chosen conversation and print the reply',
  status: 'server state: conversations, busy ones, MCP selections',
  doctor: 'diagnostics: server, token, claude, transcripts, MCP bridge',
  web: 'open the interface in the browser',
  access: 'how to reach the dashboard from outside: Tailscale or Cloudflare (prints the commands, does not run them)',
  autostart: 'WRA (and the tunnel) at session start, without windows (status | install | remove)',
  stop: 'stop the server (the conversations stay in the registry)',
  restart: 'stop and start again (applies settings and restores, which are read at startup)',
  admin: 'the address of the admin panel, and what it says right now',
};

const CONTINUE = new Set(['-c', '--continue', '--resume']);
const [raw, ...rawRest] = process.argv.slice(2);
// `wra -c` resumes the conversation of this folder, attached to this window: the short form of
// `wra attach`, and the counterpart of `cc -c`. It is normalised here so there is one dispatch.
const command = CONTINUE.has(raw) ? 'attach' : raw;

if (command === 'version' || command === '--version' || command === '-v') {
  console.log(`WRA ${VERSION}`);
  process.exit(0);
}

// `wra` with no arguments opens the workspace: starts the server if it is not there (one server,
// never two) and opens the browser. That is the normal gesture; `wra help` lists the rest.
if (!command) {
  process.argv = [process.argv[0], process.argv[1]];
  await import(new URL('./start.mjs', import.meta.url));
  // `web.mjs` opens the browser asynchronously: exiting here would kill it before it starts.
  await import(new URL('./web.mjs', import.meta.url));
}

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`WRA — Workspace Relay for Agents v${VERSION}\n\nusage: wra [command]\n\nno command: open the workspace\n`);
  for (const [name, what] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(11)} ${what}`);
  process.exit(0);
}

if (command && !Object.hasOwn(COMMANDS, command)) {
  console.error(`unknown command: ${command}`);
  process.exit(1);
}

// With no command everything is already done: the workspace is open.
if (command) {
  // The child module reads its arguments from process.argv: the command name is removed.
  process.argv = [process.argv[0], process.argv[1], ...rawRest];

  const moduleUrl = new URL(`./${command}.mjs`, import.meta.url);
  if (!existsSync(moduleUrl)) {
    console.error(`${command}: not implemented yet`);
    process.exit(1);
  }

  await import(moduleUrl);
}
