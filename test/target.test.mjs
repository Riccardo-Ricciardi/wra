import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearTarget, readTarget, targetFile, writeTarget } from '../src/target.mjs';

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-target-'));
}

test('senza file si ricade su CR_PROJECT_DIR', () => {
  const dir = home();
  const target = readTarget({ projectDir: 'C:\\proj' }, dir);
  assert.equal(target.projectDir, 'C:\\proj');
  assert.equal(target.source, 'env');
});

test('senza file e senza CR_PROJECT_DIR si va in auto-discovery', () => {
  const target = readTarget({ projectDir: '' }, home());
  assert.equal(target.projectDir, '');
  assert.equal(target.source, 'auto');
});

test('il file del target vince su CR_PROJECT_DIR', () => {
  const dir = home();
  writeTarget({ projectDir: 'C:\\scelto', sessionId: 'abc' }, dir);
  const target = readTarget({ projectDir: 'C:\\altro' }, dir);
  assert.equal(target.projectDir, 'C:\\scelto');
  assert.equal(target.sessionId, 'abc');
  assert.equal(target.source, 'file');
});

test('un file illeggibile non rompe: si ricade sulla configurazione', () => {
  const dir = home();
  const file = targetFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ questo non e json');
  const target = readTarget({ projectDir: 'C:\\proj' }, dir);
  assert.equal(target.source, 'env');
});

test('off rimuove il target', () => {
  const dir = home();
  writeTarget({ projectDir: 'C:\\scelto' }, dir);
  assert.equal(clearTarget(dir), true);
  assert.equal(readTarget({ projectDir: '' }, dir).source, 'auto');
  assert.equal(clearTarget(dir), false, 'gia assente');
});
