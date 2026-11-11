import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../src/web/state/api.mjs';
import { createSocket, TOKEN_RIFIUTATO } from '../src/web/state/socket.mjs';

// Il trasporto, provato senza un server e senza un browser. Prima non si poteva: `api()` leggeva
// il token da un globale e `connect()` chiamava quattro funzioni di disegno. Adesso il token è
// iniettato, `fetch` è un parametro, e il websocket è un oggetto che si può finto.

// ── le rotte ────────────────────────────────────────────────────────────────

const risposta = (status, corpo) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => corpo,
});

test('il token viaggia su ogni richiesta, e il corpo solo dove serve', async () => {
  const viste = [];
  const { api } = createApi({
    tokenOf: () => 'segreto',
    fetchImpl: async (route, options) => { viste.push({ route, options }); return risposta(200, { ok: true }); },
  });
  await api('/local/sessions');
  await api('/local/sessions/x/rename', { method: 'POST', body: { name: 'nuovo' } });

  assert.equal(viste[0].options.headers['x-cc-remote-token'], 'segreto');
  assert.equal(viste[0].options.body, undefined, 'una GET non deve avere un corpo');
  assert.equal(viste[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(viste[1].options.body), { name: 'nuovo' });
  assert.match(viste[1].options.headers['content-type'], /json/);
});

test('l\'errore del server arriva all\'utente con le sue parole', async () => {
  const { api } = createApi({
    tokenOf: () => 'x',
    fetchImpl: async () => risposta(400, { error: 'questa chat salta i permessi: riportala alla modalità normale' }),
  });
  // La frase del server è la spiegazione che si mostra: riscriverla qui vorrebbe dire averne due.
  await assert.rejects(() => api('/local/x', { method: 'POST', body: {} }),
    /riportala alla modalità normale/);
});

test('un errore senza spiegazione non diventa «undefined»', async () => {
  const { api } = createApi({ tokenOf: () => 'x', fetchImpl: async () => risposta(500, null) });
  await assert.rejects(() => api('/local/x'), /errore 500/);
});

test('il token si legge a ogni chiamata, non una volta sola', async () => {
  // Un token che cambia (si rientra, si gira la chiave) deve valere dalla chiamata dopo.
  let token = 'primo';
  const visti = [];
  const { api } = createApi({
    tokenOf: () => token,
    fetchImpl: async (_route, options) => { visti.push(options.headers['x-cc-remote-token']); return risposta(200, {}); },
  });
  await api('/a');
  token = 'secondo';
  await api('/b');
  assert.deepEqual(visti, ['primo', 'secondo']);
});

// ── il websocket ────────────────────────────────────────────────────────────

/** Un websocket finto: registra gli ascoltatori e lascia che il test li chiami. */
function fintoSocket() {
  const ascoltatori = new Map();
  return {
    readyState: 0,
    inviati: [],
    addEventListener: (tipo, fn) => ascoltatori.set(tipo, fn),
    send(dati) { this.inviati.push(JSON.parse(dati)); },
    close() { this.readyState = 3; },
    // comandi per il test
    apri() { this.readyState = 1; ascoltatori.get('open')?.(); },
    ricevi(oggetto) { ascoltatori.get('message')?.({ data: JSON.stringify(oggetto) }); },
    riceviGrezzo(dati) { ascoltatori.get('message')?.({ data: dati }); },
    chiudi(code) { this.readyState = 3; ascoltatori.get('close')?.({ code }); },
  };
}

function banco({ retryMs = () => 10_000 } = {}) {
  const socket = fintoSocket();
  const eventi = { aperti: 0, messaggi: [], chiusure: [] };
  const timer = [];
  const creati = [];
  const modulo = createSocket({
    openSocket: () => { const s = fintoSocket(); creati.push(s); return s; },
    protocols: () => ['bearer.x'],
    hello: () => ({ t: 'hello', proto: 2 }),
    onOpen: () => { eventi.aperti += 1; },
    onMessage: (m) => eventi.messaggi.push(m),
    onClosed: (e) => eventi.chiusure.push(e),
    retryMs,
    setTimer: (fn) => { timer.push(fn); return timer.length; },
    clearTimer: () => {},
  });
  return { modulo, eventi, timer, creati, socket };
}

test('all\'apertura si presenta, e i messaggi arrivano a chi li aspetta', () => {
  const { modulo, eventi, creati } = banco();
  modulo.start();
  const rete = creati[0];
  rete.apri();
  assert.deepEqual(rete.inviati[0], { t: 'hello', proto: 2 }, 'il saluto deve partire da solo');
  rete.ricevi({ t: 'sessions', sessions: [] });
  assert.deepEqual(eventi.messaggi, [{ t: 'sessions', sessions: [] }]);
});

test('un messaggio illeggibile si ignora invece di far esplodere la connessione', () => {
  const { modulo, eventi, creati } = banco();
  modulo.start();
  creati[0].apri();
  creati[0].riceviGrezzo('{questo non è json');
  assert.deepEqual(eventi.messaggi, [], 'un messaggio rotto non deve arrivare all\'applicazione');
  creati[0].ricevi({ t: 'sessions' });
  assert.equal(eventi.messaggi.length, 1, 'e non deve impedire a quelli buoni di arrivare');
});

test('se cade la connessione si riprova, sempre, contando le cadute', () => {
  const { modulo, eventi, timer, creati } = banco();
  modulo.start();
  creati[0].apri();
  creati[0].chiudi(1006);
  assert.equal(eventi.chiusure.length, 1);
  assert.equal(eventi.chiusure[0].retrying, true);
  assert.equal(eventi.chiusure[0].giveUp, false);
  assert.equal(modulo.failures(), 1);
  assert.equal(timer.length, 1, 'deve aver programmato un ritentativo');
  // …e riprovando davvero si riconnette.
  timer[0]();
  assert.equal(creati.length, 2);
  creati[1].apri();
  assert.equal(eventi.aperti, 2);
});

test('la caduta si conta all\'indietro crescente, e si azzera quando si rientra', () => {
  const attese = [];
  const { modulo, timer, creati } = banco({ retryMs: (n) => { attese.push(n); return 10_000; } });
  modulo.start();
  // Tre cadute di fila: ognuna programma il tentativo dopo, e il tentativo crea un socket nuovo.
  for (let i = 0; i < 3; i += 1) {
    creati[i].chiudi(1006);
    timer.at(-1)();
  }
  assert.deepEqual(attese, [1, 2, 3], 'ogni caduta allontana il tentativo successivo');
  creati.at(-1).apri();
  assert.equal(modulo.failures(), 0, 'rientrare azzera il contatore');
});

test('un token rifiutato **non** si riprova: riprovare non lo aggiusta', () => {
  const { modulo, eventi, timer, creati } = banco();
  modulo.start();
  creati[0].chiudi(TOKEN_RIFIUTATO);
  assert.equal(eventi.chiusure[0].giveUp, true);
  assert.equal(eventi.chiusure[0].retrying, false);
  assert.equal(timer.length, 0, 'non deve programmare nessun ritentativo');
});

test('mandare mentre si è scollegati non è un errore: si perde, ed è voluto', () => {
  // La coda di quello che non è arrivato sarebbe uno stato in più da riconciliare al ritorno, e
  // il server rimanda comunque tutto quello che serve.
  const { modulo, creati } = banco();
  modulo.start();
  modulo.send({ t: 'input', data: 'x' }); // prima di aprire: readyState 0
  assert.deepEqual(creati[0].inviati, []);
  assert.equal(modulo.isOpen(), false);
  creati[0].apri();
  modulo.send({ t: 'input', data: 'y' });
  assert.deepEqual(creati[0].inviati.at(-1), { t: 'input', data: 'y' });
  assert.equal(modulo.isOpen(), true);
});

test("i sottoprotocolli si leggono all'apertura, non alla costruzione", () => {
  // Il difetto che il banco in un browser vero ha trovato il primo giorno: il token veniva letto
  // una volta sola quando il modulo si caricava, cioè **prima** che il token esistesse — la prima
  // connessione partiva con `bearer.` vuoto e il server rispondeva «nessuna credenziale valida».
  // Il token può cambiare (si rientra, si gira la chiave): va letto quando serve.
  let token = '';
  const usati = [];
  const creati = [];
  const modulo = createSocket({
    openSocket: (protocols) => { usati.push(protocols); const s = fintoSocket(); creati.push(s); return s; },
    protocols: () => [`bearer.${token}`],
    hello: () => ({ t: 'hello' }),
    onOpen: () => {}, onMessage: () => {}, onClosed: () => {},
    setTimer: () => 0, clearTimer: () => {},
  });
  modulo.start();
  assert.deepEqual(usati[0], ["bearer."], "alla prima apertura il token non c'è ancora");

  // Arriva il token, e la connessione cade: al tentativo dopo deve esserci.
  token = 'adesso-ce';
  creati[0].chiudi(1006);
  modulo.reset();
  modulo.start();
  assert.deepEqual(usati[1], ['bearer.adesso-ce'], 'il secondo tentativo deve usare il token nuovo');
});

test('non si aprono due connessioni per sbaglio', () => {
  const { modulo, creati } = banco();
  modulo.start();
  modulo.start();
  modulo.start();
  assert.equal(creati.length, 1, 'tre `start` di fila sono una connessione sola');
});

test('dopo un token nuovo si riparte da zero', () => {
  const { modulo, creati } = banco();
  modulo.start();
  creati[0].chiudi(1006);
  assert.equal(modulo.failures(), 1);
  modulo.reset();
  assert.equal(modulo.failures(), 0);
  assert.equal(modulo.rifiutato(), false);
  modulo.start();
  assert.equal(creati.length, 2);
});
