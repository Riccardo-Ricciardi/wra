#!/usr/bin/env node
// Il pacchetto, installato davvero: si impacchetta, si installa in una cartella usa e getta, si
// accende **da lì** e si chiede ogni cosa che la pagina chiede. Poi si apre in un browser vero.
//
//   node tools/pack-check.mjs
//
// Esiste per un difetto vero, trovato il 5/11: `packagesDir` era `path.join(here, '..', '..',
// 'node_modules')`. Nel repository è la cartella giusta; in un'installazione i pacchetti si
// appiattiscono in `node_modules` **sopra** a `cc-remote/`, quella cartella non esiste, e
// `/vendor/xterm/css/xterm.css` rispondeva 404. Il terminale si apriva lo stesso, senza il suo
// foglio di stile — un difetto che si vede solo installando, cioè quando è più caro.
//
// Quindi non si prova «il pacchetto si costruisce»: si prova «il pacchetto, installato, fa quello
// che deve». La differenza fra le due frasi è tutto quello che questo file esiste per misurare.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './cdp.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fallimenti = [];
const ok = (che, bene, extra = '') => {
  console.log(`${bene ? ' ok ' : 'NO  '} ${che}${extra ? ` — ${extra}` : ''}`);
  if (!bene) fallimenti.push(che);
};

const radice = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-remote-pack-'));
const app = path.join(radice, 'app');
const stato = path.join(radice, 'stato');
fs.mkdirSync(stato, { recursive: true });

let server = null;
let page = null;

const pulisci = () => {
  try { page?.close(); } catch { /* già chiuso */ }
  if (server && server.exitCode === null) {
    // Su Windows un `SIGTERM` non arriva: si abbatte l'albero.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill('SIGKILL');
  }
};
process.on('exit', pulisci);

try {
  // ── 1. impacchettare e installare ───────────────────────────────────────────────────────────
  // `npm` su Windows è un `.cmd`, e Node non lo esegue più senza una shell. La shell però prende
  // una **riga**, non una lista di argomenti: passarle la lista le fa concatenare le parti senza
  // metterle al riparo (ed è il motivo dell'avviso `DEP0190`). Quindi la riga si costruisce qui,
  // con i percorsi fra virgolette — che è la regola di `cmd`, e vale anche quando c'è uno spazio.
  const virgolette = (valore) => `"${String(valore).replace(/"/g, '""')}"`;
  const esegui = (riga) => spawnSync(riga, { cwd: repo, encoding: 'utf8', shell: true, windowsHide: true });
  const pack = esegui(`npm pack --pack-destination ${virgolette(radice)}`);
  const tarball = (pack.stdout ?? '').trim().split('\n').pop()?.trim();
  ok('npm pack produce un pacchetto', Boolean(tarball) && fs.existsSync(path.join(radice, tarball)), tarball);

  const install = spawnSync(
    `npm install --prefix ${virgolette(app)} ${virgolette(path.join(radice, tarball))} --no-audit --no-fund`,
    { cwd: repo, encoding: 'utf8', shell: true, windowsHide: true, timeout: 600_000 },
  );
  const pacchetto = path.join(app, 'node_modules', 'cc-remote');
  const cli = path.join(pacchetto, 'src', 'cli', 'index.mjs');
  ok('il pacchetto si installa', install.status === 0 && fs.existsSync(cli), install.status === 0 ? '' : (install.stderr ?? '').slice(0, 200));

  // ── 2. accenderlo **da lì**, con lo stato in una cartella sua ───────────────────────────────
  // Le variabili `CR_*` della shell di chi lancia questa prova parlerebbero del server **vero**: si
  // tolgono **tutte** e si rimettono solo quelle qui sotto. La regola è «tutte», non «quelle note»:
  // una che non conosciamo riporterebbe la prova a scrivere fuori dalla sua cartella.
  const env = Object.fromEntries(Object.entries(process.env).filter(([chiave]) => !chiave.startsWith('CR_')));
  Object.assign(env, {
    CR_TOKEN: 'pack-check-token-0123456789abcdef',
    CR_PORT: '0',
    CR_HOST: '127.0.0.1',
    CR_STATE_FILE: path.join(stato, 'sessions.json'),
    CR_PROJECTS_FILE: path.join(stato, 'projects.json'),
    CR_PROJECTS_ROOT: path.join(stato, 'projects'),
    CR_ALLOWED_ROOTS: stato,
    CR_DEFAULT_PROJECT: stato,
    CR_LOG_FILE: path.join(stato, 'log.txt'),
    CR_ACCESS_FILE: path.join(stato, 'access.json'),
    CR_SETTINGS_FILE: path.join(stato, 'settings.json'),
    CR_CLAUDE_CMD: process.execPath,
    CR_CLAUDE_ARGS: JSON.stringify([path.join(repo, 'tools', 'fake-claude.mjs')]),
    CR_PUBLIC_ORIGIN: '',
    CR_MCP_HOST: '',
  });

  server = spawn(process.execPath, [cli, 'serve'], { cwd: radice, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let uscita = '';
  server.stdout.setEncoding('utf8').on('data', (c) => { uscita += c; });
  server.stderr.setEncoding('utf8').on('data', (c) => { uscita += c; });

  let base = null;
  const scaduto = Date.now() + 30_000;
  while (Date.now() < scaduto && !base) {
    const match = uscita.match(/cc-remote su (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) base = match[1];
    else await sleep(150);
  }
  ok('l\'installazione si accende da sola', Boolean(base), base ?? uscita.trim().slice(0, 200));
  if (!base) throw new Error('niente da provare: il server installato non si è acceso');

  // ── 3. ogni cosa che la pagina chiede alla rete ─────────────────────────────────────────────
  const intestazioni = { 'x-cc-remote-token': env.CR_TOKEN };
  const risposta = (rotta) => fetch(`${base}${rotta}`, { headers: intestazioni }).then((r) => r.status).catch(() => 0);

  ok('la pagina risponde', (await risposta('/')) === 200);
  ok('la salute risponde', (await risposta('/healthz')) === 200);

  // Gli indirizzi si leggono da `index.html` invece di scriverli a mano: un elenco scritto a mano
  // è un elenco che invecchia, e la riga che manca è sempre quella nuova.
  const html = await (await fetch(`${base}/`, { headers: intestazioni })).text();
  const richiesti = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('//'));
  const mancanti = [];
  for (const url of [...new Set(richiesti)]) {
    const statoHttp = await risposta(url);
    if (statoHttp !== 200) mancanti.push(`${url}=${statoHttp}`);
  }
  ok('tutto quello che `index.html` chiede c\'è', mancanti.length === 0, mancanti.join(', ') || `${new Set(richiesti).size} indirizzi`);

  // ── 4. e il foglio di stile del terminale, che è il difetto che questo file esiste per cogliere
  for (const url of ['/vendor/xterm/css/xterm.css', '/vendor/fit/lib/addon-fit.js']) {
    ok(`le dipendenze servite da cc-remote: ${url}`, (await risposta(url)) === 200);
  }

  // ── 5. in un browser vero, sul pacchetto installato ─────────────────────────────────────────
  page = await launch({
    base, token: env.CR_TOKEN, shotDir: path.join(radice, 'schermate'),
    name: 'cc-remote — il pacchetto installato', port: 9388, viewport: { width: 1440, height: 900 },
  });
  await page.goto({ waitFor: `document.querySelectorAll('#nav-tabs .nav-tab').length > 0` });
  await sleep(1_200);
  ok('l\'interfaccia si apre dal pacchetto installato', (await page.evaluate(`document.querySelectorAll('#nav-tabs .nav-tab').length`)) === 4);
  ok('nessun errore in pagina', page.consoleErrors.length === 0, page.consoleErrors.slice(0, 3).join(' | '));
  // Un modulo che non si trova si vede qui: 404 sul `.mjs`, e la pagina resta a metà.
  const cadute = page.failedRequests ?? [];
  ok('nessuna richiesta caduta', cadute.length === 0, cadute.slice(0, 3).join(' | '));
} catch (error) {
  ok('il giro del pacchetto', false, error.message);
} finally {
  pulisci();
  // La cartella: si insiste, perché su Windows un `conhost` può tenerla per un istante.
  for (let tentativo = 0; tentativo < 5; tentativo += 1) {
    try {
      fs.rmSync(radice, { recursive: true, force: true });
      break;
    } catch {
      await sleep(300);
    }
  }
}

console.log(`\n${fallimenti.length ? `PACCHETTO FAIL (${fallimenti.length})` : 'PACCHETTO PASS'}`);
process.exit(fallimenti.length ? 1 : 0);
