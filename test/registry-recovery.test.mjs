import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createRegistry } from '../src/host/session-registry.mjs';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-recovery-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const config = { ...loadConfig({}), stateFile: path.join(root, 'sessions.json'),
    projectsRoot: path.join(root, 'transcripts'), allowedRoots: [root],
    claudeArgs: [], hooks: false, maxSessions: 8 };
  const spawn = () => ({ pid: 1, write() {}, resize() {}, kill() {}, get exited() { return false; } });
  return { root, project, config, spawn };
}

test('recovers sessions from a validated backup and preserves damaged original', () => {
  const { root, project, config, spawn } = setup();
  try {
    const first = createRegistry({ config, spawn });
    const a = first.create({ projectPath: project, name: 'persistent' });
    first.setMcpAllowed(a.sessionId, true);
    first.closeAll();
    assert.ok(fs.existsSync(config.stateFile + '.bak'));
    fs.writeFileSync(config.stateFile, '{broken json');
    const next = createRegistry({ config, spawn });
    assert.equal(next.get(a.sessionId)?.name, 'persistent');
    assert.equal(next.get(a.sessionId)?.mcpAllowed, false, 'backup preserves prior committed snapshot');
    assert.ok(fs.readdirSync(root).some(name => name.startsWith('sessions.json.corrupt-')));
    next.closeAll();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to start when primary and backup are corrupt, rather than discarding chats', () => {
  const { root, config, spawn } = setup();
  try {
    fs.writeFileSync(config.stateFile, 'bad');
    fs.writeFileSync(config.stateFile + '.bak', 'also bad');
    assert.throws(() => createRegistry({ config, spawn }), /Refusing to overwrite user sessions/);
    assert.equal(fs.readFileSync(config.stateFile, 'utf8'), 'bad');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('salvare non lascia file temporanei in giro, e il backup resta valido', () => {
  const { root, project, config, spawn } = setup();
  try {
    const registry = createRegistry({ config, spawn });
    const a = registry.create({ projectPath: project, name: 'prima' });
    registry.rename(a.sessionId, 'rinominata');
    registry.setMcpAllowed(a.sessionId, true);

    const leftovers = fs.readdirSync(root).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'nessun .tmp rimasto indietro');

    // il backup contiene uno stato *valido*, mai il file rotto appena scritto
    const backup = JSON.parse(fs.readFileSync(`${config.stateFile}.bak`, 'utf8'));
    assert.ok(Array.isArray(backup.sessions));
    assert.ok(backup.sessions.every((entry) => entry.sessionId && entry.projectPath));
    registry.closeAll();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dopo un recupero, il salvataggio successivo non copia il file rotto nel backup', () => {
  const { root, project, config, spawn } = setup();
  try {
    const first = createRegistry({ config, spawn });
    const a = first.create({ projectPath: project, name: 'buona' });
    first.rename(a.sessionId, 'secondo nome'); // secondo salvataggio: nasce il .bak, e contiene 'buona'
    first.closeAll();
    assert.ok(fs.existsSync(config.stateFile + '.bak'), 'il backup esiste dalla seconda scrittura in poi');

    fs.writeFileSync(config.stateFile, '{troncato');
    const recovered = createRegistry({ config, spawn });
    // il backup è lo stato *prima* dell ultima scrittura: si torna a 'buona', non al nome dopo
    assert.equal(recovered.get(a.sessionId)?.name, 'buona');

    // si scrive di nuovo: il backup deve restare leggibile
    recovered.rename(a.sessionId, 'dopo il recupero');
    const backup = JSON.parse(fs.readFileSync(`${config.stateFile}.bak`, 'utf8'));
    assert.equal(backup.sessions[0].name, 'buona', 'il backup resta la versione precedente, e valida');
    assert.equal(recovered.get(a.sessionId).name, 'dopo il recupero');

    // e il file principale è di nuovo valido
    const primary = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
    assert.equal(primary.sessions.length, 1);
    recovered.closeAll();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un backup troncato non viene usato: se il principale è buono si legge quello', () => {
  const { root, project, config, spawn } = setup();
  try {
    const first = createRegistry({ config, spawn });
    const a = first.create({ projectPath: project, name: 'intatta' });
    first.setMcpAllowed(a.sessionId, true);
    first.closeAll();
    fs.writeFileSync(`${config.stateFile}.bak`, '{"sessions": [{"sessionId"');

    const next = createRegistry({ config, spawn });
    assert.equal(next.get(a.sessionId)?.mcpAllowed, true, 'il principale vale, il backup non si tocca');
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.corrupt-')), false, 'e non si quarantena niente');
    next.closeAll();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il recupero riporta indietro tutte le chat del backup, non solo la prima', () => {
  const { root, project, config, spawn } = setup();
  try {
    const first = createRegistry({ config, spawn });
    for (const name of ['una', 'due', 'tre']) first.create({ projectPath: project, name });
    // un salvataggio in più: il .bak è la versione *precedente*, quindi contiene due chat
    first.rename(first.list()[0].sessionId, 'rinominata');
    first.closeAll();

    const inBackup = JSON.parse(fs.readFileSync(`${config.stateFile}.bak`, 'utf8')).sessions;
    assert.ok(inBackup.length > 1, 'il backup deve contenere più di una chat, se no il test non prova niente');

    fs.writeFileSync(config.stateFile, 'non json');
    const recovered = createRegistry({ config, spawn });

    // quello che torna indietro è *esattamente* il contenuto del backup — non solo la prima riga
    assert.deepEqual(
      recovered.list().map((session) => session.sessionId).sort(),
      inBackup.map((entry) => entry.sessionId).sort(),
    );
    assert.ok(fs.readdirSync(root).some((name) => name.startsWith('sessions.json.corrupt-')),
      'e l originale danneggiato resta, per poterci recuperare a mano quello che il backup non ha');
    recovered.closeAll();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
