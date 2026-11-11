import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createRegistry } from '../src/host/session-registry.mjs';
import { createTurnCoordinator } from '../src/host/turn-coordinator.mjs';
import { createSelections } from '../src/mcp/selection.mjs';
import { createMcpTools } from '../src/mcp/tools.mjs';

// Lo switch MCP con client simulati: due connessioni con clientId diversi, ACL per chat,
// selezione separata, e il criterio: "autorizzarne una sola, e i messaggi vanno solo li'".

function fakeSpawn() {
  return ({ projectDir }) => ({
    projectDir,
    pid: 1,
    exited: false,
    write() {},
    resize() {},
    kill() {},
    onData() { return () => {}; },
    onExit() { return () => {}; },
  });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-mcptools-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project);
  const config = { ...loadConfig({}), allowedRoots: [root], stateFile: path.join(root, 'sessions.json'), projectsRoot: path.join(root, 'projects'), maxSessions: 6 };
  const registry = createRegistry({ config, spawn: fakeSpawn() });
  const coordinator = createTurnCoordinator({
    config,
    registry,
    run: async ({ pty, message }) => ({ status: 'done', reply: `RICEVUTO ${message} (${pty.sessionId.slice(0, 4)})`, transcript: pty.transcriptPath, elapsedMs: 5 }),
  });
  const selections = createSelections();
  const a = registry.create({ projectPath: project, name: 'A' });
  const b = registry.create({ projectPath: project, name: 'B' });
  return { root, registry, coordinator, selections, config, project, a, b };
}

const toolsFor = (setupResult, clientId) => createMcpTools({
  config: setupResult.config,
  registry: setupResult.registry,
  coordinator: setupResult.coordinator,
  selections: setupResult.selections,
  clientId,
});

test("si vede solo ciò che è autorizzato: list_chats non mostra le chat spente", () => {
  const s = setup();
  try {
    const tools = toolsFor(s, 'client-1');
    return tools.list_chats.run({}).then((result) => {
      assert.equal(result.structuredContent.chats.length, 0, 'nessuna chat autorizzata');
      assert.match(result.content[0].text, /No chats are allowed/);

      s.registry.setMcpAllowed(s.a.sessionId, true);
      return tools.list_chats.run({}).then((after) => {
        assert.deepEqual(after.structuredContent.chats.map((chat) => chat.session_id), [s.a.sessionId]);
      });
    });
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('select_chat rifiuta una chat non autorizzata, anche conoscendone l id', async () => {
  const s = setup();
  try {
    const tools = toolsFor(s, 'client-1');
    s.registry.setMcpAllowed(s.a.sessionId, true);

    const denied = await tools.select_chat.run({ session_id: s.b.sessionId });
    assert.equal(denied.structuredContent.status, 'error');
    assert.match(denied.content[0].text, /not authorized/);

    const ok = await tools.select_chat.run({ session_id: s.a.sessionId });
    assert.equal(ok.structuredContent.status, 'ok');
    assert.equal(s.selections.get('client-1'), s.a.sessionId);
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("talk usa la chat scelta da quel client, e rifiuta un id non autorizzato", async () => {
  const s = setup();
  try {
    const tools1 = toolsFor(s, 'client-1');
    const tools2 = toolsFor(s, 'client-2');
    s.registry.setMcpAllowed(s.a.sessionId, true);
    s.registry.setMcpAllowed(s.b.sessionId, false);

    // senza selezione: errore con l'elenco
    const none = await tools1.talk.run({ message: 'ciao' });
    assert.equal(none.structuredContent.status, 'error');
    assert.match(none.content[0].text, /select_chat/);

    await tools1.select_chat.run({ session_id: s.a.sessionId });
    const result = await tools1.talk.run({ message: 'ciao', wait_seconds: 5 });
    assert.equal(result.structuredContent.status, 'done');
    assert.equal(result.structuredContent.sessionId, s.a.sessionId);
    assert.match(result.structuredContent.reply, /RICEVUTO ciao/);

    // forzare una chat non autorizzata: rifiutato
    const forced = await tools1.talk.run({ message: 'forzato', session_id: s.b.sessionId });
    assert.equal(forced.structuredContent.status, 'error');
    assert.match(forced.content[0].text, /not authorized/);

    // il secondo client non eredita la scelta del primo
    assert.equal(s.selections.get('client-2'), null);
    const other = await tools2.talk.run({ message: 'sono due' });
    assert.equal(other.structuredContent.status, 'error', 'senza selezione il secondo client non parla');
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('due client, due selezioni: ognuno parla con la sua, senza spostarsi a vicenda', async () => {
  const s = setup();
  try {
    const tools1 = toolsFor(s, 'client-1');
    const tools2 = toolsFor(s, 'client-2');
    s.registry.setMcpAllowed(s.a.sessionId, true);
    s.registry.setMcpAllowed(s.b.sessionId, true);

    await tools1.select_chat.run({ session_id: s.a.sessionId });
    await tools2.select_chat.run({ session_id: s.b.sessionId });

    const r1 = await tools1.talk.run({ message: 'per A', wait_seconds: 5 });
    const r2 = await tools2.talk.run({ message: 'per B', wait_seconds: 5 });

    assert.equal(r1.structuredContent.sessionId, s.a.sessionId);
    assert.equal(r2.structuredContent.sessionId, s.b.sessionId);
    assert.equal(s.selections.get('client-1'), s.a.sessionId, 'la scelta del primo non si sposta');
    assert.equal(s.selections.get('client-2'), s.b.sessionId);
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('lo stesso request_id non manda due messaggi', async () => {
  const s = setup();
  try {
    const tools = toolsFor(s, 'client-1');
    s.registry.setMcpAllowed(s.a.sessionId, true);
    await tools.select_chat.run({ session_id: s.a.sessionId });

    const first = await tools.talk.run({ message: 'una volta', request_id: 'r-1', wait_seconds: 5 });
    const again = await tools.talk.run({ message: 'una volta', request_id: 'r-1', wait_seconds: 5 });
    assert.equal(first.structuredContent.turnId, again.structuredContent.turnId);
    assert.equal(again.structuredContent.reused, true);

    const status = await tools.get_turn_status.run({ request_id: 'r-1' });
    assert.equal(status.structuredContent.status, 'done');
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('revocare il permesso ferma le richieste nuove, anche a selezione già fatta', async () => {
  const s = setup();
  try {
    s.registry.setMcpAllowed(s.a.sessionId, true);
    const tools = toolsFor(s, 'client-1');
    await tools.select_chat.run({ session_id: s.a.sessionId });

    const before = await tools.talk.run({ message: 'prima', wait_seconds: 5 });
    assert.equal(before.structuredContent.status, 'done', 'con il permesso acceso si parla');

    // La selezione resta (è del client), ma il permesso no: la richiesta dopo non passa.
    s.registry.setMcpAllowed(s.a.sessionId, false);
    const after = await tools.talk.run({ message: 'dopo', wait_seconds: 5 });
    assert.equal(after.structuredContent.status, 'error');
    assert.match(String(after.structuredContent.error), /not authorized/);
    assert.equal(s.coordinator.depth(s.a.sessionId), 0, 'e non è nemmeno entrata in coda');
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('cambiare selezione a metà turno non sposta la richiesta già accettata', async () => {
  const s = setup();
  try {
    s.registry.setMcpAllowed(s.a.sessionId, true);
    s.registry.setMcpAllowed(s.b.sessionId, true);
    const tools = toolsFor(s, 'client-1');
    await tools.select_chat.run({ session_id: s.a.sessionId });

    // Un turno che dura: nel frattempo il client cambia destinazione.
    const inFlight = tools.talk.run({ message: 'resta su A', wait_seconds: 5 });
    await tools.select_chat.run({ session_id: s.b.sessionId });
    const done = await inFlight;

    // la risposta arriva dalla chat A: il motore finto firma la risposta con l'id della sessione
    assert.match(String(done.structuredContent.reply ?? ''), new RegExp(s.a.sessionId.slice(0, 4)), `la risposta viene da A: ${done.structuredContent.reply}`);
    assert.equal(done.structuredContent.sessionId, s.a.sessionId, 'il bersaglio è congelato all accettazione');
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('a coda piena la risposta MCP lo dice, invece di sparire', async () => {
  const s = setup();
  try {
    s.registry.setMcpAllowed(s.a.sessionId, true);
    // Un motore lento e un tetto basso: è l'unico modo di vedere la coda riempirsi davvero.
    const slow = createTurnCoordinator({
      config: { ...s.config, maxQueue: 2, pollMs: 20, settleMs: 20 },
      registry: s.registry,
      run: async ({ pty, message }) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { status: 'done', reply: `RICEVUTO ${message} (${pty.sessionId.slice(0, 4)})`, elapsedMs: 400 };
      },
    });
    const tools = createMcpTools({ config: s.config, registry: s.registry, coordinator: slow, selections: s.selections, clientId: 'client-1' });
    await tools.select_chat.run({ session_id: s.a.sessionId });

    // Sei richieste insieme: una gira, due in coda, le altre non devono sparire in silenzio.
    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, i) => tools.talk.run({ message: `richiesta ${i}`, wait_seconds: 5 })),
    );
    const refused = answers.filter((answer) => answer.structuredContent.status === 'error');
    assert.ok(refused.length >= 2, `rifiutate: ${refused.length} su 6`);
    assert.match(String(refused[0].structuredContent.error), /queue is full/);
    assert.ok(String(refused[0].content[0].text).length > 0, 'e c è anche un testo leggibile per il modello');
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('due client non si vedono la selezione, nemmeno puntando la stessa chat', async () => {
  const s = setup();
  try {
    s.registry.setMcpAllowed(s.a.sessionId, true);
    const one = toolsFor(s, 'client-1');
    const two = toolsFor(s, 'client-2');

    await one.select_chat.run({ session_id: s.a.sessionId });
    assert.equal(s.selections.get('client-1'), s.a.sessionId);
    assert.equal(s.selections.get('client-2'), null, 'il secondo non eredita niente');

    // Il secondo, senza selezione, non deve indovinare: riceve l'elenco e la richiesta di scegliere.
    const lost = await two.talk.run({ message: 'a chi parlo?', wait_seconds: 5 });
    assert.equal(lost.structuredContent.status, 'error');
    assert.equal(lost.structuredContent.error, 'no chat selected');
    assert.equal(s.coordinator.depth(s.a.sessionId), 0, 'e non ha parlato con nessuno');
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// I turni lunghi: quello che il client legge quando la finestra di ascolto finisce.
//
// Il difetto vero, trovato nel giornale dei turni (`state: "timeout"`, `reply: null`,
// `error: null` a 600 secondi esatti): il client leggeva «Errore: null». Non un motivo, non il
// parziale — niente. Questi casi prendono quella riga.
// ---------------------------------------------------------------------------

test('un turno scaduto dice cosa è successo e porta il parziale, mai «Errore: null»', async () => {
  const s = setup();
  try {
    s.registry.setMcpAllowed(s.a.sessionId, true);
    // Un motore che non finisce mai, con il tetto a zero: è il caso del turno scaduto.
    const stalling = createTurnCoordinator({
      config: { ...s.config, turnHardMs: 0 },
      registry: s.registry,
      run: async () => ({ status: 'in_progress', transcript: '/t.jsonl', partial: 'quello che aveva già scritto', offset: 1, tools: [], ended: false, elapsedMs: 5 }),
    });
    const tools = createMcpTools({ config: s.config, registry: s.registry, coordinator: stalling, selections: s.selections, clientId: 'client-1' });

    const result = await tools.talk.run({ message: 'fai una cosa lunga', session_id: s.a.sessionId, wait_seconds: 5 });

    assert.equal(result.structuredContent.status, 'timeout');
    assert.doesNotMatch(result.content[0].text, /null/, 'la parola «null» non deve arrivare al client');
    assert.match(result.content[0].text, /quello che aveva già scritto/, 'il parziale è la cosa utile');
    assert.ok(result.structuredContent.error, 'e il motivo c\'è');
    assert.equal(result.structuredContent.partial, 'quello che aveva già scritto');
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('senza turn_id né request_id, lo stato recupera l ultimo turno della chat scelta', async () => {
  const s = setup();
  try {
    s.registry.setMcpAllowed(s.a.sessionId, true);
    const tools = toolsFor(s, 'client-1');
    await tools.select_chat.run({ session_id: s.a.sessionId });

    const first = await tools.talk.run({ message: 'ciao', wait_seconds: 5 });
    assert.equal(first.structuredContent.status, 'done');

    // Quello che fa un client che ha perso gli id: una connessione nuova, nessun `turnId`.
    const recovered = await tools.get_turn_status.run({});
    assert.equal(recovered.structuredContent.status, 'done');
    assert.equal(recovered.structuredContent.reply, first.structuredContent.reply);
    assert.equal(recovered.structuredContent.turnId, first.structuredContent.turnId);
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('un attesa più lunga del tetto si accorcia, non si rifiuta', async () => {
  const s = setup();
  try {
    s.registry.setMcpAllowed(s.a.sessionId, true);
    const tools = toolsFor(s, 'client-1');
    await tools.select_chat.run({ session_id: s.a.sessionId });

    // 600 è il massimo dello schema; il tetto vero (`maxWaitSeconds`, 90 di default) si applica
    // clampando. Un rifiuto lascerebbe il client senza niente da leggere.
    const started = Date.now();
    const result = await tools.talk.run({ message: 'ciao', wait_seconds: 600 });
    assert.equal(result.structuredContent.status, 'done');
    assert.ok(Date.now() - started < 60_000, 'non ha aspettato i 600 secondi chiesti');
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// La chat che salta i permessi, vista da un client MCP.
//
// È la modalità ad alto privilegio: un client remoto pilota una conversazione in cui l'agente
// non chiede mai. Il controllo che conta è che **l'interruttore da solo non basti** — se bastasse,
// una chat in bypass sarebbe raggiungibile per il solo fatto che qualcuno ha lasciato acceso
// «Consenti a ChatGPT» prima di metterla in bypass.
// ---------------------------------------------------------------------------

test('una chat in bypass non è raggiungibile da MCP senza il consenso, e lo diventa con il consenso', async () => {
  const s = setup();
  try {
    const bypass = s.registry.create({ projectPath: s.project, name: 'bypass', permissionMode: 'bypassPermissions' });
    const tools = toolsFor(s, 'client-1');

    // 1. senza consenso: non è nell'elenco, non si sceglie, non si parla
    assert.deepEqual((await tools.list_chats.run({})).structuredContent.chats, []);
    const picked = await tools.select_chat.run({ session_id: bypass.sessionId });
    assert.equal(picked.structuredContent.status, 'error');
    assert.match(picked.content[0].text, /not authorized/);
    const refused = await tools.talk.run({ message: 'ciao', session_id: bypass.sessionId, wait_seconds: 5 });
    assert.equal(refused.structuredContent.status, 'error');
    assert.equal(s.coordinator.depth(bypass.sessionId), 0, 'e non ha parlato con nessuno');

    // 2. con il consenso: entra nell'elenco, si sceglie, e il turno parte
    s.registry.setMcpAllowed(bypass.sessionId, true, { confirm: 'bypass' });
    const listed = await tools.list_chats.run({});
    assert.deepEqual(listed.structuredContent.chats.map((c) => c.session_id), [bypass.sessionId]);
    assert.match(listed.content[0].text, /PERMISSIONS SKIPPED/, 'e il client sa a cosa sta parlando');
    assert.equal((await tools.select_chat.run({ session_id: bypass.sessionId })).structuredContent.status, 'ok');
    const spoken = await tools.talk.run({ message: 'fai una cosa', wait_seconds: 5 });
    assert.equal(spoken.structuredContent.status, 'done');

    // 3. la revoca vale dalla richiesta successiva, senza riavvii
    s.registry.setMcpAllowed(bypass.sessionId, false);
    assert.deepEqual((await tools.list_chats.run({})).structuredContent.chats, []);
    const after = await tools.talk.run({ message: 'ancora', session_id: bypass.sessionId, wait_seconds: 5 });
    assert.equal(after.structuredContent.status, 'error');
    assert.equal(s.coordinator.depth(bypass.sessionId), 0, 'il secondo messaggio non è nemmeno entrato in coda');
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('un registro manomesso non apre la porta: l interruttore acceso a mano non basta', async () => {
  // Il caso che il resto della suite non tocca: `mcpAllowed` **acceso** e nessun consenso. È lo
  // stato che si ottiene scrivendo il file a mano, o riusandone uno di una versione precedente,
  // quando le due cose potevano convivere. Il controllo in scrittura non lo vede — qui si prova
  // quello in **lettura**, che è l'ultima porta prima del client.
  const s = setup();
  let reopened = null;
  try {
    const bypass = s.registry.create({ projectPath: s.project, name: 'bypass', permissionMode: 'bypassPermissions' });
    s.registry.closeAll();

    const saved = JSON.parse(fs.readFileSync(s.config.stateFile, 'utf8'));
    const entry = saved.sessions.find((item) => item.sessionId === bypass.sessionId);
    entry.mcpAllowed = true;
    delete entry.mcpBypassAt;
    fs.writeFileSync(s.config.stateFile, JSON.stringify(saved));

    reopened = createRegistry({ config: s.config, spawn: fakeSpawn() });
    const view = reopened.get(bypass.sessionId);
    assert.equal(view.mcpAllowed, true, 'l interruttore sul disco dice acceso');
    assert.equal(view.mcpReachable, false, 'ma non è raggiungibile: manca il consenso');

    const tools = createMcpTools({ config: s.config, registry: reopened, coordinator: s.coordinator, selections: s.selections, clientId: 'client-1' });
    assert.deepEqual((await tools.list_chats.run({})).structuredContent.chats, [], 'non compare nell elenco');
    const refused = await tools.talk.run({ message: 'ciao', session_id: bypass.sessionId, wait_seconds: 5 });
    assert.equal(refused.structuredContent.status, 'error', 'e non si parla nemmeno nominandola');
    assert.match(refused.content[0].text, /not authorized/);
  } finally {
    reopened?.closeAll();
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('la revoca vale anche per le LETTURE: un turno di una chat tolta non si legge più', async () => {
  // Il buco che una revisione ha trovato: `get_turn_status` risolveva il turno senza richiedere
  // che la chat fosse **ancora** raggiungibile. La revoca valeva per le richieste nuove e non per
  // chi aveva già il `turnId` — cioè il contrario di «revocabile».
  const s = setup();
  try {
    const bypass = s.registry.create({ projectPath: s.project, name: 'bypass', permissionMode: 'bypassPermissions' });
    s.registry.setMcpAllowed(bypass.sessionId, true, { confirm: 'bypass' });
    const tools = toolsFor(s, 'client-1');
    await tools.select_chat.run({ session_id: bypass.sessionId });

    const turn = await tools.talk.run({ message: 'ciao', request_id: 'r-lettura', wait_seconds: 5 });
    assert.equal(turn.structuredContent.status, 'done');
    const turnId = turn.structuredContent.turnId;
    assert.equal((await tools.get_turn_status.run({ turn_id: turnId })).structuredContent.status, 'done');

    // si revoca
    s.registry.setMcpAllowed(bypass.sessionId, false);

    // e adesso non si legge più da **nessuna** delle tre strade
    for (const [nome, args] of [['turn_id', { turn_id: turnId }], ['request_id', { request_id: 'r-lettura' }], ['senza id', {}]]) {
      const after = await tools.get_turn_status.run(args);
      assert.equal(after.structuredContent.status, 'error', `con ${nome} la risposta si legge ancora`);
      assert.equal(after.structuredContent.error, 'turn not found', 'e non deve nemmeno dire che esisteva');
    }
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('una request_id già spesa da un altra chat non restituisce quella risposta', async () => {
  // La `request_id` la sceglie il client: senza questo controllo, riusandone una già spesa il
  // coordinatore restituisce **quel** turno — cioè la risposta di una conversazione che questo
  // client non ha nessun diritto di leggere.
  const s = setup();
  try {
    s.registry.setMcpAllowed(s.a.sessionId, true);
    s.registry.setMcpAllowed(s.b.sessionId, true);
    const tools = toolsFor(s, 'client-1');

    const first = await tools.talk.run({ message: 'per A', session_id: s.a.sessionId, request_id: 'stessa', wait_seconds: 5 });
    assert.equal(first.structuredContent.status, 'done');
    assert.match(String(first.structuredContent.reply), /\(.{4}\)/, 'la risposta di A porta il segno di A');

    const second = await tools.talk.run({ message: 'per B', session_id: s.b.sessionId, request_id: 'stessa', wait_seconds: 5 });
    assert.equal(second.structuredContent.status, 'error');
    assert.match(second.content[0].text, /already been used/);
    assert.equal(second.structuredContent.reply, undefined, 'e non porta con sé la risposta di A');
    assert.equal(s.coordinator.depth(s.b.sessionId), 0, 'né ha fatto partire un turno su B');
  } finally {
    s.registry.closeAll();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
