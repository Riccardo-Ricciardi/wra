import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationOf, describeState, modeOf, projectNameOf, reachOf, stateOf } from '../src/web/core/authorization.mjs';

// Cosa può fare l'agente in una conversazione, e chi può parlarci: due assi che l'interfaccia
// deve saper dire senza confonderli. Sono funzioni pure, quindi si provano qui — ed è il punto:
// la frase che spiega il bypass è **una sola**, e non può divergere fra due schermate.

const chat = (over = {}) => ({ sessionId: 's1', name: 'una chat', projectPath: 'C:\\p\\progetto-01', ...over });
const project = (over = {}) => ({ key: 'c:\\p\\progetto-01', name: 'progetto-01', ...over });

test('senza niente acceso, il modo è normale — e il default deve restare il default', () => {
  assert.equal(modeOf(chat()), 'normal');
  const auth = authorizationOf(chat());
  assert.equal(auth.mode, 'normal');
  assert.equal(auth.name, 'Normale');
  // La modalità normale non ha niente da accettare: è il punto, non una dimenticanza.
  assert.equal(auth.accept, '');
  assert.equal(stateOf(chat()).mark, '');
});

test('l\'automatico si può accendere sulla conversazione o ereditare dal progetto', () => {
  assert.equal(modeOf(chat({ autoApprove: true })), 'auto');
  assert.equal(modeOf(chat(), project({ autoApprove: true })), 'auto');
  assert.equal(authorizationOf(chat(), project({ autoApprove: true })).inherited, true);
  assert.equal(authorizationOf(chat({ autoApprove: true }), project({ autoApprove: true })).inherited, false);
});

test('«non ho deciso» e «qui no» sono due cose diverse, e solo la seconda vince sul progetto', () => {
  // `null` (o assente) vuol dire «non ho deciso»: vale il progetto.
  assert.equal(modeOf(chat({ autoApprove: null }), project({ autoApprove: true })), 'auto');
  assert.equal(modeOf(chat(), project({ autoApprove: true })), 'auto');
  // `false` vuol dire «qui no»: la conversazione si sottrae alla sua cartella, altrimenti non
  // avrebbe modo di farlo.
  assert.equal(modeOf(chat({ autoApprove: false }), project({ autoApprove: true })), 'normal');
  assert.equal(authorizationOf(chat({ autoApprove: false }), project({ autoApprove: true })).mode, 'normal');
});

test('il bypass vince sull\'automatico: dire «automatico» lì sarebbe una bugia comoda', () => {
  assert.equal(modeOf(chat({ permissionMode: 'bypassPermissions', autoApprove: true })), 'bypass');
  assert.equal(modeOf(chat({ permissionMode: 'bypassPermissions' }), project({ autoApprove: true })), 'bypass');
});

test('la frase dell\'automatico dice il confine, e il confine è il nome del progetto', () => {
  const auth = authorizationOf(chat(), project({ name: 'cantiere', autoApprove: true }));
  assert.match(auth.sentence, /Dentro cantiere/);
  assert.match(auth.sentence, /Fuori dal progetto/);
  // Il confine va anche detto in quello che si accetta, altrimenti si accetta una cosa sola.
  assert.match(auth.accept, /cantiere/);
});

test('il nome del progetto si ricava dalla cartella quando il progetto non è in elenco', () => {
  assert.equal(projectNameOf(chat({ projectPath: 'C:\\Users\\x\\Desktop\\il-ponte' })), 'il-ponte');
  assert.equal(projectNameOf(chat({ projectPath: '' })), 'questo progetto');
  assert.equal(projectNameOf(chat(), project({ name: 'scelto' })), 'scelto');
});

test('il bypass dice che non c\'è nessuna richiesta, e cosa si sta accettando', () => {
  const auth = authorizationOf(chat({ permissionMode: 'bypassPermissions' }));
  assert.equal(auth.mode, 'bypass');
  assert.match(auth.sentence, /non chiede mai/);
  // Le tre cose che rendono onesta la frase: i privilegi, l'assenza di avvisi, l'assenza di freni.
  assert.match(auth.accept, /tuoi privilegi/);
  assert.match(auth.accept, /senza chiedere/);
  assert.match(auth.accept, /che lo fermi/);
  // E non deve promettere una sicurezza che non esiste.
  assert.doesNotMatch(auth.accept, /sandbox|isolat|sicur/i);
});

test('nessuna modalità si descrive con una parola che promette più di quello che fa', () => {
  for (const session of [chat(), chat({ autoApprove: true }), chat({ permissionMode: 'bypassPermissions' })]) {
    const auth = authorizationOf(session);
    for (const text of [auth.name, auth.short, auth.sentence, auth.accept]) {
      assert.doesNotMatch(text, /sandbox|automatico e sicuro|controllat[oa] e sicur/i);
    }
  }
});

test('l\'esposizione a ChatGPT è un asse suo, e non ha la forma di un modo', () => {
  const spento = reachOf(chat());
  assert.equal(spento.on, false);
  assert.equal(spento.tone, 'normal');

  const acceso = reachOf(chat({ mcpReachable: true }));
  assert.equal(acceso.on, true);
  assert.equal(acceso.tone, 'reach');
  // Non è `auto` né `bypass`: chi guarda non deve poterli confondere.
  assert.notEqual(acceso.tone, 'auto');
  assert.notEqual(acceso.tone, 'bypass');
});

test('il consenso scaduto si vede: l\'interruttore è acceso ma la conversazione non risponde', () => {
  const scaduto = reachOf(chat({ mcpAllowed: true, mcpReachable: false, mcpBypassAt: '2026-01-01T00:00:00.000Z' }));
  assert.equal(scaduto.on, false);
  assert.equal(scaduto.expired, true);
  assert.match(scaduto.sentence, /scaduto/);
});

test('bypass ed esposto insieme non è la somma degli altri due: è uno stato peggiore, con un nome suo', () => {
  const state = stateOf(chat({ permissionMode: 'bypassPermissions', mcpReachable: true }));
  assert.equal(state.combined, true);
  assert.equal(state.tone, 'combined');
  assert.equal(state.mark, 'bypass + esposto');

  // E non si confonde con il bypass da solo, che resta `bypass`.
  const soloBypass = stateOf(chat({ permissionMode: 'bypassPermissions' }));
  assert.equal(soloBypass.combined, false);
  assert.equal(soloBypass.tone, 'bypass');
  assert.equal(soloBypass.mark, 'bypass');
});

test('la riga che si vede nell\'elenco è corta e non è una spiegazione', () => {
  const marks = [
    stateOf(chat()).mark,
    stateOf(chat({ autoApprove: true })).mark,
    stateOf(chat({ permissionMode: 'bypassPermissions' })).mark,
    stateOf(chat({ permissionMode: 'bypassPermissions', mcpReachable: true })).mark,
  ];
  // `normale` non porta contrassegno: è l'assenza di segno che lo distingue.
  assert.deepEqual(marks, ['', 'auto', 'bypass', 'bypass + esposto']);
});

test('una conversazione che non c\'è non è un modo: è normale, e non fa esplodere niente', () => {
  assert.equal(modeOf(null), 'normal');
  assert.equal(authorizationOf(null).mode, 'normal');
  assert.equal(reachOf(null).on, false);
  assert.equal(stateOf(null).mark, '');
});

test('`describeState` dice la stessa cosa in una riga, per il registro e per i test', () => {
  assert.equal(describeState(chat()), 'Normale');
  assert.equal(describeState(chat(), project({ autoApprove: true })), 'Automatico controllato (dal progetto)');
  assert.equal(
    describeState(chat({ permissionMode: 'bypassPermissions', mcpReachable: true })),
    'Bypass · esposto a ChatGPT',
  );
});

test('una modalità che non conosciamo non diventa un bypass per caso', () => {
  // Il registro è un file, e `permissionMode` accetta una lista chiusa di valori che questa
  // schermata non offre: se ne arriva uno, la lettura non deve **promuovere** la conversazione a
  // un privilegio che nessuno ha chiesto.
  assert.notEqual(modeOf(chat({ permissionMode: 'acceptEdits' })), 'bypass');
  assert.notEqual(modeOf(chat({ permissionMode: 'plan' })), 'bypass');
});

test('`acceptEdits` NON è «Normale»: la schermata non deve dire che chiede tutto', () => {
  // Il difetto che questa milestone esiste per non avere. `acceptEdits` è nella lista chiusa del
  // server e, per `docs/SECURITY.md`, approva da sé letture, modifiche di file e i comandi di
  // filesystem comuni (`mkdir`, `touch`, `mv`, `cp`) dentro la cartella del progetto. Dipingerla
  // come «Normale» vorrebbe dire dire «ogni comando chiede» a una conversazione che modifica file
  // da sola — cioè il caso peggiore mostrato come il meno allarmante.
  assert.equal(modeOf(chat({ permissionMode: 'acceptEdits' })), 'other');
  const auth = authorizationOf(chat({ permissionMode: 'acceptEdits' }));
  assert.equal(auth.name, 'acceptEdits');
  assert.notEqual(auth.tone, 'normal', 'una modalità che non descriviamo non può avere la tinta del default');
  // E non deve contenere la frase della modalità normale.
  assert.doesNotMatch(auth.sentence, /chiede il permesso prima di agire/);
  // Deve dire cosa fa davvero, con le parole della fonte.
  assert.match(auth.sentence, /approva da sé/);
  assert.match(auth.sentence, /mv/);
  assert.match(auth.accept, /senza chiedere/);
});

test('le modalità che non sappiamo descrivere dicono «non lo so», non una supposizione', () => {
  // `plan`, `auto`, `dontAsk`: il server le accetta, `docs/SECURITY.md` non ne descrive gli
  // effetti. Su una schermata che dice cosa può fare l'agente, la risposta onesta è che non lo
  // sappiamo — e la direzione dell'errore è l'allarme, non la calma.
  for (const raw of ['plan', 'auto', 'dontAsk']) {
    const auth = authorizationOf(chat({ permissionMode: raw }));
    assert.equal(auth.mode, 'other', `${raw} doveva essere «other»`);
    assert.equal(auth.known, false);
    assert.match(auth.sentence, /non sa descrivere/);
    assert.notEqual(auth.tone, 'normal');
  }
});

test('`default` e `manual` sono la stessa cosa, e restano «Normale»', () => {
  // `docs/SECURITY.md`: «`default`(= `manual`)». Trattare `manual` come «altro» sarebbe
  // allarmismo gratuito, che è l'altro modo di rendere inutile un avviso.
  assert.equal(modeOf(chat({ permissionMode: 'default' })), 'normal');
  assert.equal(modeOf(chat({ permissionMode: 'manual' })), 'normal');
  assert.equal(modeOf(chat({ permissionMode: null })), 'normal');
});

test('una modalità non descritta non si traveste da automatico né da bypass', () => {
  const altro = stateOf(chat({ permissionMode: 'acceptEdits' }));
  assert.equal(altro.tone, 'other');
  assert.equal(altro.mark, 'acceptEdits');
  assert.notEqual(altro.tone, 'auto');
  assert.notEqual(altro.tone, 'bypass');
  // E il bypass continua a vincere su tutto: se la modalità è `bypassPermissions`, non è «other».
  assert.equal(modeOf(chat({ permissionMode: 'bypassPermissions' })), 'bypass');
});

test('il consenso scaduto e la conversazione archiviata sono due ragioni diverse', () => {
  // Dire «il consenso è scaduto» a una conversazione archiviata è la direzione giusta con la
  // ragione sbagliata, e una schermata che sbaglia le ragioni si smette di crederle.
  const archiviata = reachOf(chat({ mcpAllowed: true, mcpReachable: false, mcpBypassAt: '2026-11-03T00:00:00.000Z', archived: true }));
  assert.equal(archiviata.archived, true);
  assert.equal(archiviata.expired, false);
  assert.match(archiviata.sentence, /archiviata/);
});
