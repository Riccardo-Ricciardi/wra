#!/usr/bin/env node
// `wra serve` — the process that owns the chat terminals.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { accessDefaults, parseOrigins } from '../core/access.mjs';
import { createAccessStore } from '../host/access-store.mjs';
import { applySettings, createSettingsStore } from '../host/settings-store.mjs';
import { createRegistry } from '../host/session-registry.mjs';
import { createServer } from '../net/server.mjs';
import { baseUrl } from './api.mjs';
import { clearServerFile, isUp, ping, writeServerFile } from './daemon.mjs';
import * as log from '../log.mjs';

const MIN_TOKEN = 16;

/**
 * The access-from-outside choice, saved to disk, fills **only the holes** the environment has not
 * already filled: an environment variable always wins, so it can still be forced for a test or an
 * occasional start. This is what makes the choice survive a restart without writing it to a profile.
 */
function applySavedAccess(target) {
  const store = createAccessStore({ file: target.accessFile });
  const saved = store.load();
  const defaults = accessDefaults(saved);
  for (const [key, value] of Object.entries(defaults)) {
    if (value && !target[key]) target[key] = value;
  }
  // Origins are recalculated after filling: there can be two, and the list is what the websocket
  // uses to decide whether a connection from outside is yours.
  target.publicOrigins = parseOrigins(target.publicOrigin);
  return saved;
}

const savedAccess = applySavedAccess(config);

/**
 * And the settings chosen from the panel, with the same rule: they fill only the holes the
 * environment has not already filled. `allowedRoots` is **added** to the starting one.
 */
const settings = createSettingsStore({ file: config.settingsFile });
const appliedSettings = applySettings(config, settings.load());

// Single-user: there is one token and that is it. If none was given, one is generated (192 bits)
// and kept in `~/.cc-remote/token`. A hand-picked token that is too short is refused: it is the
// only lock, and on a tunnel someone will try to guess it.
function ensureToken() {
  if (config.token) {
    if (config.token.length < MIN_TOKEN) {
      console.error(`CR_TOKEN is too short (${config.token.length} chars): at least ${MIN_TOKEN} required`);
      process.exit(1);
    }
    return config.token;
  }
  const file = path.join(config.home, '.cc-remote', 'token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= MIN_TOKEN) return existing;
  } catch {
    // first time: generate it
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

const tokenFromEnv = Boolean(config.token);
config.token = ensureToken();

// Two servers on the same port cannot coexist, but two on different ports can — and they would be
// two separate worlds with two registries: the chat you open here is not the one you see from the
// phone. If one is already running, this one does not start. (`wra start` starts one only if there is none.)
const running = await ping();
if (isUp(running)) {
  console.log(`a server is already running at ${baseUrl()} (${running.sessions.length} chats): I will not start a second one`);
  console.log('to stop it: wra stop');
  process.exit(0);
}
if (running?.unauthorized) {
  console.log(`there is already a server at ${baseUrl()}, but it answers with another token (rotated recently?).`);
  console.log('stop it and start it again: wra stop → wra start');
  process.exit(0);
}

// From here on the registry can refuse to load — and that is intended: if the chat file is
// unreadable and there is no good backup, the server does not start instead of wiping the
// conversations. But a refusal must *say so*: this process is launched detached, without a
// console, so it writes to the log and exits with an error code.
let registry;
let server;
let web;
let coordinator;
// The orderly shutdown is defined later (it needs `server` and `web`), and the shutdown route
// calls it through this reference.
let shutdown = () => process.exit(0);
try {
  registry = createRegistry({ config });
  ({ server, web, coordinator } = createServer({ config, registry, onShutdown: () => shutdown() }));
} catch (error) {
  log.error('startup refused: the session registry does not load', { error: error.message, stateFile: config.stateFile });
  console.error(`the server did not start: ${error.message}`);
  console.error(`registry: ${config.stateFile} — also check the .bak backup and the .corrupt-* files`);
  console.error(`log: ${config.logFile}`);
  process.exit(1);
}

// If two start at the same instant, the earlier check is not enough: the port has the last word,
// and whoever loses it must say so in one line instead of dying with a stack trace.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`port ${config.port} is already in use: another server is running. I will not start a second one.`);
    process.exit(0);
  }
  // `EACCES` on a port is not "in use": on Windows there are ranges the system reserves (Hyper-V,
  // WSL, updates) that cannot be opened even if they are free. Said as it is, it sounds like a
  // program permission problem; said this way, it is fixed in a second by changing port.
  if (error.code === 'EACCES') {
    console.error(`port ${config.port} cannot be opened (permission denied): on Windows some ranges are reserved by the system.`);
    console.error('see which: netsh int ipv4 show excludedportrange protocol=tcp — then choose one outside those (CR_PORT=4311).');
    log.error('startup refused: port cannot be opened', { port: config.port, code: error.code });
    process.exit(1);
  }
  throw error;
});

server.listen(config.port, config.host, () => {
  const { port } = server.address();
  // The approval relay is a round trip: the hook inside `claude` calls this server. With
  // `CR_PORT=0` the real port is only known now, and the sessions start afterwards.
  config.port = port;
  writeServerFile({ pid: process.pid, host: config.host, port });
  // This line is also the "ready" signal for the tests.
  console.log(`WRA on http://${config.host}:${port}`);
  console.log(tokenFromEnv
    ? 'token: from CR_TOKEN (environment variable)'
    : `token: in ${path.join(config.home, '.cc-remote', 'token')}`);
  // The saved access mode is stated at startup: it is the first thing to know when starting from
  // outside, and it is not a secret (they are hostnames, not tokens).
  if (savedAccess?.tailscale || savedAccess?.cloudflare) {
    const modes = [savedAccess.tailscale && 'tailscale', savedAccess.cloudflare && 'cloudflare'].filter(Boolean);
    console.log(`access from outside: ${modes.join(' + ')}${config.publicOrigins.length ? ` · allowed origins: ${config.publicOrigins.join(' ')}` : ''}`);
    if (config.dashboardHost) console.log(`dashboard on ${config.dashboardHost}: the routes of the machine there do not exist`);
  }
  console.log(`chats: ${registry.list().length} · default folder: ${config.defaultProject}`);
  if (appliedSettings.length) console.log(`settings from the panel: ${appliedSettings.join(', ')}`);
});

shutdown = () => {
  clearServerFile();
  registry.closeAll();
  web.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// the coordinator has no resources to close: turns live inside the PTYs, which we close above
void coordinator;