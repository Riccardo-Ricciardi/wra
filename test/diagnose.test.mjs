// La diagnosi: le stesse domande di `rc doctor`, ma su un filesystem finto e senza lanciare
// processi. Le due cose che contano più di tutte: che «illeggibile» non venga chiamato «corrotto»
// (il pomeriggio del 02/11), e che il token non compaia **mai** in quello che si mostra.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { diagnoseDeep, diagnoseFacts, listBackups, pathsOf, systemStatus } from '../src/host/diagnose.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diag-'));

function makeConfig(dir) {
  return {
    home: dir,
    host: '127.0.0.1',
    port: 4310,
    token: 'x'.repeat(48),
    stateFile: path.join(dir, 'sessions.json'),
    projectsFile: path.join(dir, 'projects.json'),
    turnJournalFile: path.join(dir, 'turns.json'),
    accessFile: path.join(dir, 'access.json'),
    projectsRoot: path.join(dir, 'transcripts'),
    logFile: path.join(dir, 'cc-remote.log'),
    publicOrigin: '',
    publicOrigins: [],
    dashboardHost: '',
    mcpHost: '',
    issuerUrl: '',
    resourceUrl: '',
    claudeCmd: 'claude',
  };
}

/** Le sonde finte: nessun processo, nessun `where`, e i file si leggono dal disco vero. */
function makeProbes(overrides = {}) {
  return {
    exists: (file) => fs.existsSync(file),
    readJsonList: (file, key) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed?.[key]) ? { entries: parsed[key] } : { why: `JSON valido ma senza «${key}»` };
      } catch (error) {
        if (error.code === 'ENOENT') return { why: 'missing' };
        return {
          why: error instanceof SyntaxError ? `broken JSON: ${error.message}` : `cannot open it: ${error.code}`,
          unreadable: true,
        };
      }
    },
    readDir: (folder) => { try { return fs.readdirSync(folder); } catch { return []; } },
    stat: (file) => { try { return fs.statSync(file); } catch { return null; } },
    which: () => false,
    run: () => null,
    claudeVersion: () => null,
    platform: 'win32',
    node: 'v24.0.0',
    now: () => Date.now(),
    env: {},
    ...overrides,
  };
}

const find = (checks, name) => checks.find((check) => check.name === name);

test('un registro illeggibile non viene chiamato corrotto', () => {
  const dir = temp();
  const config = makeConfig(dir);
  // Un file che c'è e non si legge: EACCES. È il caso «EPERM» dell'incidente, che nessuna
  // riscrittura aggiusta e che va detto con il suo nome.
  const probes = makeProbes({
    readJsonList: () => ({ why: 'cannot open it: EPERM', unreadable: true }),
    exists: () => true,
  });
  const registro = find(diagnoseFacts({ config, probes }).checks, 'registry');
  assert.equal(registro.ok, false);
  assert.match(registro.detail, /UNREADABLE/);
  assert.match(registro.detail, /EPERM/);
  assert.doesNotMatch(registro.detail, /corrupt/);
});

test('un registro con il JSON rotto lo dice, e non è la stessa riga di «non si apre»', () => {
  const dir = temp();
  const config = makeConfig(dir);
  fs.writeFileSync(config.stateFile, '{ questo non è json');
  fs.writeFileSync(`${config.stateFile}.bak`, JSON.stringify({ sessions: [{ sessionId: 'a' }] }));
  const checks = diagnoseFacts({ config, probes: makeProbes() }).checks;
  assert.match(find(checks, 'registry').detail, /broken JSON/);
  assert.equal(find(checks, 'registry backup').ok, true);
});

test('la diagnosi non mostra mai il token, nemmeno in un dettaglio', () => {
  const dir = temp();
  const config = makeConfig(dir);
  config.token = 'token-segreto-0123456789';
  fs.writeFileSync(config.stateFile, JSON.stringify({ sessions: [] }));
  const everything = JSON.stringify([
    diagnoseFacts({ config, probes: makeProbes() }).checks,
    diagnoseDeep({ config, probes: makeProbes() }),
  ]);
  assert.doesNotMatch(everything, /token-segreto/);
  assert.match(everything, /24 characters/, 'si dice che il token c\'è e quanto è lungo, non qual è');
});

test('il registro assente non è un errore: il server lo creerà', () => {
  const dir = temp();
  const config = makeConfig(dir);
  const registro = find(diagnoseFacts({ config, probes: makeProbes() }).checks, 'registry');
  assert.equal(registro.ok, true);
  assert.match(registro.detail, /missing/);
});

test('i permessi della cartella di stato si provano facendo, non guardando', () => {
  const dir = temp();
  const config = makeConfig(dir);
  // Una cartella che non si può creare: il «genitore» è un file. Vale su ogni sistema, senza
  // toccare i permessi veri di nessuno.
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'sono un file, non una cartella');
  config.stateFile = path.join(blocker, 'nested', 'sessions.json');
  const check = find(diagnoseDeep({ config, probes: makeProbes() }), 'state folder permissions');
  assert.equal(check.ok, false);
  assert.match(check.detail, /cannot/);
});

test('le copie si elencano dalla più recente, e quella senza manifesto è dichiarata rotta', () => {
  const dir = temp();
  const config = makeConfig(dir);
  const store = path.join(dir, 'backups');
  fs.mkdirSync(path.join(store, '2026-01-01T10-00-00'), { recursive: true });
  fs.writeFileSync(path.join(store, '2026-01-01T10-00-00', 'MANIFEST.json'),
    JSON.stringify({ createdAt: '2026-01-01T10:00:00.000Z', chats: 3, files: [{ name: 'sessions.json', bytes: 10 }] }));
  fs.mkdirSync(path.join(store, '2026-02-01T10-00-00'), { recursive: true });
  fs.writeFileSync(path.join(store, '2026-02-01T10-00-00', 'MANIFEST.json'), 'non è json');
  fs.mkdirSync(path.join(store, 'senza-manifesto'), { recursive: true });

  const rows = listBackups({ config, probes: makeProbes() });
  assert.equal(rows.length, 2, 'una cartella senza manifesto non è una copia');
  assert.equal(rows[0].name, '2026-02-01T10-00-00');
  assert.equal(rows[0].broken, true);
  assert.equal(rows[1].chats, 3);
  assert.equal(rows[1].bytes, 10);
});

test('lo stato del sistema conta le sessioni per stato e i processi davvero gestiti', () => {
  const dir = temp();
  const config = makeConfig(dir);
  const status = systemStatus({
    config,
    version: '0.1.0',
    sessions: [
      { sessionId: 'a', name: 'una', state: 'ready', pid: 101, busy: false },
      { sessionId: 'b', name: 'due', state: 'offline', pid: null, archived: true },
      // `mcpReachable`, non `mcpAllowed`: il conteggio dice quante chat un client MCP può davvero
      // raggiungere, e su una chat in bypass l'interruttore da solo non basta.
      { sessionId: 'c', name: 'tre', state: 'busy', pid: 103, busy: true, mcpAllowed: true, mcpReachable: true },
      { sessionId: 'd', name: 'quattro', state: 'exited', pid: null },
    ],
    projects: [{ key: 'x' }, { key: 'y' }],
    health: { mcp: false },
    clients: { clients: 2, sessions: 1 },
  });
  assert.equal(status.sessions.total, 4);
  assert.equal(status.sessions.archived, 1);
  assert.equal(status.sessions.exposed, 1);
  assert.deepEqual(status.sessions.byState, { ready: 1, starting: 0, busy: 1, offline: 1, exited: 1 });
  assert.deepEqual(status.processes.map((entry) => entry.pid), [101, 103]);
  assert.equal(status.projects, 2);
  assert.deepEqual(status.connections, { clients: 2, sessions: 1 });
  assert.equal(status.mcp.enabled, false);
});

test('i percorsi si dicono tutti, e si dice che i transcript stanno da un\'altra parte', () => {
  const dir = temp();
  const config = makeConfig(dir);
  const paths = pathsOf({ config });
  assert.equal(paths.stateFile, config.stateFile);
  assert.match(paths.backups, /backups$/);
  assert.match(paths.transcripts, /no backup, no restore touches them/);
});
