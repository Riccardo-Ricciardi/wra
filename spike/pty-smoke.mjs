// SPIKE go/no-go (piano approvato, fase 0).
//
// Tre cose in un colpo:
//   1. node-pty + ConPTY rende il TUI di Claude Code in modo utilizzabile su Windows;
//   2. il framing (Ctrl+U + bracketed paste + \r) fa arrivare il prompt a una sessione
//      nata da un PTY nostro, non da cloudcli;
//   3. il motore di turni del repo vecchio (`runTurn`) e il suo lettore del transcript
//      funzionano identici con questo trasporto — il seam `{ send(text), projectPath }`
//      che il piano usa per il porting.
//
// Se questo passa, l'architettura regge e si parte con M0. Se non passa, si cambia prima.
//
//   node spike/pty-smoke.mjs [cartella-progetto]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { framePrompt } from '../src/core/prompt.mjs';
import { runTurn } from '../src/core/turns.mjs';

const projectDir = process.argv[2] ?? path.join(os.homedir());
const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
const nonce = Math.random().toString(16).slice(2, 8).toUpperCase();
const message = `Rispondi solo con: SPIKE-${nonce}`;

// I marker di sessione ereditati farebbero credere al figlio di essere la nostra sessione:
// con CLAUDE_CODE_CHILD_SESSION il transcript non viene scritto. Il repo vecchio li toglie
// in start.ps1; qui si tolgono sull'ambiente del figlio.
const MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID',
];
const env = { ...process.env };
for (const name of MARKERS) delete env[name];

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

// node-pty su Windows chiama CreateProcess, che non applica PATHEXT: 'claude' non basta,
// serve il file vero. Risoluzione minima dal PATH (nel progetto diventa `resolveClaude()`).
function resolveExecutable(name, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (fs.existsSync(candidate)) return candidate;
      const upper = path.join(dir, name + ext.toUpperCase());
      if (fs.existsSync(upper)) return upper;
    }
  }
  return null;
}

const claudeCmd = resolveExecutable('claude', env);
if (!claudeCmd) {
  console.error('claude non trovato nel PATH: serve per lo spike');
  process.exit(2);
}
console.log(`claude: ${claudeCmd}`);

console.log(`spike: ${message}`);
console.log(`progetto: ${projectDir}`);

const child = pty.spawn(claudeCmd, [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: projectDir,
  env,
});

let output = '';
let lastFrameAt = 0;
child.onData((data) => {
  output += data;
  lastFrameAt = Date.now();
});
child.onExit(({ exitCode }) => {
  console.log(`pty uscito, code ${exitCode}`);
});

const quiet = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Attesa del "pronto": il TUI ha finito di disegnare quando non arriva più niente.
async function waitReady({ timeoutMs = 90_000, quietMs = 1_200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lastFrameAt > 0 && Date.now() - lastFrameAt >= quietMs) return true;
    await quiet(200);
  }
  return false;
}

const readyAt = Date.now();
const ready = await waitReady();
console.log(`pronto in ${((Date.now() - readyAt) / 1000).toFixed(1)}s (output ${output.length} byte): ${ready ? 'si' : 'NO'}`);

// Il trasporto che il piano vuole: un sink con `send` e `projectPath`.
const sink = {
  projectPath: projectDir,
  send: (text) => child.write(framePrompt(text)),
};

// Prova la regola della larghezza: un resize non deve rompere il TUI.
child.resize(100, 30);
await quiet(400);
child.resize(160, 45);
await quiet(400);
console.log('resize 100x30 -> 160x45 senza eccezioni');

const transcriptDir = path.join(projectsRoot, projectDir.replace(/[^A-Za-z0-9]/g, '-'));
const before = fs.existsSync(transcriptDir)
  ? new Set(fs.readdirSync(transcriptDir).filter((n) => n.endsWith('.jsonl')))
  : new Set();

const started = Date.now();
const result = await runTurn({
  pty: sink,
  message,
  projectsRoot,
  projectDir,
  recentMs: 5 * 60_000,
  promptMatchMs: 120_000,
  pollMs: 400,
  settleMs: 1_500,
  maxWaitMs: 180_000,
});

const after = fs.existsSync(transcriptDir)
  ? fs.readdirSync(transcriptDir).filter((n) => n.endsWith('.jsonl'))
  : [];
const nuovi = after.filter((n) => !before.has(n));

console.log('\n--- esito del turno ---');
console.log(JSON.stringify({ ...result, reply: result.reply?.slice(0, 60) }, null, 2));
console.log(`secondi: ${((Date.now() - started) / 1000).toFixed(1)}`);
console.log(`transcript nuovi in quel progetto: ${nuovi.length ? nuovi.join(', ') : '(nessuno)'}`);
console.log('\n--- ultimo schermo del TUI (ANSI rimosso, ultimi 300 caratteri) ---');
console.log(JSON.stringify(strip(output).slice(-300)));

const ok = result.status === 'done' && (result.reply ?? '').includes(`SPIKE-${nonce}`);
console.log(`\n${ok ? 'SPIKE PASS' : 'SPIKE FAIL'} — atteso SPIKE-${nonce} nella risposta`);

child.kill();
process.exit(ok ? 0 : 1);