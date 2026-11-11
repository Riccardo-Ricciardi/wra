#!/usr/bin/env node
// `wra admin` — where the panel is, and what it says right now.
//
// For people working from the terminal: the same things as the panel, on one screen, to decide
// whether it is worth opening. If the server is down it says so instead of failing.
import { baseUrl, call } from './api.mjs';

let stato;
try {
  stato = await call('/local/admin/status');
} catch (error) {
  console.error(`the server does not answer (${error.message}). Start it:  wra start`);
  process.exit(1);
}

const { status, setup, checks } = stato;
const fatti = checks.filter((check) => !check.ok);

console.log(`panel:  ${baseUrl()}/#impostazioni`);
console.log(`WRA ${status.version} · node ${status.node} · ${status.platform} · up for ${Math.round(status.uptimeS / 60)} min`);
console.log('');
console.log(`conversations  ${status.sessions.total} (${status.sessions.archived} archived, ${status.sessions.imported} imported)`);
console.log(`processes      ${status.processes.length} up: ${status.processes.map((row) => `${row.name} (${row.pid})`).join(', ') || 'none'}`);
console.log(`projects       ${status.projects}`);
console.log(`MCP bridge     ${status.mcp.enabled ? `up${status.mcp.host ? ` at ${status.mcp.host}` : ''}` : 'down'}`);
console.log(`connections    ${status.connections?.clients ?? 0} windows`);
console.log('');
console.log('first start');
for (const step of setup.steps) console.log(`  ${step.ok ? ' ok ' : 'NO  '} ${step.what.padEnd(34)} ${step.detail}`);
if (fatti.length) {
  console.log('');
  console.log('to look at');
  for (const check of fatti) console.log(`  NO  ${check.name.padEnd(26)} ${check.detail}`);
}
console.log('');
console.log('from the panel: backups, restore, access from outside, processes, restart.');
process.exit(fatti.length ? 1 : 0);
