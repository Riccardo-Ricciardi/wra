import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  accessDefaults, checkHostname, originFor, parseOrigins, planAccess, reviewAccess,
} from '../src/core/access.mjs';
import { createAccessStore } from '../src/host/access-store.mjs';
import { originAllowed } from '../src/net/ws.mjs';

// L'accesso da fuori: due modalità, due superfici che non si toccano.
//
// Quello che questi test sorvegliano non è la comodità della funzione: è che la **dashboard
// amministrativa** e l'**endpoint MCP** restino due cose distinte. Un errore di configurazione
// che le sovrapponesse toglierebbe in silenzio la protezione in più che uno dei due ha.

const repo = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('un hostname si accetta solo se è un hostname', () => {
  assert.equal(checkHostname('cc.esempio.com').ok, true);
  assert.equal(checkHostname('CC.Esempio.COM').host, 'cc.esempio.com');
  assert.equal(checkHostname('  cc.esempio.com  ').host, 'cc.esempio.com');

  assert.equal(checkHostname('').ok, false);
  assert.match(checkHostname('https://cc.esempio.com').reason, /without https/);
  assert.match(checkHostname('cc.esempio.com/percorso').reason, /without https|paths/);
  assert.match(checkHostname('cc.esempio.com:8443').reason, /port/);
  assert.match(checkHostname('localhost').reason, /full domain/);
  assert.equal(checkHostname('cc_esempio.com').ok, false);
  assert.equal(checkHostname('cc..esempio.com').ok, false);
  assert.equal(checkHostname('.esempio.com').ok, false);
});

test('le origini ammesse possono essere due, perché le modalità possono essere due', () => {
  const both = parseOrigins('https://a.esempio.com/ ; https://b.esempio.com');
  assert.deepEqual(both, [originFor('a.esempio.com'), originFor('b.esempio.com')]);
  assert.deepEqual(parseOrigins('https://a.esempio.com'), ['https://a.esempio.com']);
  assert.deepEqual(parseOrigins(''), []);
  assert.deepEqual(parseOrigins('non-un-indirizzo'), [], 'quello che non è un indirizzo non entra');
  assert.deepEqual(parseOrigins('ftp://a.esempio.com'), [], 'solo http/https');
});

test('il websocket accetta tutte le origini dichiarate, e solo quelle', () => {
  const config = { publicOrigins: ['https://a.esempio.com', 'https://b.esempio.com'] };
  assert.equal(originAllowed('https://a.esempio.com', config), true);
  assert.equal(originAllowed('https://b.esempio.com', config), true);
  assert.equal(originAllowed('https://c.esempio.com', config), false);
  assert.equal(originAllowed('http://127.0.0.1:4310', config), true, 'da questa macchina si entra sempre');
  assert.equal(originAllowed(undefined, config), true, 'uno script non ha un\'origine da ingannare');
  // Una sola origine dichiarata continua a funzionare come prima.
  assert.equal(originAllowed('https://a.esempio.com', { publicOrigin: 'https://a.esempio.com' }), true);
  assert.equal(originAllowed('https://b.esempio.com', { publicOrigin: 'https://a.esempio.com' }), false);
});

test('Tailscale: un hostname, e il comando che espone il server nella tailnet', () => {
  const plan = planAccess({ mode: 'tailscale', tailscaleHost: 'pc-mio.tail1234.ts.net', port: 4310 });
  assert.equal(plan.ok, true);
  assert.equal(plan.env.CR_PUBLIC_ORIGIN, 'https://pc-mio.tail1234.ts.net');
  assert.equal(plan.env.CR_MCP_HOST, undefined, 'la tailnet non c\'entra con l\'endpoint MCP');
  assert.ok(plan.needs.some((need) => need.command.includes('tailscale serve --bg --https=443 http://127.0.0.1:4310')));

  const bad = planAccess({ mode: 'tailscale', tailscaleHost: '' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /Tailscale/);
});

test('Cloudflare: dashboard e endpoint MCP su due hostname, con due protezioni', () => {
  const plan = planAccess({ mode: 'cloudflare', dashboardHost: 'cc.mio.com', mcpHost: 'mcp.mio.com', port: 4310 });
  assert.equal(plan.ok, true);
  assert.equal(plan.env.CR_DASHBOARD_HOST, 'cc.mio.com');
  assert.equal(plan.env.CR_PUBLIC_ORIGIN, 'https://cc.mio.com');
  assert.equal(plan.env.CR_MCP_HOST, 'mcp.mio.com');
  assert.equal(plan.env.CR_RESOURCE_URL, 'https://mcp.mio.com/mcp');
  // Access è obbligatorio sulla dashboard, e va detto che lo è.
  const access = plan.needs.find((need) => /Access/.test(need.what));
  assert.match(access.why, /mandatory/);
  // Sull'endpoint macchina ci va il **Bypass**, non Allow: è l'errore che rompe il collegamento.
  assert.ok(plan.needs.some((need) => /Bypass/.test(need.command)));

  // Senza endpoint MCP il piano resta valido: il bridge è un extra.
  const soloDashboard = planAccess({ mode: 'cloudflare', dashboardHost: 'cc.mio.com' });
  assert.equal(soloDashboard.ok, true);
  assert.equal(soloDashboard.env.CR_MCP_HOST, undefined);
  assert.ok(soloDashboard.needs.some((need) => /ChatGPT/.test(need.what)));
});

test('la dashboard e l\'endpoint MCP non possono stare sullo stesso hostname', () => {
  const plan = planAccess({ mode: 'cloudflare', dashboardHost: 'uguale.mio.com', mcpHost: 'uguale.mio.com' });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /two different hostnames/);
});

test('con tutte e due le modalità accese, le origini sono tutte e due', () => {
  const defaults = accessDefaults({
    tailscale: { host: 'pc.tail1234.ts.net', origin: 'https://pc.tail1234.ts.net' },
    cloudflare: { dashboard: 'cc.mio.com', mcp: 'mcp.mio.com' },
  });
  assert.equal(defaults.publicOrigin, 'https://pc.tail1234.ts.net;https://cc.mio.com');
  assert.equal(defaults.dashboardHost, 'cc.mio.com');
  assert.equal(defaults.mcpHost, 'mcp.mio.com');
  assert.deepEqual(parseOrigins(defaults.publicOrigin).length, 2);

  const none = accessDefaults(null);
  assert.equal(none.publicOrigin, '');
  assert.equal(none.dashboardHost, '');
});

test('la revisione dice cosa manca, e segnala le superfici sovrapposte', () => {
  const rows = reviewAccess({
    config: { host: '127.0.0.1', port: 4310, publicOrigin: 'https://cc.mio.com', dashboardHost: 'cc.mio.com', issuerUrl: '', resourceUrl: '', mcpHost: '' },
    tailscaleInstalled: false,
    cloudflaredInstalled: true,
  });
  const dashboard = rows.find((row) => row.what === 'dashboard from outside');
  assert.equal(dashboard.ok, true);
  assert.match(dashboard.detail, /cc\.mio\.com/);
  assert.equal(rows.find((row) => row.what === '`tailscale`').ok, false, 'non installato: deve dirlo');
  assert.equal(rows.find((row) => row.what === '`cloudflared`').ok, true);
  assert.equal(rows.find((row) => row.what === 'MCP bridge').detail, 'down (CR_ISSUER_URL/CR_RESOURCE_URL missing)');

  // Se l'hostname della dashboard finisse anche fra le rotte macchina, la protezione in più
  // sulla dashboard sarebbe sparita: va detto, non ignorato.
  const overlapping = reviewAccess({
    config: { host: '127.0.0.1', port: 4310, publicOrigins: ['https://mcp.mio.com'], issuerUrl: 'https://mcp.mio.com', resourceUrl: 'https://mcp.mio.com/mcp', mcpHost: 'mcp.mio.com' },
  });
  const clash = overlapping.find((row) => row.what === 'surface separation');
  assert.ok(clash, 'la sovrapposizione non è stata segnalata');
  assert.equal(clash.ok, false);
});

test('la scelta salvata si rilegge, si spegne una modalità per volta, e regge a un file rotto', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-access-'));
  const file = path.join(root, 'access.json');
  try {
    const store = createAccessStore({ file });
    store.load();
    store.set('tailscale', { host: 'pc.tail1234.ts.net', origin: 'https://pc.tail1234.ts.net' });
    store.set('cloudflare', { dashboard: 'cc.mio.com' });

    const reopened = createAccessStore({ file });
    const state = reopened.load();
    assert.equal(state.tailscale.host, 'pc.tail1234.ts.net');
    assert.equal(state.cloudflare.dashboard, 'cc.mio.com');

    reopened.clear('tailscale');
    assert.equal(createAccessStore({ file }).load().tailscale, null);
    assert.equal(createAccessStore({ file }).load().cloudflare.dashboard, 'cc.mio.com', 'spegnere una non spegne l\'altra');

    // File rotto **con** un backup buono: si recupera, e l'originale si mette da parte.
    // (La scelta dell'accesso è configurazione, non dati: recuperarla è meglio che ripartire
    // da zero, ma nemmeno qui si azzera niente in silenzio.)
    fs.writeFileSync(file, 'non-json');
    const recovered = createAccessStore({ file }).load();
    assert.ok(recovered.cloudflare, 'dal backup deve tornare la scelta di prima');
    assert.ok(fs.readdirSync(root).some((name) => name.includes('corrupt-')), 'l\'originale rotto si mette da parte');

    // Rotti tutti e due: si entra solo da questa macchina, invece di non partire.
    fs.writeFileSync(file, 'non-json');
    fs.writeFileSync(`${file}.bak`, 'nemmeno-questo');
    const broken = createAccessStore({ file }).load();
    assert.equal(broken.tailscale, null);
    assert.equal(broken.cloudflare, null);

    assert.throws(() => createAccessStore({ file }).set('altro', {}), /unknown mode/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('`rc access` scrive la sua scelta e non tocca nient\'altro', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-access-cli-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CR_')) delete env[key];
  Object.assign(env, { CR_STATE_FILE: path.join(root, 'sessions.json'), CR_ACCESS_FILE: path.join(root, 'access.json') });

  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'access.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
  });

  try {
    const bad = await run(['tailscale', 'not-a-host']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /full domain/);

    const ok = await run(['tailscale', 'pc.tail1234.ts.net']);
    assert.equal(ok.code, 0);
    assert.match(ok.out, /tailscale serve --bg --https=443/);
    assert.match(ok.out, /wra stop; wra start/, 'deve dire che serve un riavvio, senza farlo');

    const written = JSON.parse(fs.readFileSync(path.join(root, 'access.json'), 'utf8'));
    assert.equal(written.tailscale.host, 'pc.tail1234.ts.net');
    // Nessun comando è stato eseguito: nella cartella c'è solo il file della scelta.
    assert.deepEqual(fs.readdirSync(root).sort(), ['access.json']);

    const shown = await run(['check']);
    assert.equal(shown.code, 0);
    assert.match(shown.out, /tailscale/);

    const off = await run(['off', 'tailscale']);
    assert.equal(off.code, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'access.json'), 'utf8')).tailscale, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── le due superfici su un server vero ───────────────────────────────────────
test('sul dominio della dashboard le rotte della macchina non esistono', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-access-api-'));
  const project = path.join(root, 'progetto');
  fs.mkdirSync(project, { recursive: true });
  const TOKEN = 'token-di-prova-lungo-abbastanza';
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CR_')) delete env[key];
  Object.assign(env, {
    CR_TOKEN: TOKEN,
    CR_PORT: '0',
    CR_STATE_FILE: path.join(root, 'sessions.json'),
    CR_PROJECTS_FILE: path.join(root, 'projects.json'),
    CR_TURN_JOURNAL_FILE: path.join(root, 'turns.json'),
    CR_PROJECTS_ROOT: path.join(root, 'projects'),
    CR_ALLOWED_ROOTS: root,
    CR_DEFAULT_PROJECT: project,
    CR_LOG_FILE: path.join(root, 'serve.log'),
    // La dashboard su un hostname, l'endpoint MCP su un altro: è la configurazione che il
    // comando `rc access cloudflare` scrive.
    CR_PUBLIC_ORIGIN: 'https://cc.esempio.com',
    CR_DASHBOARD_HOST: 'cc.esempio.com',
    CR_MCP_HOST: 'mcp.esempio.com',
    CR_ISSUER_URL: 'https://mcp.esempio.com',
    CR_RESOURCE_URL: 'https://mcp.esempio.com/mcp',
  });

  const serve = spawn(process.execPath, [path.join(repo, 'src', 'cli', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  serve.stdout.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  serve.stderr.setEncoding('utf8').on('data', (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/WRA on http/.test(log)) await sleep(120);
  const port = Number(log.match(/WRA on http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
  assert.ok(port, `il server non si è annunciato: ${log}`);

  // `fetch` non lascia scrivere l'intestazione Host (è vietata dalla specifica): si usa http.
  const ask = (host, route, method = 'GET') => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: route, method, headers: { host, 'x-cc-remote-token': TOKEN } }, (response) => {
      let body = '';
      response.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });

  try {
    // Sulla dashboard: la persona entra, la macchina no.
    assert.equal((await ask('cc.esempio.com', '/local/sessions')).status, 200, 'la dashboard deve funzionare');
    assert.equal((await ask('cc.esempio.com', '/mcp', 'POST')).status, 404, '/mcp non deve esistere sulla dashboard');
    assert.equal((await ask('cc.esempio.com', '/token', 'POST')).status, 404);
    assert.equal((await ask('cc.esempio.com', '/register', 'POST')).status, 404);
    assert.equal((await ask('cc.esempio.com', '/.well-known/oauth-authorization-server')).status, 404);
    // Il giro del consenso serve alla macchina, non alla dashboard: anche quello sta di là.
    assert.equal((await ask('cc.esempio.com', '/authorize')).status, 404);

    // Sull'endpoint MCP: la macchina sì, la dashboard no.
    assert.notEqual((await ask('mcp.esempio.com', '/mcp', 'POST')).status, 200, 'senza token /mcp non risponde 200');
    assert.equal((await ask('mcp.esempio.com', '/local/sessions')).status, 404, 'le API della persona non stanno sull\'hostname della macchina');
    assert.equal((await ask('mcp.esempio.com', '/')).status, 404, 'nemmeno il sito');
  } finally {
    serve.kill();
    await sleep(400);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await sleep(250);
      }
    }
  }
});
