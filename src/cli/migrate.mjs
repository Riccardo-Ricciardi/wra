#!/usr/bin/env node
// `wra migrate` — brings the conversations that already exist on disk into the new registry.
//
// There is nothing to convert: the old rig's conversations are **the same files** as Claude Code's,
// in `~/.claude/projects/<folder>/<id>.jsonl`. The old system only had a poorer registry (one
// conversation per folder, the "target"). Here it reads what is there and writes an entry in the
// new registry, with the real id, folder and name.
//
// Rules this command never breaks:
//   - it does not write, move or delete any transcript;
//   - it does not start any process (an imported conversation stays off until you use it);
//   - it does not touch the old claude-remote.
import path from 'node:path';
import { config } from '../config.mjs';
import { createRegistry, resolveProjectDir } from '../host/session-registry.mjs';
import { scanHistory, resumable } from '../core/history.mjs';
import { capienza } from '../core/reconcile.mjs';
import { isUp, ping } from './daemon.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : true);
};

const MB = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const when = (iso) => new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * The registry lives in memory inside the server: writing it from outside while the server is up
 * means being overwritten on the first change. Better to say so than to lose an entry.
 */
async function requireStopped() {
  const health = await ping({ timeoutMs: 1_500 });
  if (isUp(health)) {
    console.error('The server is running: changes to the registry would be lost.');
    console.error('Stop it and try again:  wra stop');
    process.exit(1);
  }
}

const history = () => scanHistory({ projectsRoot: config.projectsRoot })
  .filter((entry) => resolveProjectDir(entry.projectPath, { allowedRoots: config.allowedRoots, home: config.home }).ok);

function loadRegistry() {
  // No process to start here: the registry is only used as a file.
  return createRegistry({ config, spawn: () => ({ pid: null, write() {}, resize() {}, kill() {}, get exited() { return true; } }) });
}

const projectFilter = flag('--project');
const limit = Number(flag('--limit')) || 0;
const wanted = flag('--import');
const verify = args.includes('--verify');

const select = (list) => {
  let chosen = list;
  if (typeof projectFilter === 'string') {
    const target = path.resolve(projectFilter).toLowerCase();
    chosen = chosen.filter((entry) => path.resolve(entry.projectPath).toLowerCase() === target);
  }
  return limit > 0 ? chosen.slice(0, limit) : chosen;
};

if (verify) {
  await requireStopped();
  const registry = loadRegistry();
  const mine = registry.list().filter((session) => session.imported);
  if (!mine.length) {
    console.log('No imported conversations to verify.');
    process.exit(0);
  }
  let bad = 0;
  for (const session of mine) {
    const entry = { sessionId: session.sessionId, transcript: session.transcript, projectPath: session.projectPath };
    const check = resumable(entry, {
      resolve: (dir) => resolveProjectDir(dir, { allowedRoots: config.allowedRoots, home: config.home }),
    });
    console.log(`${check.ok ? ' ok ' : 'NO  '} ${session.sessionId.slice(0, 8)}  ${session.name}`);
    if (!check.ok) {
      console.log(`      ${check.reason}`);
      bad += 1;
    }
  }
  registry.closeAll();
  console.log(`\n${mine.length - bad}/${mine.length} resumable. No transcript was touched.`);
  process.exit(bad ? 1 : 0);
}

const all = history();

if (!wanted) {
  const registry = loadRegistry();
  const known = new Set(registry.list().map((session) => session.sessionId));
  registry.closeAll();
  const list = select(all);
  console.log(`Conversations found on disk: ${all.length} (of which ${list.length} in this selection)\n`);
  const byProject = new Map();
  for (const entry of list) {
    if (!byProject.has(entry.projectPath)) byProject.set(entry.projectPath, []);
    byProject.get(entry.projectPath).push(entry);
  }
  for (const [project, entries] of byProject) {
    console.log(`${project}  (${entries.length})`);
    for (const entry of entries) {
      const mark = known.has(entry.sessionId) ? 'already in the registry' : '   to import';
      console.log(`  ${mark}  ${entry.sessionId.slice(0, 8)}  ${when(entry.modifiedAt)}  ${MB(entry.sizeBytes).padStart(8)}  ${entry.title ?? '(untitled)'}`);
    }
    console.log('');
  }
  console.log('To import them:  wra migrate --import --project "<folder>"     (or --all)');
  console.log('The transcript is not touched, and no process starts.');
  process.exit(0);
}

await requireStopped();
const registry = loadRegistry();
const known = new Set(registry.list().map((session) => session.sessionId));
const candidates = select(all).filter((entry) => !known.has(entry.sessionId));

if (!candidates.length) {
  registry.closeAll();
  console.log('Nothing to import: they are all in the registry already.');
  process.exit(0);
}

// The registry cap is checked **now**, before writing the first entry. Without this check the
// import filled the registry up to `CR_MAX_SESSIONS` and then exited with an exception halfway:
// the entries written stayed, the summary did not, and the reason — "too many saved sessions" —
// did not say that the number had been decided by an environment variable.
const spazio = capienza({ inRegistro: known.size, daImportare: candidates.length, max: config.maxSessions });
if (!spazio.ok) {
  registry.closeAll();
  console.error(`The registry has ${known.size} conversations and the cap is ${config.maxSessions}: ${spazio.posti} fit, ${candidates.length} to import.`);
  console.error(`Raise the cap — CR_MAX_SESSIONS at least ${known.size + candidates.length} — or import ${spazio.posti} at a time with --limit.`);
  console.error('I have written nothing.');
  process.exit(1);
}

let imported = 0;
let skipped = 0;
for (const entry of candidates) {
  const check = resumable(entry, {
    resolve: (dir) => resolveProjectDir(dir, { allowedRoots: config.allowedRoots, home: config.home }),
  });
  if (!check.ok) {
    // No continuity is invented where there is none: the transcript stays where it is and the reason is stated.
    console.log(`skipped ${entry.sessionId.slice(0, 8)} — ${check.reason}`);
    skipped += 1;
    continue;
  }
  // An entry that does not fit must not take the others with it: say which one and move on. The
  // entries already written stay — they are real imports, and the summary at the end says how many.
  try {
    const created = registry.create({
      projectPath: entry.projectPath,
      name: entry.title,
      sessionId: entry.sessionId,
      imported: true,
      start: false,
    });
    console.log(`imported ${created.sessionId.slice(0, 8)}  "${created.name}"  ${created.projectPath}`);
    imported += 1;
  } catch (error) {
    console.log(`NOT imported ${entry.sessionId.slice(0, 8)} — ${error.message}`);
    skipped += 1;
  }
}
registry.closeAll();

console.log(`\n${imported} imported, ${skipped} skipped. No transcript was modified.`);
console.log(`Verify:  wra migrate --verify        Resume one:  wra -c  (in its folder)`);