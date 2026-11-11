import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ReplyAssembler,
  TailingReader,
  discoverCandidates,
  isToolResult,
  isTurnOpen,
  readRecentEntries,
  slugForProjectDir,
  userPromptText,
} from '../src/core/transcript.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-transcript-'));
}

const userEntry = (text, promptId = 'p1') => ({
  type: 'user',
  promptId,
  promptSource: 'typed',
  message: { role: 'user', content: text },
});

const toolResultEntry = (promptId = 'p1') => ({
  type: 'user',
  promptId,
  message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
});

const assistantEntry = (blocks, stopReason = 'tool_use') => ({
  type: 'assistant',
  message: { role: 'assistant', content: blocks, stop_reason: stopReason },
});

test('slugForProjectDir sostituisce ogni carattere non alfanumerico', () => {
  assert.equal(slugForProjectDir('C:\\Users\\example\\Desktop\\Projects'), 'C--Users-example-Desktop-Projects');
  assert.equal(slugForProjectDir('C:\\a\\b_c-d.e'), 'C--a-b-c-d-e');
});

test('discoverCandidates trova il jsonl piu recente e segnala ambiguita', () => {
  const root = tempDir();
  const dir = path.join(root, 'C--proj');
  fs.mkdirSync(dir, { recursive: true });
  const older = path.join(dir, 'old.jsonl');
  const newer = path.join(dir, 'new.jsonl');
  fs.writeFileSync(older, '{}\n');
  fs.writeFileSync(newer, '{}\n');
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(older, past, past);

  const found = discoverCandidates({ root, recentMs: 5 * 60 * 1000 });
  assert.equal(found.newest.path, newer);
  assert.equal(found.ambiguous.length, 0);

  const touched = discoverCandidates({ root, recentMs: 24 * 60 * 60 * 1000 });
  assert.equal(touched.ambiguous.length, 2);
  assert.equal(touched.newest.path, newer);
});

test('discoverCandidates ignora le directory omonime', () => {
  const root = tempDir();
  const dir = path.join(root, 'C--proj');
  fs.mkdirSync(path.join(dir, 'uuid.jsonl'), { recursive: true });
  const found = discoverCandidates({ root, recentMs: 1000 });
  assert.equal(found.newest, null);
});

test('TailingReader legge solo le righe nuove e ricompone le righe parziali', () => {
  const dir = tempDir();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(userEntry('primo'))}\n${JSON.stringify(assistantEntry([{ type: 'text', text: 'ciao' }], 'end_turn'))}\n`);

  const reader = new TailingReader(file);
  reader.sync();
  assert.deepEqual(reader.readNew(), []);

  fs.appendFileSync(file, `${JSON.stringify(userEntry('secondo', 'p2'))}\n`);
  const added = reader.readNew();
  assert.equal(added.length, 1);
  assert.equal(userPromptText(added[0]), 'secondo');
  assert.deepEqual(reader.readNew(), []);
});

test('TailingReader non corrompe un carattere multi-byte spezzato', async () => {
  const dir = tempDir();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, '');

  const reader = new TailingReader(file);
  reader.sync();

  const line = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'perché è così' }] } })}\n`;
  const bytes = Buffer.from(line, 'utf8');
  const cut = bytes.indexOf(Buffer.from('è', 'utf8')) + 1;

  fs.appendFileSync(file, bytes.subarray(0, cut));
  assert.deepEqual(reader.readNew(), [], 'nessuna riga completa ancora');

  fs.appendFileSync(file, bytes.subarray(cut));
  const entries = reader.readNew();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message.content[0].text, 'perché è così');
});

test('TailingReader azzera l offset se il file si accorcia', () => {
  const dir = tempDir();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(userEntry('lungo testo iniziale'))}\n`);
  const reader = new TailingReader(file);
  reader.sync();

  fs.writeFileSync(file, `${JSON.stringify(userEntry('corto'))}\n`);
  const entries = reader.readNew();
  assert.equal(entries.length, 1);
  assert.equal(userPromptText(entries[0]), 'corto');
});

test('userPromptText legge sia stringa sia array di blocchi', () => {
  assert.equal(userPromptText({ type: 'user', message: { content: 'ciao' } }), 'ciao');
  assert.equal(userPromptText({ type: 'user', message: { content: [{ type: 'text', text: 'ciao' }] } }), 'ciao');
  assert.equal(userPromptText(toolResultEntry()), null);
  assert.equal(userPromptText({ type: 'assistant' }), null);
});

test('isToolResult distingue i risultati dei tool dai prompt', () => {
  assert.equal(isToolResult(toolResultEntry()), true);
  assert.equal(isToolResult(userEntry('ciao')), false);
});

test('isTurnOpen riconosce un turno aperto', () => {
  assert.equal(isTurnOpen([userEntry('a'), assistantEntry([{ type: 'text', text: 'x' }], 'end_turn')]), false);
  assert.equal(isTurnOpen([userEntry('a'), assistantEntry([{ type: 'tool_use', name: 'Read' }], 'tool_use')]), true);
  assert.equal(
    isTurnOpen([userEntry('a'), toolResultEntry(), assistantEntry([{ type: 'tool_use', name: 'Read' }], 'tool_use')]),
    true,
  );
  assert.equal(isTurnOpen([assistantEntry([{ type: 'text', text: 'x' }], 'end_turn')]), false);
});

test('ReplyAssembler chiude il turno dopo la finestra di quiete', async () => {
  const assembler = new ReplyAssembler({ settleMs: 40 });
  assembler.add(assistantEntry([{ type: 'text', text: 'risposta' }], 'end_turn'));
  assert.equal(assembler.done, false);
  await sleep(60);
  assert.equal(assembler.done, true);
  assert.equal(assembler.text, 'risposta');
});

test('ReplyAssembler riarma la quiete sui due end_turn consecutivi', async () => {
  const assembler = new ReplyAssembler({ settleMs: 60 });
  assembler.add(assistantEntry([{ type: 'text', text: 'prima' }], 'end_turn'));
  await sleep(40);
  assembler.add(assistantEntry([{ type: 'text', text: 'seconda' }], 'end_turn'));
  assert.equal(assembler.done, false, 'il secondo end_turn deve riarmare la finestra');
  await sleep(80);
  assert.equal(assembler.done, true);
  assert.equal(assembler.text, 'prima\n\nseconda');
});

test('ReplyAssembler chiude il turno al prompt successivo', () => {
  const assembler = new ReplyAssembler({ settleMs: 5000 });
  assembler.add(assistantEntry([{ type: 'text', text: 'x' }], 'end_turn'));
  assembler.add(userEntry('nuovo prompt', 'p2'));
  assert.equal(assembler.done, true);
});

test('ReplyAssembler ignora thinking e raccoglie i nomi dei tool', () => {
  const assembler = new ReplyAssembler({ settleMs: 5000 });
  assembler.add(assistantEntry([
    { type: 'thinking', thinking: 'ragiono' },
    { type: 'tool_use', name: 'Read' },
    { type: 'tool_use', name: 'Grep' },
  ]));
  assembler.add(assistantEntry([{ type: 'text', text: 'fatto' }], 'end_turn'));
  assert.equal(assembler.text, 'fatto');
  assert.deepEqual(assembler.toolNames, ['Read', 'Grep']);
});

test('readRecentEntries salta la riga parziale iniziale e finale', () => {
  const dir = tempDir();
  const file = path.join(dir, 's.jsonl');
  const good = JSON.stringify(userEntry('integro'));
  const pad = 'P'.repeat(300);
  const content = `${pad}\n${good}\n${JSON.stringify(userEntry('tagliato')).slice(0, 20)}`;
  fs.writeFileSync(file, content);

  const entries = readRecentEntries(file, content.length - (pad.length - 20));
  assert.equal(entries.length, 1);
  assert.equal(userPromptText(entries[0]), 'integro');
});

test('readRecentEntries non scarta la prima riga se il confine cade sul newline', () => {
  const dir = tempDir();
  const file = path.join(dir, 's.jsonl');
  const first = JSON.stringify(userEntry('prima'));
  const second = JSON.stringify(userEntry('seconda', 'p2'));
  fs.writeFileSync(file, `${first}\n${second}\n`);

  const entries = readRecentEntries(file, second.length + 1);
  assert.equal(entries.length, 1);
  assert.equal(userPromptText(entries[0]), 'seconda');
});
