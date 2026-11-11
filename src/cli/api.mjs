import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every CLI command talks to the server: the server owns the terminals, the CLI is a client
// like the browser. The token comes from CR_TOKEN or from ~/.cc-remote/token (where `wra serve` leaves it).

export function token() {
  if (process.env.CR_TOKEN) return process.env.CR_TOKEN;
  try {
    return fs.readFileSync(path.join(os.homedir(), '.cc-remote', 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export function baseUrl() {
  const host = process.env.CR_HOST || '127.0.0.1';
  const port = process.env.CR_PORT || 4310;
  return `http://${host}:${port}`;
}

export async function call(route, { method = 'GET', body = null } = {}) {
  const headers = { 'x-cc-remote-token': token() };
  if (body) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${baseUrl()}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (error) {
    throw new Error(`the server does not answer at ${baseUrl()} (start it with: wra start) — ${error.cause?.code ?? error.message}`);
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!response.ok) throw new Error(json?.error ?? `${response.status} on ${route}`);
  return json;
}

export function selectionFile() {
  return path.join(os.homedir(), '.cc-remote', 'local.json');
}

export function readSelection() {
  try {
    return JSON.parse(fs.readFileSync(selectionFile(), 'utf8'))?.sessionId ?? null;
  } catch {
    return null;
  }
}

export function writeSelection(sessionId) {
  const file = selectionFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ sessionId, at: new Date().toISOString() }, null, 2)}\n`);
  return sessionId;
}

/**
 * Finds a conversation: exact id, then **exact name**, then prefixes and parts.
 *
 * Order matters: `wra attach abc` with a chat named `abc` and another whose id starts with
 * `abc` must attach **the one named like that**. The id prefix used to win, and you ended up
 * in the wrong conversation — with the keys going there.
 *
 * `session.name ?? ''`: a record without a name (hand-written or old registry) must not make
 * the CLI die with a stack trace.
 */
export function findSession(sessions, needle) {
  const wanted = String(needle ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const named = (session) => String(session.name ?? '').toLowerCase();
  return sessions.find((session) => session.sessionId === needle)
    ?? sessions.find((session) => named(session) === wanted)
    ?? sessions.find((session) => String(session.sessionId ?? '').toLowerCase().startsWith(wanted))
    ?? sessions.find((session) => named(session).includes(wanted))
    ?? null;
}

export const STATE_LABEL = {
  ready: 'ready',
  starting: 'starting',
  busy: 'busy',
  offline: 'offline',
  exited: 'exited',
};
