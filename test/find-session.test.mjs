import assert from 'node:assert/strict';
import test from 'node:test';
import { findSession } from '../src/cli/api.mjs';

// Come si sceglie **quale** conversazione agganciare, quando si scrive `rc attach <qualcosa>`.
// Sbagliarla non è un fastidio: vuol dire scrivere dentro un'altra conversazione, e non
// accorgersene.

const chat = (id, name) => ({ sessionId: id, name, projectPath: 'C:/x' });

test('il nome esatto vince sul prefisso di un id', () => {
  const sessions = [chat('c1f2a3b4-0000', 'chat 1'), chat('9a8b-1111', 'c')];
  assert.equal(findSession(sessions, 'c').name, 'c', '«c» è il nome di una chat, non l\'inizio di un id');

  const others = [chat('abcdef01-2222', 'qualcosaltro'), chat('9a8b-3333', 'abc')];
  assert.equal(findSession(others, 'abc').name, 'abc');
});

test('l\'id esatto vince su tutto', () => {
  const sessions = [chat('abcdef01-2222', 'qualcosaltro'), chat('9a8b-3333', 'abc')];
  assert.equal(findSession(sessions, 'abcdef01-2222').name, 'qualcosaltro');
});

test('poi i prefissi, poi le parti del nome', () => {
  const sessions = [chat('aa11-2222', 'rapporto mensile'), chat('bb33-4444', 'altra')];
  assert.equal(findSession(sessions, 'aa11').name, 'rapporto mensile');
  assert.equal(findSession(sessions, 'mensile').name, 'rapporto mensile');
  assert.equal(findSession(sessions, 'niente'), null);
  assert.equal(findSession(sessions, ''), null);
});

test('un record senza nome non fa cadere la CLI', () => {
  // Un registro scritto a mano, o vecchio: prima questo era uno stack trace invece di «non trovata».
  const odd = [{ sessionId: 'aa11-2222', projectPath: 'C:/x' }];
  assert.equal(findSession(odd, 'qualsiasi'), null);
  assert.equal(findSession(odd, 'aa11').sessionId, 'aa11-2222', 'l\'id però lo trova lo stesso');
});
