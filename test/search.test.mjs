import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { searchConversations } from '../src/core/search.mjs';

// La ricerca dentro i messaggi: deve trovare quello che si ricorda di aver detto, e non deve
// costare niente quando non serve. I tetti (tempo, byte, risultati) sono parte del contratto:
// una ricerca che sembra completa e non lo è è peggio di una che lo dice.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-search-'));

function transcript(name, lines) {
  const file = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return { sessionId: name, name, transcript: file };
}

const user = (text) => ({ type: 'user', sessionId: 'x', timestamp: '2026-10-01T10:00:00.000Z', message: { content: text } });
const assistant = (text) => ({ type: 'assistant', sessionId: 'x', timestamp: '2026-10-01T10:05:00.000Z', message: { content: [{ type: 'text', text }] } });
// Una riga che non è conversazione: porta lo stesso testo, ma non è qualcosa che qualcuno ha
// scritto — e cercarla lì sarebbe trovare rumore.
const blob = (text) => ({ type: 'api-request-blob', message: { content: text } });

test('trova una frase detta dall\'utente e una scritta dall\'agente', async () => {
  const sessions = [
    transcript('alfa', [user('parliamo del ponte verso ChatGPT'), assistant('il ponte è configurato')]),
    transcript('beta', [user('niente a che vedere')]),
  ];
  const { hits } = await searchConversations({ sessions, query: 'ponte' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 'alfa');
  assert.equal(hits[0].role, 'tu');
  assert.match(hits[0].snippet, /ponte/);
  assert.equal(hits[0].at, '2026-10-01T10:00:00.000Z');
});

test('una conversazione si propone una volta sola', async () => {
  const sessions = [transcript('alfa', [user('ponte ponte ponte'), assistant('ancora ponte')])];
  const { hits } = await searchConversations({ sessions, query: 'ponte' });
  assert.equal(hits.length, 1);
});

test('il testo nei blob delle richieste non conta come conversazione', async () => {
  const sessions = [transcript('alfa', [blob('ponte che nessuno ha scritto'), user('altro')])];
  const { hits } = await searchConversations({ sessions, query: 'ponte' });
  assert.deepEqual(hits, []);
});

test('sotto i tre caratteri non si cerca: è rumore, non una ricerca', async () => {
  const sessions = [transcript('alfa', [user('a me piace la a')])];
  assert.deepEqual((await searchConversations({ sessions, query: 'a' })).hits, []);
  assert.deepEqual((await searchConversations({ sessions, query: '' })).hits, []);
  assert.equal((await searchConversations({ sessions, query: 'a' })).total, 1, 'il totale resta quello che si sarebbe guardato');
});

test('il taglio si dichiara invece di far finta di aver guardato tutto', async () => {
  const many = Array.from({ length: 5 }, (_unused, index) => transcript(`chat-${index}`, [user('parola cercata')]));
  const cut = await searchConversations({ sessions: many, query: 'parola', maxResults: 2 });
  assert.equal(cut.hits.length, 2);
  assert.equal(cut.truncated, true);
  assert.equal(cut.total, 5);
  assert.equal(cut.scanned, 2);
});

test('un transcript che non c\'è non fa fallire la ricerca degli altri', async () => {
  const sessions = [
    { sessionId: 'fantasma', name: 'fantasma', transcript: path.join(root, 'non-esiste.jsonl') },
    transcript('alfa', [user('parola cercata')]),
  ];
  const result = await searchConversations({ sessions, query: 'parola' });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].sessionId, 'alfa');
});

test('una riga tagliata a metà dalla finestra non inventa un risultato', async () => {
  const file = path.join(root, 'tagliata.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(user('parola cercata'))}\n{"type":"user","message":{"cont`);
  const result = await searchConversations({ sessions: [{ sessionId: 'tagliata', name: 'tagliata', transcript: file }], query: 'parola' });
  assert.equal(result.hits.length, 1);
});

test('la ricerca è insensibile alle maiuscole', async () => {
  const sessions = [transcript('alfa', [user('Il Ponte Verso ChatGPT')])];
  assert.equal((await searchConversations({ sessions, query: 'PONTE' })).hits.length, 1);
  assert.equal((await searchConversations({ sessions, query: 'chatgpt' })).hits.length, 1);
});
