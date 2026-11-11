#!/usr/bin/env node
// `wra doctor` — what is wrong, on one screen. Each line says one thing checked and its result.
//
// The real diagnosis lives in `src/host/diagnose.mjs`, because the panel uses it too: here it
// picks the context (CLI token, server up or not) and prints. Two implementations of the same
// question always diverge, and the one that would diverge is the one you read.
import { loadConfig } from '../config.mjs';
import { baseUrl, call, token } from './api.mjs';
import { diagnoseDeep, diagnoseFacts, liveProbes } from '../host/diagnose.mjs';

const config = loadConfig();

// The CLI token can come from the environment or the file: the diagnosis says whether it is
// there and how long it is, never what it is.
config.token = token() || config.token;

let health = null;
try {
  health = await call('/healthz');
} catch {
  health = null;
}

const probes = liveProbes();
const facts = diagnoseFacts({ config, health, probes });
const checks = [...facts.checks, ...diagnoseDeep({ config, probes })];

if (health) console.log(`server: ${baseUrl()}`);
for (const check of checks) {
  console.log(`${check.ok ? ' ok ' : 'NO  '} ${check.name.padEnd(26)} ${check.detail}`);
}

// Outside access, the tunnel binaries and the first backup are optional: a local-only installation
// is the documented default, and a fresh one has no backup yet. They must not make `wra doctor`
// fail. The lines still print, with the hint.
const OPTIONAL = new Set(['dashboard from outside', '`tailscale`', '`cloudflared`', 'backups']);
// In single-host the same hostname for dashboard and MCP is the declared configuration, not a
// fault: the per-path locks are the separation. The line still prints as a reminder.
if (config.singleHost) OPTIONAL.add('surface separation');
process.exit(checks.every((check) => check.ok || OPTIONAL.has(check.name)) ? 0 : 1);
