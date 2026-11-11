#!/usr/bin/env node
// One-off, dry-run-first migration for conversations whose project folder is being retired.
//
//   node tools/migrate-project-path.mjs --ids <id,id> --from <old dir> --to <existing dir> --dry-run
//   node tools/migrate-project-path.mjs --ids <id,id> --from <old dir> --to <existing dir> --apply
//
// It never creates a session, never changes an id and never edits a transcript: it copies the
// `.jsonl` into the transcript folder of the target project (same file name, byte-identical) and
// changes only `projectPath` in the registry. Requires the server stopped: its in-memory registry
// would otherwise write the old path back.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { transcriptDirFor } from '../src/host/pty-host.mjs';
import { writeFileAtomic } from '../src/core/atomic.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const has = (name) => argv.includes(`--${name}`);
const apply = has('apply');
const ids = String(arg('ids', '')).split(',').map((s) => s.trim()).filter(Boolean);
const from = arg('from');
const to = arg('to');
const config = loadConfig(process.env);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (!ids.length || !from || !to) {
  console.error('usage: --ids <id,id> --from <old dir> --to <existing dir> [--apply]');
  process.exit(1);
}
if (!fs.existsSync(to) || !fs.statSync(to).isDirectory()) {
  console.error(`target is not an existing directory: ${to}`);
  process.exit(1);
}
if (path.resolve(from) === path.resolve(to)) {
  console.error('source and target are the same folder');
  process.exit(1);
}
if (apply) {
  const health = await fetch(`http://127.0.0.1:${config.port}/healthz`, {
    headers: { 'x-cc-remote-token': config.token }, signal: AbortSignal.timeout(1500),
  }).catch(() => null);
  if (health?.ok) {
    console.error('the server is running: `wra stop` first, or its registry would overwrite the change');
    process.exit(1);
  }
}

const registry = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
const list = Array.isArray(registry) ? registry : registry.sessions;
const changes = [];
for (const id of ids) {
  const entry = list.find((s) => s.sessionId === id);
  if (!entry) { console.error(`not in the registry: ${id}`); process.exit(1); }
  if (path.resolve(entry.projectPath) !== path.resolve(from)) {
    console.error(`${id}: projectPath is ${entry.projectPath}, not ${from}`);
    process.exit(1);
  }
  const oldFile = path.join(transcriptDirFor(entry.projectPath, config.projectsRoot), `${id}.jsonl`);
  const newFile = path.join(transcriptDirFor(to, config.projectsRoot), `${id}.jsonl`);
  if (!fs.existsSync(oldFile)) {
    console.error(`${id}: transcript missing in ${entry.projectPath}: ${oldFile}`);
    process.exit(1);
  }
  if (fs.existsSync(newFile) && sha(newFile) !== sha(oldFile)) {
    console.error(`${id}: the target transcript already exists with different content: ${newFile}`);
    process.exit(1);
  }
  changes.push({ entry, oldFile, newFile, copy: fs.existsSync(newFile) ? 'already identical' : 'copy' });
}

for (const { entry, oldFile, newFile, copy } of changes) {
  console.log(`${entry.sessionId}  ${entry.name}`);
  console.log(`  projectPath: ${entry.projectPath} -> ${to}`);
  console.log(`  transcript:  ${copy}${copy === 'copy' ? ` ${path.basename(newFile)}` : ''}`);
}
if (!apply) {
  console.log('\nDry run: nothing changed. Add --apply with the server stopped.');
  process.exit(0);
}

for (const { entry, oldFile, newFile } of changes) {
  if (!fs.existsSync(newFile)) {
    fs.mkdirSync(path.dirname(newFile), { recursive: true });
    fs.copyFileSync(oldFile, newFile);
  }
  entry.projectPath = to;
}
const text = `${JSON.stringify(Array.isArray(registry) ? list : { ...registry, sessions: list }, null, 2)}\n`;
writeFileAtomic(config.stateFile, text, {
  verify: (parsed) => {
    const rows = Array.isArray(parsed) ? parsed : parsed.sessions;
    if (!Array.isArray(rows) || rows.length !== list.length) throw new Error('registry shape changed');
  },
});
console.log(`\nMigrated ${changes.length} conversation(s). Original transcripts are untouched.`);
console.log('Start the server: wra start');
