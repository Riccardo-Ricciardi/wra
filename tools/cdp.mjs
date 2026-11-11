// Il banco di prova in un browser **vero**: Chrome pilotato via CDP, senza aggiungere dipendenze
// (`ws` c'è già). Non è una suite di unit test e non gira a ogni commit: risponde a «funziona
// davvero, premendo i pulsanti?».
//
// I clic sono eventi **veri** del mouse (`Input.dispatchMouseEvent`), non `element.click()`:
// è l'unico modo di accorgersi di quello che sta *sopra* un pulsante — la lezione di quel
// `[hidden]` che batteva un `display` esplicito e rendeva la pagina inutilizzabile senza dire
// niente, e dell'ultimo filtro che stava fuori dall'area visibile.
//
// Sta qui e non dentro il singolo controllo perché i banchi sono due (l'interfaccia e il pannello)
// e il modo di cliccare dev'essere lo stesso: se diverge, il secondo smette di accorgersi delle
// cose che il primo trova.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function argsOf(argv = process.argv) {
  const arg = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  return { arg, has: (name) => argv.includes(`--${name}`) };
}

/**
 * Apre Chrome, si collega, e restituisce i comandi del banco.
 *
 * @param {object} input
 * @param {string} input.base      l'indirizzo del server da provare
 * @param {string} input.token
 * @param {string} input.shotDir   dove finiscono le schermate
 * @param {string} [input.name]    come si chiama questo banco, per l'intestazione
 * @param {boolean} [input.headful]
 * @param {number} [input.port]    la porta di debug di Chrome (due banchi insieme non si pestano)
 */
export async function launch({ base, token, shotDir, name = 'controllo', headful = false, port = 9333, chromePath = null, keepOpen = false, viewport = { width: 1440, height: 900 } }) {
  fs.mkdirSync(shotDir, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-cdp-'));
  const chrome = spawn(chromePath ?? (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : 'google-chrome'), [
    headful ? '--new-window' : '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
    `--window-size=${viewport.width},${viewport.height}`,
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  async function debuggerUrl() {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
        const page = list.find((target) => target.type === 'page');
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      } catch {
        // non è ancora in ascolto
      }
      await sleep(250);
    }
    throw new Error('Chrome non si è aperto in tempo');
  }

  const socket = new WebSocket(await debuggerUrl(), { maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });

  let nextId = 0;
  const waiting = new Map();
  const events = [];
  const consoleErrors = [];
  const failedRequests = [];
  const requests = [];

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} ${JSON.stringify(message.error.data ?? '')}`));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((value) => value.value ?? value.description).join(' '));
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(`[${message.params.entry.source}] ${message.params.entry.text}`);
    }
    if (message.method === 'Network.responseReceived') requests.push(message.params.response);
    if (message.method === 'Network.loadingFailed') failedRequests.push(message.params.errorText);
    events.push(message);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = (nextId += 1);
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  const once = async (method, timeoutMs = 25_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const at = events.findIndex((event) => event.method === method);
      if (at !== -1) return events.splice(at, 1)[0].params;
      await sleep(50);
    }
    throw new Error(`evento mai arrivato: ${method}`);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };

  const js = (value) => JSON.stringify(value);

  const boxOf = (selector, { index = 0, text = null } = {}) => evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${js(selector)})];
    const found = ${text === null ? 'nodes' : `nodes.filter((node) => node.textContent.includes(${js(text)}))`};
    const node = found[${index}];
    if (!node) return null;
    node.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // Fuori dalla finestra non è un clic: è un clic su qualcos'altro.
    if (rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height };
  })()`);

  /** Un clic vero, con il mouse vero: se qualcosa copre il pulsante, non arriva. */
  async function click(selector, { index = 0, text = null, what = selector } = {}) {
    let box = await boxOf(selector, { index, text });
    if (!box) {
      await sleep(250); // un ridisegno in corso: si riprova una volta prima di dichiarare perso
      box = await boxOf(selector, { index, text });
    }
    if (!box) throw new Error(`elemento non trovato o invisibile: ${what}`);
    const point = { x: Math.round(box.x), y: Math.round(box.y) };
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, ...point, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      });
    }
    await sleep(140);
    return box;
  }

  const NAMED_KEYS = {
    Escape: { code: 'Escape', vk: 27 },
    Enter: { code: 'Enter', vk: 13 },
    Tab: { code: 'Tab', vk: 9 },
    '/': { code: 'Slash', vk: 191 },
  };

  async function press(key, { ctrl = false, shift = false } = {}) {
    const named = NAMED_KEYS[key];
    const code = named?.vk ?? key.toUpperCase().charCodeAt(0);
    const base = {
      key,
      code: named?.code ?? `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
      modifiers: (ctrl ? 2 : 0) + (shift ? 8 : 0),
    };
    // `text` solo per i **caratteri**: per Escape e gli altri tasti con un nome Chrome lo rifiuta,
    // e per le combinazioni con Ctrl non va mandato (altrimenti è un carattere, non un comando).
    const text = !ctrl && key.length === 1 ? key : undefined;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(200);
  }

  async function typeIn(selector, value) {
    await click(selector, { what: selector });
    await evaluate(`(() => {
      const field = document.querySelector(${js(selector)});
      field.focus();
      field.value = ${js(value)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(150);
  }

  /** Chiude menu e finestre aperte: un controllo fallito non deve lasciare la pagina a metà. */
  async function closeOverlays() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      await sleep(80);
    }
    await evaluate(`(() => {
      document.querySelectorAll('#menu-layer .menu, #dialog-layer .dialog-backdrop').forEach((node) => node.remove());
      return true;
    })()`);
  }

  async function setViewport(width, height, { mobile = false, dark = false, scale = 1 } = {}) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: scale, mobile,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    // Il tocco si accende **insieme** al `mobile`, non a parte: un telefono su cui si clicca col
    // mouse è un telefono che non prova niente dei bersagli da dito, e la misura dei 44px che
    // fanno i banchi sarebbe una misura del desktop.
    await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
    });
    await sleep(300);
  }

  async function shot(fileName) {
    const result = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, `${fileName}.png`), Buffer.from(result.data, 'base64'));
    return `${fileName}.png`;
  }

  /**
   * Apre la pagina col token, e aspetta che ci sia qualcosa da guardare. `waitFor` è
   * un'espressione: è la cosa che dice «la pagina è pronta», e cambia da banco a banco.
   */
  async function goto({ waitFor = `document.querySelectorAll('#conversations-body .list .row[data-id]').length > 0`, timeoutMs = 20_000 } = {}) {
    const loaded = once('Page.loadEventFired');
    await send('Page.navigate', { url: `${base}/?token=${encodeURIComponent(token)}` });
    await loaded;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(waitFor)) return;
      await sleep(150);
    }
    throw new Error('la pagina non è diventata quella che si aspettava');
  }

  const results = { passed: 0, failures: [], skipped: [] };

  /**
   * Con `--only <pezzo di nome>` si esegue **un controllo solo**, e gli altri si saltano dicendolo.
   *
   * Serve a rispondere a una domanda che il giro intero non può: **questo controllo passa da
   * solo?** Un controllo che regge solo perché ne ha eseguito un altro prima è un controllo che
   * dipende da dove ha lasciato la pagina — la stessa famiglia di difetti che ha tenuto in piedi per
   * un giro intero la diagnosi sbagliata di «una sezione raggruppa».
   *
   * I saltati si **stampano**: un controllo che non gira deve vedersi, non sparire.
   */
  const solo = argsOf().arg('only', '') || null;

  async function check(what, fn) {
    if (solo && !what.includes(solo)) {
      results.skipped.push(what);
      console.log(`  – saltato (--only ${solo}): ${what}`);
      return;
    }
    try {
      const detail = await fn();
      results.passed += 1;
      console.log(`  ✔ ${what}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      results.failures.push(`${what} — ${error.message}`);
      console.log(`  ✖ ${what} — ${error.message}`);
      await closeOverlays().catch(() => {});
    }
  }

  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  /**
   * Aspetta che una condizione **vera** si avveri, invece di un tempo scelto a occhio.
   *
   * Un'attesa fissa o è troppo corta — e allora fallisce a caso sulla macchina carica, per un
   * motivo che non c'entra con quello che si stava provando — o è troppo lunga e rallenta ogni
   * giro. È la lezione che i banchi hanno imparato due volte: `wait(800)` sul terminale provava il
   * cronometro, e `wait(1_500)` sul salvataggio delle impostazioni ha fatto cadere un giro su venti
   * con «il file non ha la cartella scelta» — la scrittura non era ancora arrivata.
   *
   * `ok` è il predicato su quello che si è visto: senza, vale «qualcosa di vero».
   */
  async function attendi(espressione, what, { ok = (visto) => Boolean(visto), timeoutMs = 8_000, ogniMs = 150 } = {}) {
    const scaduto = Date.now() + timeoutMs;
    let visto;
    while (Date.now() < scaduto) {
      visto = await evaluate(espressione);
      if (ok(visto)) return visto;
      await sleep(ogniMs);
    }
    throw new Error(`non si è avverato: ${what} — visto: ${JSON.stringify(visto)}`);
  }

  /** L'indirizzo della pagina porta il token: non deve finire in nessun output. */
  const redact = (text) => String(text).replace(/token=[^&\s"']*/gi, 'token=***');

  function report() {
    console.log('');
    if (solo) {
      console.log(results.failures.length
        ? `✖ ${results.failures.length} controlli falliti su ${results.passed + results.failures.length} (--only ${solo}, ${results.skipped.length} saltati)`
        : `✔ ${results.passed} controlli passati (--only ${solo}, ${results.skipped.length} saltati)`);
    } else {
      console.log(results.failures.length
        ? `✖ ${results.failures.length} controlli falliti su ${results.passed + results.failures.length}`
        : `✔ tutti i ${results.passed} controlli passati`);
    }
    console.log(`schermate in ${shotDir}`);
  }

  async function close() {
    if (keepOpen) return;
    socket.close();
    chrome.kill();
    await sleep(500);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // il profilo temporaneo lo porta via il sistema
    }
  }

  const uiFetch = (route) => evaluate(`fetch(${js(route)}, { headers: { 'x-cc-remote-token': ${js(token)} } }).then((response) => response.json())`);

  console.log(`${name} (${base})`);

  return {
    send, once, evaluate, js, boxOf, click, press, typeIn, closeOverlays, setViewport, shot, goto,
    check, assert, attendi, report, close, uiFetch, redact, results, sleep,
    consoleErrors, failedRequests, requests, token, base, shotDir,
  };
}
