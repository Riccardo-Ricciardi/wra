import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createRegistry } from '../src/host/session-registry.mjs';
import { runTurn } from '../src/core/turns.mjs';
import { selfCheck } from '../src/core/decode.mjs';

// Il giro che conta: il motore dei turni manda un prompt al PTY (framing compreso), il
// transcript viene scritto **con l'id che abbiamo scelto noi**, e la risposta si legge da li'.
// Con la TUI finta, che rispetta `--session-id` come farebbe claude.

const FAKE = path.join(import.meta.dirname, '..', 'tools', 'fake-claude.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-turn-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  const config = {
    ...loadConfig({}),
    projectsRoot: path.join(root, 'projects'),
    stateFile: path.join(root, 'sessions.json'),
    allowedRoots: [root],
    claudeCmd: process.execPath,
    claudeArgs: [FAKE],
    defaultProject: project,
    permissionMode: 'default',
    promptMatchMs: 20_000,
    pollMs: 150,
    settleMs: 600,
    turnMaxMs: 30_000,
  };
  process.env.CR_PROJECTS_ROOT = config.projectsRoot;
  return { root, project, config, registry: createRegistry({ config }) };
}

test('un turno: prompt iniettato, transcript col nostro id, risposta letta', { timeout: 60_000 }, async () => {
  const { root, project, config, registry } = setup();
  try {
    const session = registry.create({ projectPath: project, name: 'prova' });
    await sleep(1_500);

    const sink = registry.sinkFor(session.sessionId);
    assert.equal(sink.transcriptPath, path.join(config.projectsRoot, project.replace(/[^A-Za-z0-9]/g, '-'), `${session.sessionId}.jsonl`));
    assert.equal(path.basename(sink.transcriptPath, '.jsonl'), session.sessionId, 'il transcript porta il nostro id');

    const result = await runTurn({
      pty: sink,
      message: 'ciao dal motore dei turni',
      transcriptPath: sink.transcriptPath,
      projectsRoot: config.projectsRoot,
      projectDir: project,
      promptMatchMs: config.promptMatchMs,
      pollMs: config.pollMs,
      settleMs: config.settleMs,
      maxWaitMs: config.turnMaxMs,
    });

    assert.equal(result.status, 'done', JSON.stringify(result));
    assert.match(result.reply, /RICEVUTO ciao dal motore dei turni/);
    assert.equal(result.transcript, sink.transcriptPath, 'letto dal transcript giusto');
    assert.equal(selfCheck(result.transcript).ok, true);
    assert.equal(fs.readFileSync(result.transcript, 'utf8').includes(session.sessionId), true, 'il transcript porta il nostro id');
  } finally {
    registry.closeAll();
    await sleep(300);
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // il PTY puo' tenere la cartella: e' pulizia, non un test
    }
  }
});

test('due chat dello stesso progetto non si vedono i turni a vicenda', { timeout: 60_000 }, async () => {
  const { root, project, config, registry } = setup();
  try {
    const a = registry.create({ projectPath: project, name: 'A' });
    const b = registry.create({ projectPath: project, name: 'B' });
    await sleep(1_800);

    const run = (session, message) => runTurn({
      pty: registry.sinkFor(session.sessionId),
      message,
      transcriptPath: registry.sinkFor(session.sessionId).transcriptPath,
      projectsRoot: config.projectsRoot,
      projectDir: project,
      promptMatchMs: config.promptMatchMs,
      pollMs: config.pollMs,
      settleMs: config.settleMs,
      maxWaitMs: config.turnMaxMs,
    });

    const [first, second] = await Promise.all([run(a, 'per A'), run(b, 'per B')]);
    assert.equal(first.status, 'done', JSON.stringify(first));
    assert.equal(second.status, 'done', JSON.stringify(second));
    assert.match(first.reply, /per A/);
    assert.match(second.reply, /per B/);
    assert.notEqual(first.transcript, second.transcript, 'transcript diversi per chat diverse');
  } finally {
    registry.closeAll();
    await sleep(300);
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // idem
    }
  }
});
