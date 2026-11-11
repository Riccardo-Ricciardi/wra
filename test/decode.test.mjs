import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selfCheck } from '../src/core/decode.mjs';

// La fixture ha la forma osservata in un transcript vero (Claude Code 2.1.312): un prompt
// utente, un tool_use, il tool_result e la risposta finale.
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'transcript-basic.jsonl');

test('selfCheck riconosce un transcript nella forma attuale', () => {
  const result = selfCheck(FIXTURE);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.prompts, 1, 'il tool_result non è un prompt utente');
  assert.equal(result.replies, 1, 'solo l\'assistente con text conta come risposta');
  assert.equal(result.turns, 1, 'un solo end_turn');
});

test('selfCheck dice cosa non va quando il formato cambia', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-decode-'));
  try {
    const file = path.join(dir, 'rotto.jsonl');
    fs.writeFileSync(file, '{"type":"user","message":{"role":"user","content":[]}}\n');
    const result = selfCheck(file);
    assert.equal(result.ok, false);
    assert.match(result.reason, /no user prompt/);

    const vuoto = path.join(dir, 'vuoto.jsonl');
    fs.writeFileSync(vuoto, '');
    assert.equal(selfCheck(vuoto).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});