// Prova del meccanismo che regge la Fase 1: possiamo decidere noi l'id della conversazione?
//
// Se sì, ogni chat ha un'identità stabile (`--session-id <uuid>`) e il suo transcript sta in
// `<config>/projects/<slug>/<uuid>.jsonl` — niente più "il transcript più recente" come fonte
// di verità, che con due chat nella stessa cartella è una scommessa.
//
// Uso la config vera dell'utente e una cartella già fidata (con un config dir nuovo Claude
// Code parte dall'onboarding e non si arriva mai a una conversazione). Il transcript di prova
// si cancella alla fine.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('');
const pty = require('node-pty');

const configDir = path.join(process.env.USERPROFILE ?? os.homedir(), '.claude');
const project = process.env.USERPROFILE ?? os.homedir();

const MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID',
];
const env = { ...process.env };
for (const marker of MARKERS) delete env[marker];

function resolveClaude() {
  const exts = (process.env.PATHEXT ?? '.EXE').split(';');
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      for (const candidate of [path.join(dir, `claude${ext.toLowerCase()}`), path.join(dir, `claude${ext.toUpperCase()}`)]) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

const uuid = crypto.randomUUID();
const slug = project.replace(/[^A-Za-z0-9]/g, '-');
const sessionDir = path.join(configDir, 'projects', slug, uuid);
const transcript = `${sessionDir}.jsonl`;
const CLEAR_LINE = '\x15';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

console.log(`eseguibile:         ${resolveClaude()}`);
console.log(`uuid scelto da noi: ${uuid}`);
console.log(`transcript atteso:  ${transcript}`);

const claude = pty.spawn(resolveClaude(), ['--session-id', uuid], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: project,
  env,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let shown = '';
claude.onData((data) => { shown += data; });

await sleep(12_000);
const dirRightAway = fs.existsSync(sessionDir);
console.log(`\ncartella di sessione col nostro id, appena avviato: ${dirRightAway ? 'si' : 'no'}`);

// Il .jsonl nasce al primo messaggio: si manda un prompt col framing nostro.
claude.write(`${CLEAR_LINE}${PASTE_START}prova dell id di sessione${PASTE_END}\r`);
await sleep(20_000);

const exists = fs.existsSync(transcript);
const lines = exists ? fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean) : [];
const types = lines.map((line) => {
  try {
    const entry = JSON.parse(line);
    return `${entry.type}${entry.message?.role ? `/${entry.message.role}` : ''}`;
  } catch {
    return 'illeggibile';
  }
});

console.log(`transcript col nostro id: ${exists ? 'SI' : 'no'}`);
console.log(`righe: ${lines.length}${types.length ? ` (${types.slice(0, 6).join(', ')})` : ''}`);
console.log(`id dentro il transcript: ${lines.some((line) => line.includes(uuid)) ? 'coerente' : 'non trovato'}`);
console.log(`\n--- schermo (ANSI rimosso, ultimi 200) ---\n${shown.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(-200)}`);

claude.kill();
console.log(`\n${exists ? 'SESSION-ID PASS' : 'SESSION-ID FAIL'} — l'id della conversazione lo decidiamo noi`);

// non deve restare niente: ne' il transcript ne' la cartella di sessione
for (const target of [transcript, sessionDir]) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // non c'era
  }
}
process.exit(exists ? 0 : 1);