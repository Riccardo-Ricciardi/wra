// Il websocket: aprirlo, riaprirlo, e dire all'applicazione cosa sta succedendo.
//
// Prima viveva dentro `connect()`, e chiamava direttamente quattro funzioni di disegno
// (`setConn`, `renderBanner`, `showGate`, `el.gate.hidden`) più il terminale. Un modulo di
// trasporto che sa disegnare non si può provare e non si può riusare: qui **non sa niente del
// DOM**, prende le callback, e la politica (quando smettere di riprovare, cosa dire) resta a chi
// la conosce.
//
// La logica di riprova è quella di prima, identica: si riprova sempre, all'indietro crescente, e
// l'unico caso in cui non si riprova è il server che dice di no (1008), perché lì il token è
// davvero sbagliato e riprovare non lo aggiusta.

/** Il codice con cui il server dice «questo token non va»: `1008` = policy violation. */
export const TOKEN_RIFIUTATO = 1008;

/**
 * @param {object} input
 * @param {(protocols: string[]) => WebSocket} input.openSocket
 * @param {() => string[]} input.protocols  i sottoprotocolli, **letti all'apertura**: il token può
 *   cambiare fra una connessione e l'altra, e leggerlo una volta sola alla costruzione vuol dire
 *   autenticarsi con quello di prima
 * @param {() => object} input.hello          il primo messaggio da mandare all'apertura
 * @param {(message: object) => void} input.onMessage
 * @param {() => void} input.onOpen
 * @param {(event: {code: number, failures: number, retrying: boolean, giveUp: boolean}) => void} input.onClosed
 * @param {number} [input.maxFailures]        dopo quante cadute si smette di credere al token
 */
export function createSocket({
  openSocket, protocols, hello, onMessage, onOpen, onClosed,
  retryMs = (failures) => Math.min(1_200 * failures, 8_000),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let ws = null;
  let failures = 0;
  let timer = null;
  let stopped = false;

  const started = () => !stopped && ws !== null && ws.readyState <= 1;

  function start() {
    if (started()) return;
    stopped = false;
    const socket = openSocket(protocols());
    ws = socket;

    socket.addEventListener('open', () => {
      failures = 0;
      onOpen();
      try {
        socket.send(JSON.stringify(hello()));
      } catch {
        // un `hello` che non parte non deve impedire la connessione: il server risponderà con
        // quello che sa, e il primo `refresh` rimette a posto lo stato.
      }
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // un messaggio che non si capisce si ignora: non è una conversazione
      }
      onMessage(message);
    });

    socket.addEventListener('close', (event) => {
      const giveUp = event.code === TOKEN_RIFIUTATO;
      if (giveUp) {
        stopped = true;
        ws = null;
        failures = 0;
        onClosed({ code: event.code, failures: 0, retrying: false, giveUp: true });
        return;
      }
      // `1006` è «la connessione è caduta», e succede a ogni riavvio del server. Non si cancella
      // niente: si riprova. Un riavvio non deve far rientrare a mano.
      failures += 1;
      const retrying = !stopped;
      onClosed({ code: event.code, failures, retrying, giveUp: false });
      if (!retrying) return;
      if (timer) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        start();
      }, retryMs(failures));
    });
  }

  /** Manda, se c'è dove. Un messaggio mentre si è scollegati si perde, ed è voluto: la coda di
   *  quello che non è arrivato è uno stato in più da riconciliare al ritorno, e il server rimanda
   *  comunque tutto quello che serve. */
  function send(message) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(message));
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    try {
      ws?.close();
    } catch {
      // chiudere un socket già chiuso non è un errore
    }
    ws = null;
  }

  return {
    start, stop, send,
    /** Quante cadute di fila: chi disegna decide se è il caso di dirlo. */
    failures: () => failures,
    /** Il server ha detto di no e non si riprova. */
    rifiutato: () => stopped && ws === null && failures === 0,
    isOpen: () => ws?.readyState === 1,
    /** Il token è cambiato (o è stato appena messo): si riparte **contando da zero**. Senza
     *  azzerare, un token nuovo erediterebbe le cadute di quello vecchio e la soglia oltre cui
     *  l'applicazione smette di crederci arriverebbe prima del dovuto. */
    reset() {
      stop();
      stopped = false;
      failures = 0;
    },
  };
}
