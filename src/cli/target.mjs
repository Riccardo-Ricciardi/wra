#!/usr/bin/env node
// Chooses the session ChatGPT talks to: `wra target` (list + number),
// `wra target school-agent` (by name), `wra target off` (back to automatic).
import path from 'node:path';
import readline from 'node:readline/promises';
import { config } from '../config.mjs';
import { discoverCandidates, isTurnOpen, readRecentEntries } from '../core/transcript.mjs';
import { clearTarget, readTarget, targetFile, writeTarget } from '../target.mjs';

const args = process.argv.slice(2).filter(Boolean);

function sessions() {
  const { files } = discoverCandidates({
    root: config.projectsRoot,
    projectDir: '',
    recentMs: Number.POSITIVE_INFINITY,
  });

  const byProject = new Map();
  for (const file of files) {
    const entries = readRecentEntries(file.path);
    const last = entries.at(-1);
    const projectDir = last?.cwd;
    if (!projectDir) continue;
    // The target is the project: for each project, the most recent session counts.
    const previous = byProject.get(projectDir);
    if (previous && previous.mtimeMs >= file.mtimeMs) continue;
    byProject.set(projectDir, {
      projectDir,
      sessionId: last?.sessionId ?? path.basename(file.path, '.jsonl'),
      busy: isTurnOpen(entries),
      mtimeMs: file.mtimeMs,
    });
  }

  return [...byProject.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12);
}

const short = (dir) => {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || dir;
};

// The search is on the short name: "desktop" must not catch every project under it.
const matchesQuery = (entry, needle) =>
  short(entry.projectDir).toLowerCase().includes(needle) || entry.projectDir.toLowerCase().endsWith(needle);

const ago = (ms) => {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

const current = readTarget(config);
const listed = sessions();

if (args[0] === 'off') {
  clearTarget();
  console.log('target: off. Back to the most recent session, and the bridge refuses if there is more than one.');
  process.exit(0);
}

if (args[0] === 'show' || (args.length === 0 && !process.stdin.isTTY)) {
  console.log(`target: ${current.projectDir || '(automatic: the most recent session)'}  [${current.source}]`);
  console.log(`file:   ${targetFile()}`);
  process.exit(0);
}

if (listed.length === 0) {
  console.log('no Claude Code session found in ~/.claude/projects');
  process.exit(1);
}

function show() {
  console.log(`\n  #   project                               last activity   state       session`);
  listed.forEach((entry, index) => {
    const mark = entry.projectDir === current.projectDir ? '*' : ' ';
    const state = entry.busy ? 'busy' : 'free';
    console.log(
      `${mark} ${String(index + 1).padStart(2)}  ${short(entry.projectDir).padEnd(36)}  ${ago(entry.mtimeMs).padEnd(16)}  ${state.padEnd(10)}  ${entry.sessionId.slice(0, 8)}`,
    );
  });
  console.log(`\n  * = current target (${current.source})\n`);
}

function apply(entry) {
  const file = writeTarget({ projectDir: entry.projectDir, sessionId: entry.sessionId });
  console.log(`target: ${entry.projectDir}`);
  console.log(`        session ${entry.sessionId}${entry.busy ? ' (busy now: ChatGPT will be refused until it finishes)' : ''}`);
  console.log(`        written to ${file}`);
}

if (args.length > 0) {
  const needle = args.join(' ').toLowerCase();
  const matches = listed.filter((entry) => matchesQuery(entry, needle));
  if (matches.length === 0) {
    console.log(`no session containing "${needle}"`);
    show();
    process.exit(1);
  }
  if (matches.length > 1) {
    console.log(`"${needle}" matches ${matches.length} sessions: be more specific`);
    show();
    process.exit(1);
  }
  apply(matches[0]);
  process.exit(0);
}

show();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('number (enter to cancel): ')).trim();
rl.close();

if (!answer) {
  console.log('cancelled');
  process.exit(0);
}

const index = Number(answer);
if (!Number.isInteger(index) || index < 1 || index > listed.length) {
  console.log('invalid number');
  process.exit(1);
}

apply(listed[index - 1]);