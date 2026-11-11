#!/usr/bin/env node
// `wra access` — how to reach the dashboard from outside.
//
//   wra access                          what is there now, and what is missing
//   wra access tailscale <host>         Tailscale mode (the tailnet: no public domain)
//   wra access cloudflare <dashboard> [--mcp <host>]
//   wra access off [tailscale|cloudflare]
//   wra access check                    only the checks, for `wra doctor` or by hand
//
// **It touches nothing by itself.** It writes the choice into its own configuration file and
// prints the commands to run: `tailscale serve`, `cloudflared tunnel`, the Access rules. Those are
// commands that change how your machine is reachable from the internet, and something like that is
// not done on its own initiative — it is shown, and you run it. (The Cloudflare and Tailscale
// configuration already active on this machine is neither read nor modified.)
import { execFileSync } from 'node:child_process';
import { config } from '../config.mjs';
import { accessDefaults, checkHostname, planAccess, reviewAccess } from '../core/access.mjs';
import { createAccessStore } from '../host/access-store.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};
const words = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--mcp');
const action = words[0] ?? 'show';

const has = (command) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

const store = createAccessStore({ file: config.accessFile });
const saved = store.load();
const effective = { ...config, ...accessDefaults(saved) };

const showChecked = () => {
  const rows = reviewAccess({
    config: effective,
    tailscaleInstalled: has('tailscale'),
    cloudflaredInstalled: has('cloudflared'),
  });
  for (const row of rows) console.log(`  ${row.ok ? '✔' : '·'} ${row.what.padEnd(34)} ${row.detail}`);
  return rows;
};

const printCommands = (needs) => {
  if (!needs.length) return;
  console.log('\nwhat is needed, and what you have to run yourself:');
  for (const need of needs) {
    console.log(`\n  ${need.what}`);
    console.log(`    ${need.command}`);
    console.log(`    why: ${need.why}`);
  }
};

if (action === 'show' || action === 'check') {
  console.log('access from outside');
  showChecked();
  if (!saved.tailscale && !saved.cloudflare) {
    console.log('\nno mode enabled: only this machine can get in.');
    console.log('  wra access tailscale <tailnet-host>');
    console.log('  wra access cloudflare <dashboard-domain> [--mcp <mcp-domain>]');
  }
  if (action === 'show') {
    console.log(`\nchoice file: ${config.accessFile}`);
    console.log('environment variables always win over this file (CR_PUBLIC_ORIGIN, CR_MCP_HOST, …)');
  }
  process.exit(0);
}

if (action === 'off') {
  const which = words[1] ?? null;
  if (which && which !== 'tailscale' && which !== 'cloudflare') {
    console.error(`unknown mode: ${which}`);
    process.exit(1);
  }
  store.clear(which);
  console.log(which ? `${which}: off` : 'access from outside off');
  console.log('to apply it: wra stop; wra start (the server reads the choice at startup)');
  process.exit(0);
}

if (action === 'tailscale' || action === 'cloudflare') {
  const host = words[1] ?? '';
  if (!host) {
    console.error(`hostname required: wra access ${action} <hostname>`);
    process.exit(1);
  }
  const checked = checkHostname(host);
  if (!checked.ok) {
    console.error(`${checked.reason}`);
    process.exit(1);
  }

  const mcp = action === 'cloudflare' ? (flag('mcp') ?? saved.cloudflare?.mcp ?? '') : '';
  const plan = planAccess({
    mode: action,
    tailscaleHost: checked.host,
    dashboardHost: checked.host,
    mcpHost: mcp,
    port: config.port,
  });
  if (!plan.ok) {
    console.error(plan.reason);
    process.exit(1);
  }

  const record = action === 'tailscale'
    ? { host: checked.host, origin: `https://${checked.host}` }
    : { dashboard: checked.host, ...(mcp ? { mcp: mcp.toLowerCase() } : {}) };
  store.set(action, record);

  console.log(`${action}: access on ${checked.host}`);
  printCommands(plan.needs);

  const both = [store.get().tailscale, store.get().cloudflare].filter(Boolean).length > 1;
  console.log(`\nequivalent variables (if you prefer the environment to the file):`);
  for (const [key, value] of Object.entries(plan.env)) console.log(`  ${key}=${value}`);
  if (both) console.log('\nthe two modes are on together: both origins are allowed.');
  console.log('\nto apply it: wra stop; wra start');
  console.log('(the server does not restart by itself: open conversations are not interrupted)');
  process.exit(0);
}

console.error(`unknown command: wra access ${args.join(' ')}`);
console.error('  wra access | wra access tailscale <host> | wra access cloudflare <dashboard> [--mcp <host>] | wra access off [mode] | wra access check');
process.exit(1);
