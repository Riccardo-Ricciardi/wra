#!/usr/bin/env node
// Una TUI finta, per provare il server senza un Claude vero e senza un browser.
// Fa tre cose: annuncia di essersi avviata, ripete quello che riceve, e **scrive un
// transcript** nella forma che usa Claude Code — così i test possono provare il giro
// completo (prompt iniettato -> transcript -> risposta letta) senza un agente vero.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLEAR_LINE = '\x15';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const cwd = process.cwd();
// L'id della conversazione ce lo passa il server: `--session-id` per una chat nuova, `--resume`
// per riprenderne una che esiste. La TUI finta li rispetta **tutti e due** — se ignorasse
// `--resume` inventerebbe un id nuovo, scriverebbe in un altro transcript, e una prova di
// ripresa passerebbe (o fallirebbe) per colpa della finta, non del server.
const argValue = (name) => {
  const at = process.argv.indexOf(name);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : null;
};
const sessionId = argValue('--session-id') ?? argValue('--resume') ?? crypto.randomUUID();
const projectsRoot = process.env.CR_PROJECTS_ROOT || path.join(os.homedir(), '.claude', 'projects');
const transcriptDir = path.join(projectsRoot, cwd.replace(/[^A-Za-z0-9]/g, '-'));
const transcriptFile = path.join(transcriptDir, `${sessionId}.jsonl`);

fs.mkdirSync(transcriptDir, { recursive: true });
const append = (entry) => fs.appendFileSync(transcriptFile, `${JSON.stringify(entry)}\n`);

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// Quanto ci mette la finta a rispondere. A zero risponde subito (come sempre); con un valore
// risponde dopo, ed è l'unico modo di provare un turno che **supera la finestra di ascolto**
// senza aspettare dieci minuti veri.
const replyDelayMs = Number(process.env.CR_FAKE_DELAY_MS || 0);

// Un transcript vero comincia con l'entry di sistema: la scriviamo subito, così chi cerca le
// sessioni di questa cartella la trova prima ancora che arrivi un messaggio.
append({
  parentUuid: null,
  isSidechain: false,
  userType: 'external',
  cwd,
  sessionId,
  version: 'fake',
  type: 'system',
  subtype: 'init',
  uuid: uuid(),
  timestamp: now(),
});

process.stdout.write('FAKE-CLAUDE pronto\r\n');
process.stdin.setEncoding('utf8');

let lastUserUuid = null;

process.stdin.on('data', (chunk) => {
  if (chunk.includes('exit')) {
    process.stdout.write('FAKE-CLAUDE esce\r\n');
    process.exit(0);
  }

  // Quello che l'agente vero scriverebbe nel transcript: il testo nudo, senza i byte di
  // controllo del bracketed paste.
  const text = chunk
    .split(CLEAR_LINE).join('')
    .split(PASTE_START).join('')
    .split(PASTE_END).join('')
    .replace(/\r/g, '')
    .trim();

  if (text) {
    lastUserUuid = uuid();
    append({
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      version: 'fake',
      type: 'user',
      message: { role: 'user', content: text },
      uuid: lastUserUuid,
      timestamp: now(),
      promptId: `prompt-${lastUserUuid.slice(0, 8)}`,
    });
    const answer = () => append({
      parentUuid: lastUserUuid,
      isSidechain: false,
      userType: 'external',
      cwd,
      sessionId,
      version: 'fake',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `RICEVUTO ${text.slice(0, 40)}` }],
        stop_reason: 'end_turn',
      },
      uuid: uuid(),
      timestamp: now(),
    });
    if (replyDelayMs > 0) setTimeout(answer, replyDelayMs);
    else answer();
  }

  // `process.stdout.columns` è fissato all'avvio: su Windows non si aggiorna quando il PTY
  // viene ridimensionato (il ridisegno arriva, il valore no). getWindowSize() invece chiede
  // la misura vera al terminale, ed è quello che serve ai test.
  const [cols, rows] = process.stdout.getWindowSize ? process.stdout.getWindowSize() : [process.stdout.columns, process.stdout.rows];
  process.stdout.write(`ECHO ${JSON.stringify(chunk)}\r\nSIZE ${cols}x${rows}\r\n`);
});