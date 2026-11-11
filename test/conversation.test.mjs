import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationLog } from '../src/core/conversation.mjs';

// Il transcript è una sequenza di eventi; la chat è una sequenza di messaggi. Qui si prova la
// traduzione, e si prova che **non venga inventato niente**: quello che non c'è nel transcript
// non compare nel messaggio.

let counter = 0;
const id = () => `id-${++counter}`;

const prompt = (text, at = '2026-10-30T10:00:00.000Z') => ({
  type: 'user', uuid: id(), timestamp: at, message: { role: 'user', content: text },
});

const answer = (content, extra = {}) => ({
  type: 'assistant', uuid: id(), timestamp: '2026-10-30T10:00:01.000Z',
  message: { role: 'assistant', model: 'un-modello', content },
  ...extra,
});

const toolResult = (toolUseId, content, { isError = false, ...extra } = {}) => ({
  type: 'user', uuid: id(), timestamp: '2026-10-30T10:00:02.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
  ...extra,
});

test('un prompt diventa un messaggio, e la risposta un altro', () => {
  const log = ConversationLog.fromEntries([prompt('ciao'), answer([{ type: 'text', text: 'ehi' }])]);
  assert.equal(log.messages.length, 2);
  assert.equal(log.messages[0].role, 'user');
  assert.equal(log.messages[0].parts[0].text, 'ciao');
  assert.equal(log.messages[1].role, 'assistant');
  assert.equal(log.messages[1].parts[0].text, 'ehi');
  assert.equal(log.messages[0].at, '2026-10-30T10:00:00.000Z', 'l orario è quello del transcript');
});

test('una risposta con uno strumento resta un messaggio solo, e il risultato lo aggiorna', () => {
  const log = new ConversationLog();
  log.push(prompt('leggi il file'));
  log.push(answer([
    { type: 'text', text: 'guardo' },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/x' } },
  ]));

  assert.equal(log.messages.length, 2, 'assistente = un messaggio, anche con lo strumento dentro');
  assert.deepEqual(log.messages[1].parts.map((part) => part.kind), ['text', 'tool']);
  assert.equal(log.messages[1].parts[1].result, null, 'prima del risultato non si inventa niente');

  const changed = log.push(toolResult('tool-1', 'contenuto del file'));
  assert.equal(log.messages.length, 2, 'il risultato NON è un messaggio nuovo');
  assert.equal(changed, log.messages[1], 'e chi ascolta sa quale messaggio è cambiato');
  assert.equal(log.messages[1].parts[1].result.text, 'contenuto del file');
  assert.equal(log.messages[1].parts[1].result.isError, false);
});

test('il testo dopo lo strumento continua lo stesso turno, nell ordine giusto', () => {
  const log = new ConversationLog();
  log.push(prompt('fai'));
  log.push(answer([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]));
  log.push(toolResult('t1', 'file1 file2'));
  log.push(answer([{ type: 'text', text: 'fatto' }]));

  assert.equal(log.messages.length, 2);
  const kinds = log.messages[1].parts.map((part) => part.kind);
  assert.deepEqual(kinds, ['tool', 'text'], 'lo strumento prima, il commento dopo');
  assert.equal(log.messages[1].parts[1].text, 'fatto');
});

test('un errore dello strumento si vede, e non diventa un messaggio dell utente', () => {
  const log = new ConversationLog();
  log.push(prompt('prova'));
  log.push(answer([{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'no' } }]));
  log.push(toolResult('t9', 'command not found', { isError: true, permissionDecision: { decision: 'accept', source: 'config' } }));

  assert.equal(log.messages.length, 2);
  const tool = log.messages[1].parts[0];
  assert.equal(tool.result.isError, true);
  assert.equal(tool.result.text, 'command not found');
  assert.deepEqual(tool.decision, { decision: 'accept', source: 'config' }, 'come è stato deciso il permesso');
});

test('il ragionamento c è quando il transcript lo scrive', () => {
  const log = ConversationLog.fromEntries([
    prompt('perché?'),
    answer([{ type: 'thinking', thinking: 'ci penso' }, { type: 'text', text: 'ecco' }], { thinkingDurationMs: 1500 }),
  ]);
  const parts = log.messages[1].parts;
  assert.equal(parts[0].kind, 'thinking');
  assert.equal(parts[0].text, 'ci penso');
  assert.equal(parts[0].durationMs, 1500, 'la durata la dà il transcript, non la calcoliamo noi');
});

test('per Bash si usa il risultato strutturato, quando c è', () => {
  const log = new ConversationLog();
  log.push(prompt('esegui'));
  log.push(answer([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }]));
  log.push(toolResult('b1', {}, { toolUseResult: { stdout: 'uno\ndue', stderr: '', interrupted: false } }));

  const result = log.messages[1].parts[0].result;
  assert.equal(result.kind, 'command');
  assert.equal(result.text, 'uno\ndue', 'stdout, senza il rumore intorno');
});

test('per Write/Edit si vede il file toccato', () => {
  const log = new ConversationLog();
  log.push(prompt('scrivi'));
  log.push(answer([{ type: 'tool_use', id: 'w1', name: 'Edit', input: { file_path: '/tmp/a.js' } }]));
  log.push(toolResult('w1', 'ok', {
    toolUseResult: { filePath: '/tmp/a.js', type: 'update', structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-vecchio', '+nuovo'] }] },
  }));

  const result = log.messages[1].parts[0].result;
  assert.equal(result.kind, 'edit');
  assert.equal(result.filePath, '/tmp/a.js');
  assert.equal(result.text, 'ok', 'e quando lo strutturato non ha testo, resta quello del risultato');

  // Un `structuredPatch` senza righe non è un diff: meglio dire "file" che mostrare una scheda
  // di modifica vuota.
  const log2 = new ConversationLog();
  log2.push(prompt('x'));
  log2.push(answer([{ type: 'tool_use', id: 'w2', name: 'Edit', input: { file_path: '/tmp/b.js' } }]));
  log2.push(toolResult('w2', 'ok', { toolUseResult: { filePath: '/tmp/b.js', structuredPatch: [{}, {}] } }));
  assert.equal(log2.messages[1].parts[0].result.kind, 'file');
});

test('i risultati enormi si tagliano, e lo dicono', () => {
  const log = new ConversationLog({ maxResultChars: 10 });
  log.push(prompt('leggi'));
  log.push(answer([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/tmp/x' } }]));
  log.push(toolResult('r1', 'x'.repeat(500)));
  const result = log.messages[1].parts[0].result;
  assert.equal(result.text.length, 10);
  assert.equal(result.truncated, true);
});

test('un input enorme si taglia invece di gonfiare il messaggio', () => {
  const log = new ConversationLog({ maxInputChars: 40 });
  log.push(prompt('scrivi'));
  log.push(answer([{ type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: '/tmp/a', content: 'y'.repeat(500) } }]));
  const tool = log.messages[1].parts[0];
  assert.equal(typeof tool.input, 'string', 'quello che non passa diventa testo tagliato');
  assert.equal(tool.inputTruncated, true);
});

test('le righe che non sono conversazione si saltano: niente messaggi fantasma', () => {
  const log = ConversationLog.fromEntries([
    { type: 'system', subtype: 'init', uuid: id() },
    { type: 'attachment', attachment: { type: 'hook_success' }, uuid: id() },
    { type: 'mode', mode: 'default', uuid: id() },
    { type: 'ai-title', aiTitle: 'titolo', uuid: id() },
    { type: 'assistant', isSidechain: true, uuid: id(), message: { content: [{ type: 'text', text: 'di un sotto-agente' }] } },
    prompt('solo questo'),
  ]);
  assert.equal(log.messages.length, 1);
  assert.equal(log.messages[0].parts[0].text, 'solo questo');
});

test('un risultato di cui non abbiamo visto la chiamata non crea niente', () => {
  const log = ConversationLog.fromEntries([toolResult('sconosciuto', 'boh')]);
  assert.equal(log.messages.length, 0, 'senza la chiamata non si sa a chi appartiene');
});

test('un prompt con blocchi di testo si legge come il testo semplice', () => {
  const log = new ConversationLog();
  log.push({ type: 'user', uuid: id(), message: { role: 'user', content: [{ type: 'text', text: 'una' }, { type: 'text', text: 'due' }] } });
  assert.equal(log.messages[0].parts[0].text, 'una\ndue');
});

test('una modifica a un file porta il diff, non una ricostruzione nostra', () => {
  const log = new ConversationLog();
  log.push(prompt('cambia'));
  log.push(answer([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/tmp/a.js' } }]));
  log.push(toolResult('e1', 'ok', {
    toolUseResult: {
      filePath: '/tmp/a.js',
      type: 'update',
      structuredPatch: [{
        oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
        lines: [' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;'],
      }],
    },
  }));

  const result = log.messages[1].parts[0].result;
  assert.equal(result.kind, 'edit');
  assert.equal(result.filePath, '/tmp/a.js');
  assert.equal(result.patch.length, 1);
  assert.deepEqual(result.patch[0].lines, [' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;']);
  assert.equal(result.added, 2, 'le righe aggiunte si contano dal diff');
  assert.equal(result.removed, 1);
});

test('un file nuovo si distingue da una modifica', () => {
  const log = new ConversationLog();
  log.push(prompt('crea'));
  log.push(answer([{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/tmp/nuovo.md' } }]));
  log.push(toolResult('w1', 'creato', {
    toolUseResult: { filePath: '/tmp/nuovo.md', type: 'create', structuredPatch: [{ oldStart: 0, newStart: 1, lines: ['+# titolo'] }] },
  }));
  assert.equal(log.messages[1].parts[0].result.kind, 'create');
});

test('un risultato senza diff resta senza diff: non se ne inventa uno', () => {
  const log = new ConversationLog();
  log.push(prompt('leggi'));
  log.push(answer([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/tmp/x' } }]));
  log.push(toolResult('r1', 'contenuto', { toolUseResult: { type: 'file' } }));
  const result = log.messages[1].parts[0].result;
  assert.equal(result.patch, undefined);
  assert.equal(result.kind, null);
  assert.equal(result.text, 'contenuto');
});
