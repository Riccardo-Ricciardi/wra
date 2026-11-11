import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createRegistry, transcriptFor } from '../src/host/session-registry.mjs';
import { pathKey } from '../src/core/workspace.mjs';

// Il registro e' il posto dove una chat *esiste*: piu' chat per lo stesso progetto, id stabili,
// `mcpAllowed` spento di default, e lo stato che sopravvive al processo.

// Il registro costruisce l'ambiente del `claude` da `process.env` e poi ci scrive sopra le
// variabili del relay. Se questo test gira **dentro** una chat di cc-remote, quelle variabili
// sono gia' nell'ambiente (l'agente le ha ereditate dal suo server): senza ripulirle, il caso
// «relay spento» vede il relay di chi sta eseguendo i test. Si tolgono una volta, qui.
const APPROVAL_VARS = ['CR_APPROVE_URL', 'CR_APPROVE_TOKEN', 'CR_APPROVE_SESSION', 'CR_APPROVE_TTL_MS'];
for (const name of APPROVAL_VARS) delete process.env[name];

function fakeSpawn(launches) {
  return ({ projectDir, args, env }) => {
    const state = { killed: false, written: [], exited: false };
    launches.push({ projectDir, args, env });
    return {
      projectDir,
      pid: launches.length,
      get exited() { return state.exited; },
      write(data) { state.written.push(data); },
      resize() {},
      kill() { state.exited = true; },
      onData() { return () => {}; },
      onExit() { return () => {}; },
    };
  };
}

function setup(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cc-remote-reg-${name}-`));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project);
  const launches = [];
  const config = {
    ...loadConfig({}),
    allowedRoots: [root],
    maxSessions: 6,
    stateFile: path.join(root, 'sessions.json'),
    projectsRoot: path.join(root, 'projects'),
    claudeCmd: 'claude',
    claudeArgs: [],
    permissionMode: 'default',
    replayBytes: 1024,
    port: 4310,
    token: 'token-di-prova',
    hooks: true,
  };
  const registry = createRegistry({ config, spawn: fakeSpawn(launches) });
  return { root, project, config, registry, launches };
}

test('due chat nello stesso progetto: id diversi, nessuna contaminazione', () => {
  const { root, project, registry, launches } = setup('due');
  try {
    const a = registry.create({ projectPath: project, name: 'prima' });
    const b = registry.create({ projectPath: project, name: 'seconda' });

    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(a.projectPath, b.projectPath);
    assert.equal(a.name, 'prima');
    assert.equal(registry.list().length, 2);
    assert.notEqual(a.transcript, b.transcript);
    assert.equal(launches.length, 2, 'una chat, un processo');

    // l'id della conversazione lo decidiamo noi
    const argsA = launches[0].args.join(' ');
    assert.match(argsA, /--session-id [0-9a-f]{8}-[0-9a-f]{4}/, `argomenti: ${argsA}`);
    assert.match(argsA, /--permission-mode default/, 'niente bypass come default');
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP spento di default, e si accende a mano', () => {
  const { root, project, registry } = setup('acl');
  try {
    const a = registry.create({ projectPath: project });
    const b = registry.create({ projectPath: project });
    assert.equal(a.mcpAllowed, false);
    assert.equal(b.mcpAllowed, false);
    assert.equal(registry.mcpAllowed().length, 0);

    registry.setMcpAllowed(a.sessionId, true);
    const allowed = registry.mcpAllowed();
    assert.deepEqual(allowed.map((session) => session.sessionId), [a.sessionId]);

    // e si spegne
    registry.setMcpAllowed(a.sessionId, false);
    assert.equal(registry.mcpAllowed().length, 0);
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lo stato sopravvive al processo: stessa chat, stesso id, ripresa con --resume', () => {
  const { root, project, config, registry, launches } = setup('restart');
  try {
    const created = registry.create({ projectPath: project, name: 'che resta' });
    registry.setMcpAllowed(created.sessionId, true);
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });

    // nuovo processo, stesso file di stato
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-reg-restart2-'));
    fs.mkdirSync(path.join(root2, 'progetto'));
    const launches2 = [];
    const config2 = { ...config, allowedRoots: [root2], stateFile: path.join(root, 'sessions.json') };
    // lo stateFile sta nella cartella cancellata: lo ricreiamo con lo stesso contenuto
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{ sessionId: created.sessionId, name: 'che resta', projectPath: created.projectPath, mcpAllowed: true, createdAt: new Date().toISOString() }],
    }));

    const registry2 = createRegistry({ config: config2, spawn: fakeSpawn(launches2) });
    const reloaded = registry2.get(created.sessionId);
    assert.ok(reloaded, 'la chat deve esserci dopo il riavvio');
    assert.equal(reloaded.state, 'offline', 'il processo no: quello si riprende');
    assert.equal(reloaded.mcpAllowed, true, 'anche l autorizzazione resta');

    // e riparte con --resume dello stesso id, se il transcript esiste
    fs.mkdirSync(path.dirname(reloaded.transcript), { recursive: true });
    fs.writeFileSync(reloaded.transcript, '{"type":"system"}\n');
    registry2.start(created.sessionId);
    assert.match(launches2[0].args.join(' '), new RegExp(`--resume ${created.sessionId}`));

    registry2.closeAll();
    fs.rmSync(root2, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* gia' via */ }
  }
});

test('al claude si passa il ponte delle approvazioni, col token fuori dalla riga di comando', () => {
  const { root, project, registry, launches, config } = setup('approve');
  try {
    const session = registry.create({ projectPath: project });
    const launch = launches[0];

    const at = launch.args.indexOf('--settings');
    assert.notEqual(at, -1, 'senza --settings il TUI non ha nessun ponte e il relay non esiste');
    const settings = JSON.parse(launch.args[at + 1]);
    const hook = settings.hooks.PermissionRequest[0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.match(hook.command, /perm-hook\.mjs/, `comando: ${hook.command}`);
    assert.ok(hook.timeout > 0, 'il TUI deve aspettare una persona, non scadere subito');

    // la sessione è quella che diciamo noi: l'hook non deve poter decidere per un'altra
    assert.equal(launch.env.CR_APPROVE_SESSION, session.sessionId);
    assert.equal(launch.env.CR_APPROVE_TOKEN, config.token);
    assert.match(launch.env.CR_APPROVE_URL, /^http:\/\/127\.0\.0\.1:4310\/local\/approve$/);
    assert.equal(launch.args.join(' ').includes(config.token), false, 'il token non si mette dove lo legge chiunque');
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('con il relay spento (CR_HOOKS=0) il claude parte come prima', () => {
  const { root, project, registry, launches, config } = setup('no-hooks');
  try {
    config.hooks = false;
    registry.create({ projectPath: project });
    assert.equal(launches[0].args.includes('--settings'), false);
    assert.equal(launches[0].env.CR_APPROVE_URL, undefined);
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una chat dimenticata non risorge quando il suo processo esce', () => {
  const { root, project, registry, launches } = setup('forget');
  try {
    const session = registry.create({ projectPath: project });
    const killed = launches[0];

    assert.equal(registry.forget(session.sessionId), true);
    assert.equal(registry.get(session.sessionId), null);

    // `forget` spegne il processo: l'uscita arriva dopo, e non deve riportare in vita niente
    assert.equal(killed.args.length > 0, true);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'));
    assert.deepEqual(saved.sessions, [], 'il registro non deve contenere la chat dimenticata');
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un record scritto a metà non impedisce di accendere il server', () => {
  const { root, project, config } = setup('rotto');
  try {
    // il caso vero: una chat fantasma senza cartella, come quella che lasciava `upsert`
    fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [
        { sessionId: 'senza-cartella', lastActivityAt: new Date().toISOString() },
        { sessionId: 'senza-nome', projectPath: project, name: 'buona', mcpAllowed: false, createdAt: new Date().toISOString() },
      ],
    }));

    const registry = createRegistry({ config, spawn: fakeSpawn([]) });
    const list = registry.list();
    assert.equal(list.length, 1, 'si tiene solo quello che è una chat');
    assert.equal(list[0].name, 'buona');
    assert.ok(list[0].transcript.endsWith('.jsonl'), 'e si può leggere senza esplodere');
    registry.closeAll();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il transcript di una chat ha il suo id, in un percorso noto', () => {
  const entry = { sessionId: '11111111-1111-4111-8111-111111111111', projectPath: String.raw`C:\Users\example\progetto` };
  const file = transcriptFor(entry, String.raw`C:\conf\projects`);
  assert.equal(file.endsWith(`${entry.sessionId}.jsonl`), true);
  assert.match(file, /C--Users-example-prog|C-users-example/);
});

test('il nome automatico conta dentro il progetto, non in tutta la macchina', () => {
  const { root, project, config, registry } = setup('nomi');
  try {
    const altro = path.join(root, 'altro');
    fs.mkdirSync(altro, { recursive: true });
    const a = registry.create({ projectPath: project });
    const b = registry.create({ projectPath: project });
    const c = registry.create({ projectPath: altro });
    assert.equal(a.name, 'chat 1');
    assert.equal(b.name, 'chat 2');
    assert.equal(c.name, 'chat 1', 'in un altro progetto si riparte da uno: «chat 1» due volte è normale, in due progetti diversi');
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('due conversazioni nello stesso progetto non possono avere lo stesso nome', () => {
  const { root, project, registry } = setup('unicita');
  try {
    const a = registry.create({ projectPath: project, name: 'prova' });
    const b = registry.create({ projectPath: project, name: 'prova' });
    assert.equal(b.name, 'prova 2', 'chi la chiede e la trova presa viene numerato, non rifiutato');

    assert.throws(() => registry.rename(b.sessionId, 'prova'), /already has a conversation named/);
    assert.equal(registry.get(b.sessionId).name, 'prova 2', 'e il nome resta quello di prima');
    registry.rename(b.sessionId, 'prova diversa');
    assert.equal(registry.get(b.sessionId).name, 'prova diversa');
    assert.ok(a.sessionId);
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('si può mettere un tetto alle conversazioni di un progetto', () => {
  const { root, project, config, registry } = setup('tetto');
  try {
    config.maxSessionsPerProject = 2;
    registry.create({ projectPath: project });
    registry.create({ projectPath: project });
    assert.throws(() => registry.create({ projectPath: project }), /CR_MAX_SESSIONS_PER_PROJECT|già 2 conversazioni/);
    const altro = path.join(root, 'altro');
    fs.mkdirSync(altro, { recursive: true });
    assert.ok(registry.create({ projectPath: altro }).sessionId, 'e un altro progetto non paga per il primo');
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('archiviare toglie dall elenco senza togliere la conversazione, e spegne il processo', () => {
  const { root, project, registry, launches } = setup('archivio');
  try {
    const a = registry.create({ projectPath: project, name: 'da archiviare' });
    registry.setMcpAllowed(a.sessionId, true);
    const archived = registry.setArchived(a.sessionId, true);

    assert.equal(archived.archived, true);
    assert.equal(registry.get(a.sessionId).name, 'da archiviare', 'la conversazione c\'è ancora');
    assert.equal(registry.list().length, 1, 'e il registro la tiene: è l\'elenco che la nasconde');
    assert.equal(registry.mcpAllowed().length, 0, 'e non si espone a ChatGPT nemmeno con l interruttore acceso');
    assert.equal(launches[0].args.length > 0, true);

    assert.equal(registry.setArchived(a.sessionId, false).archived, false);
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una conversazione importata non fa partire nessun processo', () => {
  const { root, project, registry, launches } = setup('importata');
  try {
    const id = '11111111-2222-4333-8444-555555555555';
    const imported = registry.create({ projectPath: project, sessionId: id, name: 'trovata', imported: true });
    assert.equal(imported.sessionId, id, 'tiene il suo id: è quello che la fa riprendere');
    assert.equal(imported.imported, true);
    assert.equal(imported.state, 'offline', 'spenta: un processo per guardarla sarebbe uno spreco');
    assert.equal(launches.length, 0, 'e infatti nessun processo è partito');

    // importarla due volte non la duplica
    const again = registry.create({ projectPath: project, sessionId: id, imported: true });
    assert.equal(again.sessionId, id);
    assert.equal(registry.list().length, 1);
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- modalità dei permessi: è della conversazione, non del server ----------
// La regola che conta: il bypass si chiede **aprendo** una chat (lo fa `cc`), e vale per
// quella soltanto. Una ripresa tiene la modalità che ha, e nessun client remoto la cambia.

test('la modalità dei permessi nasce con la chat e si passa a claude', () => {
  const { root, project, registry, launches } = setup('perm-new');
  try {
    const plain = registry.create({ projectPath: project, name: 'normale' });
    const bypass = registry.create({ projectPath: project, name: 'bypass', permissionMode: 'bypassPermissions' });

    assert.equal(plain.permissionMode, 'default', 'senza chiedere niente, la modalità è quella normale');
    assert.equal(bypass.permissionMode, 'bypassPermissions');

    assert.match(launches[0].args.join(' '), /--permission-mode default/);
    assert.match(launches[1].args.join(' '), /--permission-mode bypassPermissions/);
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cc -c: una ripresa tiene la modalità della conversazione, non quella del server', () => {
  const { root, project, config, registry, launches } = setup('perm-resume');
  try {
    const created = registry.create({ projectPath: project, name: 'bypass', permissionMode: 'bypassPermissions' });
    registry.stop(created.sessionId);

    // il transcript esiste: la ripresa passa da --resume
    fs.mkdirSync(path.dirname(created.transcript), { recursive: true });
    fs.writeFileSync(created.transcript, '{"type":"system"}\n');
    registry.start(created.sessionId);

    const resumed = launches.at(-1).args.join(' ');
    assert.match(resumed, new RegExp(`--resume ${created.sessionId}`));
    assert.match(resumed, /--permission-mode bypassPermissions/, 'la ripresa deve restare in bypass: è la stessa conversazione');
    assert.equal(config.permissionMode, 'default', 'e il server resta in modalità normale per le altre');
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('si torna alla modalità normale, e il processo vivo riparte con quella', () => {
  const { root, project, registry, launches } = setup('perm-back');
  try {
    const created = registry.create({ projectPath: project, name: 'bypass', permissionMode: 'bypassPermissions' });
    const before = launches.length;

    const back = registry.setPermissionMode(created.sessionId, 'default');
    assert.equal(back.permissionMode, 'default');
    assert.equal(launches.length, before + 1, 'il processo vivo si riavvia: la modalità si legge solo all\'avvio');
    assert.match(launches.at(-1).args.join(' '), /--permission-mode default/);

    // e resta scritta: sopravvive al processo
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'));
    assert.equal(saved.sessions.find((entry) => entry.sessionId === created.sessionId).permissionMode, 'default');
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('i permessi non si cambiano a una chat che sta lavorando, e una modalità inventata si rifiuta', () => {
  const { root, project, registry } = setup('perm-guard');
  try {
    const created = registry.create({ projectPath: project, name: 'occupata', permissionMode: 'bypassPermissions' });

    assert.throws(() => registry.setPermissionMode(created.sessionId, 'evilMode'), /unrecognized mode/);

    registry.markBusy(created.sessionId, true);
    assert.throws(() => registry.setPermissionMode(created.sessionId, 'default'), /is working/);
    assert.equal(registry.get(created.sessionId).permissionMode, 'bypassPermissions', 'un rifiuto non deve cambiare niente');
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una chat che salta i permessi non si espone per sbaglio: serve il consenso, e si vede', () => {
  const { root, project, registry } = setup('perm-expose');
  try {
    const bypass = registry.create({ projectPath: project, name: 'bypass', permissionMode: 'bypassPermissions' });

    // 1. senza conferma: rifiutata, e non resta esposta lo stesso
    assert.throws(() => registry.setMcpAllowed(bypass.sessionId, true), /skips permissions/);
    assert.throws(() => registry.setMcpAllowed(bypass.sessionId, true), (error) => error.code === 'BYPASS_NEEDS_CONFIRM');
    assert.equal(registry.get(bypass.sessionId).mcpAllowed, false);
    assert.equal(registry.get(bypass.sessionId).mcpReachable, false);
    assert.equal(registry.mcpAllowed().length, 0, 'e non compare nemmeno nell elenco che vede il client');

    // 2. con la conferma sbagliata: rifiutata
    assert.throws(() => registry.setMcpAllowed(bypass.sessionId, true, { confirm: 'un altro nome' }), /explicit confirmation/);

    // 3. con la conferma che ripete il nome: esposta, e il consenso resta scritto con la data
    const exposed = registry.setMcpAllowed(bypass.sessionId, true, { confirm: 'bypass' });
    assert.equal(exposed.mcpAllowed, true);
    assert.equal(exposed.mcpReachable, true);
    assert.ok(exposed.mcpBypassAt, 'il consenso è datato: si sa da quando quella combinazione è accesa');
    assert.deepEqual(registry.mcpAllowed().map((s) => s.sessionId), [bypass.sessionId]);

    // 4. la revoca è un gesto solo, e toglie tutto
    const revoked = registry.setMcpAllowed(bypass.sessionId, false);
    assert.equal(revoked.mcpAllowed, false);
    assert.equal(revoked.mcpReachable, false);
    assert.equal(revoked.mcpBypassAt, null);
    assert.equal(registry.mcpAllowed().length, 0);

    // una chat normale si espone senza storie, e senza consenso da registrare
    const plain = registry.create({ projectPath: project, name: 'normale' });
    const plainExposed = registry.setMcpAllowed(plain.sessionId, true);
    assert.equal(plainExposed.mcpReachable, true);
    assert.equal(plainExposed.mcpBypassAt, null);
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il consenso vale per quella configurazione: cambiare modalità lo fa cadere', () => {
  const { root, project, registry } = setup('perm-consent');
  try {
    const chat = registry.create({ projectPath: project, name: 'bypass', permissionMode: 'bypassPermissions' });
    registry.setMcpAllowed(chat.sessionId, true, { confirm: 'bypass' });
    assert.equal(registry.get(chat.sessionId).mcpReachable, true);

    // si torna alla modalità normale: il consenso non ha più a cosa riferirsi, e cade
    const back = registry.setPermissionMode(chat.sessionId, 'default');
    assert.equal(back.mcpBypassAt, null, 'il consenso non si eredita');
    assert.equal(back.mcpAllowed, true, 'l esposizione scelta dal proprietario resta');
    assert.equal(back.mcpReachable, true, 'e adesso vale come chat normale, con i suoi dialoghi');

    // e tornare in bypass con l'esposizione accesa è ancora rifiutato: tre gesti, nessuno silenzioso
    assert.throws(() => registry.setPermissionMode(chat.sessionId, 'bypassPermissions'), /exposed to ChatGPT/);

    // il giro completo: si toglie l'esposizione, si mette il bypass, si riaccende con il consenso
    registry.setMcpAllowed(chat.sessionId, false);
    registry.setPermissionMode(chat.sessionId, 'bypassPermissions');
    assert.equal(registry.get(chat.sessionId).mcpReachable, false, 'in bypass senza consenso non è raggiungibile');
    registry.setMcpAllowed(chat.sessionId, true, { confirm: 'bypass' });
    assert.equal(registry.get(chat.sessionId).mcpReachable, true);
    assert.ok(registry.get(chat.sessionId).mcpBypassAt);

    // rimettere la stessa modalità non è un cambiamento, e non fa cadere niente
    registry.setPermissionMode(chat.sessionId, 'bypassPermissions');
    assert.ok(registry.get(chat.sessionId).mcpBypassAt, 'stessa modalità: il consenso resta');
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un registro manomesso non espone una chat in bypass: la congiunzione si applica in lettura', () => {
  // La difesa in profondità: il controllo in scrittura c'è, ma il valore che i tool MCP leggono
  // si ricalcola **a ogni lettura**. Un file modificato a mano — o uno stato rimasto da una
  // versione precedente, dove `mcpAllowed` e bypass potevano convivere — non passa.
  const { root, project, config } = setup('perm-tamper');
  const file = path.join(root, 'sessions.json');
  try {
    const registry = createRegistry({ config, spawn: fakeSpawn([]) });
    const chat = registry.create({ projectPath: project, name: 'bypass', permissionMode: 'bypassPermissions' });
    registry.closeAll();

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = saved.sessions.find((item) => item.sessionId === chat.sessionId);
    entry.mcpAllowed = true;              // l'interruttore acceso a mano nel file
    delete entry.mcpBypassAt;             // nessun consenso
    fs.writeFileSync(file, JSON.stringify(saved));

    const reopened = createRegistry({ config, spawn: fakeSpawn([]) });
    const view = reopened.get(chat.sessionId);
    assert.equal(view.mcpAllowed, true, 'l interruttore sul disco dice acceso');
    assert.equal(view.mcpReachable, false, 'ma non è raggiungibile: manca il consenso');
    assert.deepEqual(reopened.mcpAllowed(), [], 'e l elenco che il client MCP vede è vuoto');
    reopened.closeAll();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── organizzazione: stella, sezione, chiave del progetto ─────────────────────
// Organizzare l'elenco non deve poter toccare l'identità di una conversazione: id, cartella e
// transcript restano quelli. Questi test tengono ferma quella promessa.

test('la stella e la sezione si scrivono, si rileggono, e non toccano l\'identità', () => {
  const { root, project, registry } = setup('organize');
  try {
    const created = registry.create({ projectPath: project, name: 'da organizzare' });
    assert.equal(created.favorite, false, 'una chat nuova non è fissata');
    assert.equal(created.label, null);
    assert.equal(created.projectKey, pathKey(project), 'la chiave arriva già calcolata');

    const starred = registry.setFavorite(created.sessionId, true);
    assert.equal(starred.favorite, true);
    assert.equal(starred.sessionId, created.sessionId, 'l\'id non cambia');
    assert.equal(starred.projectPath, created.projectPath, 'la cartella non cambia');
    assert.equal(starred.transcript, created.transcript, 'il transcript non si sposta');

    assert.equal(registry.setLabel(created.sessionId, '  lavoro  ').label, 'lavoro');
    assert.equal(registry.setLabel(created.sessionId, '').label, null, 'svuotare la sezione la toglie');
    assert.equal(registry.setLabel(created.sessionId, 'x'.repeat(80)).label.length, 30, 'una sezione non è un tema');

    // Il tipo si controlla al confine: `String({})` non e' un errore, e' «[object Object]».
    assert.throws(() => registry.setLabel(created.sessionId, { a: 1 }), /must be text/);
    assert.throws(() => registry.setLabel(created.sessionId, 42), /must be text/);
    assert.equal(registry.get(created.sessionId).label, 'x'.repeat(30), 'un rifiuto non deve scrivere niente');

    assert.throws(() => registry.setFavorite('non-esiste', true), /unknown session/);
    assert.throws(() => registry.setLabel('non-esiste', 'x'), /unknown session/);
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stella e sezione sopravvivono al riavvio del server', () => {
  const { root, project, registry } = setup('organize-restart');
  try {
    const created = registry.create({ projectPath: project, name: 'memoria' });
    registry.setFavorite(created.sessionId, true);
    registry.setLabel(created.sessionId, 'cliente');

    // Lo stesso file, un registro nuovo: è quello che succede a ogni `rc start`.
    const reopened = createRegistry({ config: { ...loadConfig({}), allowedRoots: [root], stateFile: path.join(root, 'sessions.json'), projectsRoot: path.join(root, 'projects'), claudeArgs: [], permissionMode: 'default' }, spawn: fakeSpawn([]) });
    const after = reopened.get(created.sessionId);
    assert.equal(after.favorite, true);
    assert.equal(after.label, 'cliente');
    assert.equal(after.name, 'memoria');
    reopened.closeAll();
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── «MCP automatico controllato» ─────────────────────────────────────────────
// L'interruttore che riduce le approvazioni ripetitive senza toccare i confini. Le due cose da
// tenere ferme: nasce spento, e non convive con il bypass — che spegnerebbe l'hook, cioè
// esattamente il posto dove il criterio decide.

test('l\'automatico nasce spento, e la conversazione può dire la sua', () => {
  const { root, project, registry } = setup('auto-default');
  try {
    const created = registry.create({ projectPath: project, name: 'normale' });
    assert.equal(created.autoApprove, null, 'nessuno l\'ha acceso: vale quello del progetto (niente)');
    assert.equal(registry.setAutoApprove(created.sessionId, true).autoApprove, true);
    assert.equal(registry.setAutoApprove(created.sessionId, false).autoApprove, false, 'e si spegne dalla stessa porta');
    assert.equal(registry.get(created.sessionId).autoApprove, false, 'lo «spento» della conversazione resta scritto');
    assert.throws(() => registry.setAutoApprove('inesistente', true), /unknown session/);
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il bypass e l\'automatico non stanno accesi insieme: in bypass l\'hook non gira', () => {
  const { root, project, registry } = setup('auto-bypass');
  try {
    const bypass = registry.create({ projectPath: project, name: 'bypass', permissionMode: 'bypassPermissions' });
    assert.throws(() => registry.setAutoApprove(bypass.sessionId, true), /skips permissions/);
    assert.equal(registry.get(bypass.sessionId).autoApprove, null, 'il rifiuto non deve accenderlo lo stesso');

    // L'altro verso: acceso l'automatico, non si salta tutto senza spegnerlo prima.
    const plain = registry.create({ projectPath: project, name: 'auto' });
    registry.setAutoApprove(plain.sessionId, true);
    assert.throws(() => registry.setPermissionMode(plain.sessionId, 'bypassPermissions'), /controlled automatic MCP/);
    assert.equal(registry.get(plain.sessionId).permissionMode, 'default');
    assert.equal(registry.get(plain.sessionId).autoApprove, true, 'un rifiuto non cambia niente');

    registry.setAutoApprove(plain.sessionId, false);
    assert.equal(registry.setPermissionMode(plain.sessionId, 'bypassPermissions').permissionMode, 'bypassPermissions', 'spento l\'automatico, il bypass è di nuovo una scelta possibile');
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('l\'interruttore dell\'automatico sopravvive al riavvio del server', () => {
  const { root, project, registry } = setup('auto-restart');
  try {
    const created = registry.create({ projectPath: project, name: 'memoria' });
    registry.setAutoApprove(created.sessionId, true);
    const reopened = createRegistry({ config: { ...loadConfig({}), allowedRoots: [root], stateFile: path.join(root, 'sessions.json'), projectsRoot: path.join(root, 'projects'), claudeArgs: [], permissionMode: 'default' }, spawn: fakeSpawn([]) });
    assert.equal(reopened.get(created.sessionId).autoApprove, true);
    assert.equal(reopened.get(created.sessionId).permissionMode, 'default', 'e non ha toccato la modalità dei permessi');
    reopened.closeAll();
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il consenso ad alto privilegio scade, e archiviare lo fa cadere', () => {
  const { root, project, config, launches } = setup('perm-scade');
  let clock = Date.parse('2026-11-03T20:00:00.000Z');
  try {
    const registry = createRegistry({ config: { ...config, mcpBypassTtlSeconds: 3_600 }, spawn: fakeSpawn(launches), now: () => clock });
    const chat = registry.create({ projectPath: project, name: 'bypass', permissionMode: 'bypassPermissions' });
    registry.setMcpAllowed(chat.sessionId, true, { confirm: 'bypass' });
    assert.equal(registry.get(chat.sessionId).mcpReachable, true);

    // dentro l'ora: vale
    clock += 59 * 60_000;
    assert.equal(registry.get(chat.sessionId).mcpReachable, true, 'un consenso fresco vale');

    // passata l'ora: **scade da solo**, e non c'è niente da riscrivere per farlo succedere
    clock += 2 * 60_000;
    assert.equal(registry.get(chat.sessionId).mcpReachable, false, 'scaduto non è più raggiungibile');
    assert.equal(registry.get(chat.sessionId).mcpAllowed, true, 'ma l interruttore resta com era');
    assert.ok(registry.get(chat.sessionId).mcpBypassAt, 'e la data resta: si sa quando era stato dato');
    assert.deepEqual(registry.mcpAllowed(), [], 'e l elenco che vede il client è vuoto');

    // e archiviare fa cadere il consenso, così riprendere dall'archivio non lo riaccende
    const again = createRegistry({ config, spawn: fakeSpawn(launches) });
    const other = again.create({ projectPath: project, name: 'bypass 2', permissionMode: 'bypassPermissions' });
    again.setMcpAllowed(other.sessionId, true, { confirm: 'bypass 2' });
    assert.equal(again.get(other.sessionId).mcpReachable, true);
    again.setArchived(other.sessionId, true);
    assert.equal(again.get(other.sessionId).mcpBypassAt, null, 'archiviare fa cadere il consenso');
    again.setArchived(other.sessionId, false);
    assert.equal(again.get(other.sessionId).mcpReachable, false, 'e riprendere dall archivio non lo riaccende');
    assert.equal(again.get(other.sessionId).mcpAllowed, true, 'l esposizione normale invece resta');
    again.closeAll();
    registry.closeAll();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un ripristino non riporta indietro un consenso: i privilegi si ridanno a mano', () => {
  const { root, project, registry } = setup('perm-restore');
  try {
    const chat = registry.create({ projectPath: project, name: 'bypass', permissionMode: 'bypassPermissions' });
    registry.setMcpAllowed(chat.sessionId, true, { confirm: 'bypass' });
    assert.equal(registry.get(chat.sessionId).mcpReachable, true);

    const dropped = registry.clearBypassConsents();
    assert.equal(dropped.length, 1, 'il consenso tolto viene detto');
    assert.equal(dropped[0].sessionId, chat.sessionId);
    assert.equal(registry.get(chat.sessionId).mcpBypassAt, null);
    assert.equal(registry.get(chat.sessionId).mcpReachable, false);
    assert.deepEqual(registry.mcpAllowed(), []);
    assert.equal(registry.clearBypassConsents().length, 0, 'e la seconda volta non c è più niente da togliere');
  } finally {
    registry.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
