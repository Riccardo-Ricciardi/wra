import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resumable, scanHistory } from '../src/core/history.mjs';

// Le conversazioni che esistono già su disco: si leggono, non si toccano.
// Qui si prova che vengano **identificate bene** — perché è da lì che dipende se una
// conversazione si può riprendere o no.

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-history-'));
  const projects = path.join(root, 'projects');
  const cwd = path.join(root, 'progetto');
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return { root, projects, cwd, dir };
}

const line = (object) => `${JSON.stringify(object)}\n`;

function writeTranscript(dir, sessionId, { cwd, title = null, prompt = 'una domanda' }) {
  const file = path.join(dir, `${sessionId}.jsonl`);
  let text = line({ type: 'system', subtype: 'init', cwd, sessionId, version: '2.1.314' });
  text += line({ type: 'user', cwd, sessionId, message: { role: 'user', content: prompt } });
  text += line({ type: 'assistant', cwd, sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'una risposta' }] } });
  if (title) text += line({ type: 'ai-title', cwd, sessionId, aiTitle: title });
  fs.writeFileSync(file, text);
  return file;
}

test('trova le conversazioni e ne legge progetto, id e titolo veri', () => {
  const { root, projects, cwd, dir } = fixture();
  try {
    const id = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';
    writeTranscript(dir, id, { cwd, title: 'Sistemare il rollback' });

    const found = scanHistory({ projectsRoot: projects });
    assert.equal(found.length, 1);
    assert.equal(found[0].sessionId, id);
    assert.equal(found[0].projectPath, cwd, 'il progetto è il cwd scritto nel transcript, non lo slug');
    assert.equal(found[0].title, 'Sistemare il rollback');
    assert.equal(found[0].titleFrom, 'title');
    assert.ok(found[0].sizeBytes > 0);
    assert.ok(found[0].modifiedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('senza titolo si usa il primo messaggio, che è comunque roba scritta da una persona', () => {
  const { root, projects, cwd, dir } = fixture();
  try {
    writeTranscript(dir, 'aaaabbbb-cccc-4ddd-8eee-ffff00002222', { cwd, prompt: 'Come sistemo il deploy?' });
    const [entry] = scanHistory({ projectsRoot: projects });
    assert.equal(entry.title, 'Come sistemo il deploy?');
    assert.equal(entry.titleFrom, 'prompt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un file appena creato non è una conversazione', () => {
  const { root, projects, dir } = fixture();
  try {
    fs.writeFileSync(path.join(dir, 'aaaabbbb-cccc-4ddd-8eee-ffff00003333.jsonl'), '{}\n');
    assert.deepEqual(scanHistory({ projectsRoot: projects }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una cartella che non esiste non fa esplodere niente', () => {
  assert.deepEqual(scanHistory({ projectsRoot: path.join(os.tmpdir(), 'non-esiste-cc-remote') }), []);
});

test('riprendibile: serve il transcript, e deve contenere il suo id', () => {
  const { root, projects, cwd, dir } = fixture();
  try {
    const id = 'aaaabbbb-cccc-4ddd-8eee-ffff00004444';
    const file = writeTranscript(dir, id, { cwd });
    const entry = { sessionId: id, transcript: file, projectPath: cwd };

    assert.equal(resumable(entry).ok, true);
    assert.equal(resumable({ ...entry, transcript: path.join(dir, 'non-c-e.jsonl') }).ok, false);

    // un transcript il cui id non c'è dentro: `claude --resume` non lo troverebbe
    const other = path.join(dir, 'aaaabbbb-cccc-4ddd-8eee-ffff00005555.jsonl');
    fs.writeFileSync(other, line({ type: 'system', cwd, sessionId: 'un-altro-id' }));
    const check = resumable({ sessionId: 'aaaabbbb-cccc-4ddd-8eee-ffff00005555', transcript: other, projectPath: cwd });
    assert.equal(check.ok, false);
    assert.match(check.reason, /does not contain its id/);

    // e una cartella fuori dalle radici consentite non si riprende
    const outside = resumable(entry, { resolve: () => ({ ok: false, reason: 'cartella fuori dalle radici consentite' }) });
    assert.equal(outside.ok, false);
    assert.match(outside.reason, /radici consentite/);
    assert.ok(projects);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
