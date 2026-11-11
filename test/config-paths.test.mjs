import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Dove finiscono i file di questo server.
//
// Il difetto che questo test tiene fermo: `access.json` e `settings.json` seguivano il registro,
// gli altri due no — `projects.json` e `turns.json` finivano sempre in `~/.cc-remote`. Quindi un
// test che isolava il registro in una cartella temporanea **scriveva lo stesso nei file veri**, e
// il `projects.json` del proprietario si era riempito di 64 voci di prova, tutte di test e nessuna
// reale. Isolare il registro deve isolare tutto quello che gli sta accanto.

/** Legge la configurazione come la vedrebbe un processo con queste variabili. */
function configCon(env) {
  const uscita = execFileSync(process.execPath, ['-e', 'import("./src/config.mjs").then(m => console.log(JSON.stringify(m.config)))'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return JSON.parse(uscita);
}

test('isolare il registro isola **tutto** quello che gli sta accanto', () => {
  const finta = path.join(os.tmpdir(), 'cc-remote-prova-isolamento');
  const c = configCon({ CR_STATE_FILE: path.join(finta, 'sessions.json') });
  const dentro = (file) => assert.equal(path.dirname(c[file]), finta, `${file} è finito fuori: ${c[file]}`);

  for (const file of ['stateFile', 'projectsFile', 'turnJournalFile', 'accessFile', 'settingsFile']) dentro(file);
});

test('senza dire niente, tutto sta in ~/.cc-remote come è sempre stato', () => {
  // Il caso vero non deve cambiare: chi non isola niente deve ritrovarsi i file dov'erano.
  const c = configCon({ CR_STATE_FILE: '' });
  const atteso = path.join(process.env.USERPROFILE ?? process.env.HOME ?? os.homedir(), '.cc-remote');
  for (const file of ['stateFile', 'projectsFile', 'turnJournalFile', 'accessFile', 'settingsFile']) {
    assert.equal(path.dirname(c[file]), atteso, `${file}: ${c[file]}`);
  }
});

test('i transcript di Claude Code **non** seguono il registro, ed è voluto', () => {
  // `~/.claude/projects` è di Claude Code, non nostro: cc-remote lo legge e non lo possiede.
  // Farlo seguire al registro vorrebbe dire che un registro isolato cerca i transcript in una
  // cartella temporanea dove non ci sono — e le conversazioni risulterebbero tutte vuote.
  const c = configCon({ CR_STATE_FILE: path.join(os.tmpdir(), 'cc-remote-prova', 'sessions.json') });
  assert.match(c.projectsRoot, /\.claude[\\/]projects$/, `projectsRoot: ${c.projectsRoot}`);
});

test('una variabile esplicita vince sempre', () => {
  const c = configCon({
    CR_STATE_FILE: path.join(os.tmpdir(), 'uno', 'sessions.json'),
    CR_PROJECTS_FILE: path.join(os.tmpdir(), 'due', 'progetti.json'),
  });
  assert.equal(path.dirname(c.projectsFile), path.join(os.tmpdir(), 'due'));
});
