#!/usr/bin/env node
// `wra backup` — safety copy of the state, and restore.
//
// The logic lives in `src/host/backup-store.mjs`, because the panel uses it too: here the
// arguments are chosen and printed. What is saved and what is not is written there (transcripts are
// not touched, the token is not copied).
import path from 'node:path';
import { config } from '../config.mjs';
import { createBackupStore } from '../host/backup-store.mjs';
import { isUp, ping } from './daemon.mjs';

const args = process.argv.slice(2);
const store = createBackupStore({ config });

/** "1 conversation" and "3 conversations": the number next to the right word. */
const chats = (count) => (count === null || count === undefined ? '? conversations' : count === 1 ? '1 conversation' : `${count} conversations`);
const saved = (count) => (count === 1 ? '1 conversation saved' : `${count ?? '?'} conversations saved`);
const restored = (count) => (count === 1 ? '1 conversation' : `${count ?? '?'} conversations`);

async function requireStopped(action) {
  const health = await ping({ timeoutMs: 1_500 });
  if (isUp(health)) {
    console.error(`The server is running: ${action} now would be overwritten by the server, which has the previous registry in memory.`);
    console.error('Stop it and try again:  wra stop');
    process.exit(1);
  }
}

const restoreFrom = args[0] === 'restore' ? args[1] : null;

if (args.includes('--list')) {
  const rows = store.list();
  if (!rows.length) console.log('No backup: `wra backup` creates one.');
  for (const row of rows) {
    console.log(`${row.name}  ${row.readable ? chats(row.chats) : 'unreadable registry'}, ${row.files} files`);
  }
} else if (args.includes('--verify')) {
  const at = args.indexOf('--verify');
  const given = args[at + 1];
  const name = given && !given.startsWith('--') ? given : store.list()[0]?.name;
  if (!name) {
    console.error('No backup to verify.');
    process.exit(1);
  }
  const result = store.verify(name);
  if (result.missing) {
    console.error(`Not a WRA backup: missing ${path.join(result.folder, 'MANIFEST.json')}`);
    process.exit(1);
  }
  for (const entry of result.manifest.files) {
    console.log(`${result.bad.includes(entry.name) ? 'NO  ' : ' ok '} ${entry.name}  ${entry.sha256.slice(0, 12)}…`);
  }
  console.log(`\n${result.manifest.files.length - result.bad.length}/${result.manifest.files.length} files intact — backup from ${result.manifest.createdAt}, ${chats(result.manifest.chats)}.`);
  process.exit(result.ok ? 0 : 1);
} else if (restoreFrom) {
  await requireStopped('a restore');
  const plan = store.plan(restoreFrom);
  if (!plan.ok) {
    console.error(plan.reason);
    process.exit(1);
  }
  console.log(`From ${plan.counts.now} conversations to ${plan.counts.after}: ${plan.counts.added} come back, ${plan.counts.removed} leave.`);
  const result = store.restore(restoreFrom);
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  if (result.safety) console.log(`Current state set aside in ${result.safety}`);
  for (const name of result.moved ?? []) console.log(`Unreadable file set aside: ${name}`);
  for (const name of result.restored) console.log(`  restored ${name}`);
  if (result.failed?.length) console.log(`\nNot restored: ${result.failed.join(', ')}`);
  console.log(`\nRestored ${restored(result.chats)}. Restart:  wra start`);
} else {
  const { folder, manifest } = store.create({ quiet: false });
  console.log(`Backup in ${folder}`);
  console.log(`\n${saved(manifest.chats)}. Verify:  wra backup --verify`);
}
