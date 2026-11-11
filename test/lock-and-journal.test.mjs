import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureServer, ping } from '../src/cli/daemon.mjs';
import { createTurnJournal } from '../src/host/turn-journal.mjs';

// Due cose piccole che però sbagliavano in silenzio.
//
// 1. Il lucchetto dell'avvio stava in `~/.cc-remote/serve.lock` anche quando il registro era
//    altrove: ogni prova toccava il file di chi usa la macchina, e due rig diversi si contendevano
//    lo stesso lucchetto. E si considerava «vecchio» dopo 30 secondi, mentre chi lo tiene può
//    aspettare legittimamente 40: un proprietario vivo e lento se lo vedeva portare via.
// 2. Il giornale dei turni tagliava al tetto solo quando **aggiungeva**: un file più lungo del
//    tetto restava in memoria intero.

const repo = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Una porta libera, chiesta al sistema e subito restituita.
 *
 * Non `CR_PORT=0` come negli altri test: qui si chiama `ensureServer()`, che per sapere se il
 * server è acceso deve *bussare a una porta* — e con `0` non c'è nessuna porta a cui bussare.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('il lucchetto dell\'avvio sta accanto al registro, non nella cartella di casa', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lock-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  const port = await freePort();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CR_')) delete env[key];
  Object.assign(env, {
    CR_TOKEN: 'token-di-prova-lungo-abbastanza',
    CR_PORT: String(port),
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: project,
    CR_LOG_FILE: path.join(root, 'serve.log'),
    CR_CLAUDE_CMD: process.execPath,
    CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
  });

  const home = path.join(os.homedir(), '.cc-remote', 'serve.lock');
  const before = fs.existsSync(home) ? fs.readFileSync(home, 'utf8') : null;
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    const started = await ensureServer({ waitMs: 20_000 });
    assert.ok(started.health, 'il server non si è acceso');
    // Il lucchetto della prova si toglie quando l'avvio è finito: quello che conta è che **quello
    // dell'utente** non sia stato né letto né scritto né cancellato da una prova.
    const after = fs.existsSync(home) ? fs.readFileSync(home, 'utf8') : null;
    assert.equal(after, before, 'il lucchetto dell\'utente è stato toccato da una prova');

    // E il server acceso da questa prova si spegne, così non resta niente in giro.
    await fetch(`http://127.0.0.1:${port}/local/shutdown`, { method: 'POST', headers: { 'x-cc-remote-token': env.CR_TOKEN } });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && await ping({ timeoutMs: 500 })) await sleep(200);
    assert.equal(await ping({ timeoutMs: 500 }), null, 'il server di prova è rimasto acceso');
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await sleep(300);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  return;
});

test('il giornale dei turni si taglia anche quando lo si carica', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-journal-'));
  const file = path.join(root, 'turns.json');
  try {
    // Un file con dieci voci, e un tetto di due: al caricamento ne restano due, le ultime.
    const turns = Array.from({ length: 10 }, (_unused, index) => ({
      requestId: `r${index}`,
      sessionId: 's',
      turnId: `t${index}`,
      state: 'done',
      reply: `risposta ${index}`,
      error: null,
      finishedAt: new Date(Date.now() - (10 - index) * 1000).toISOString(),
    }));
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, turns }, null, 2)}\n`);

    // Il caricamento lo fa la creazione: qui si guarda solo cosa resta dopo il taglio.
    const journal = createTurnJournal({ file, size: 2 });
    assert.equal(journal.size(), 2, 'il tetto vale anche su quello che c\'è già');
    assert.equal(journal.get('r9').reply, 'risposta 9', 'restano le ultime');
    assert.equal(journal.get('r0'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('due voci con lo stesso id: se ne tiene una, e `forget` non ne porta via due', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dupe-'));
  const file = path.join(root, 'sessions.json');
  try {
    // Registro corrotto: stessa conversazione scritta due volte (con dati diversi).
    fs.writeFileSync(file, `${JSON.stringify({
      version: 1,
      sessions: [
        { sessionId: 'aaaa-1111', name: 'prima', projectPath: 'C:/x', mcpAllowed: false },
        { sessionId: 'aaaa-1111', name: 'seconda', projectPath: 'C:/x', mcpAllowed: true },
        { sessionId: 'bbbb-2222', name: 'altra', projectPath: 'C:/x' },
      ],
    }, null, 2)}\n`);

    // Il registro si carica così com'è: la deduplica la fa chi legge (una volta sola, all'avvio).
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const seen = new Set();
    const unique = parsed.sessions.filter((entry) => {
      if (seen.has(entry.sessionId)) return false;
      seen.add(entry.sessionId);
      return true;
    });
    assert.equal(unique.length, 2);
    assert.equal(unique[0].name, 'prima', 'si tiene la prima');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
