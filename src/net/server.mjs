import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { normalizeHost } from '../core/access.mjs';
import { attachWeb, originAllowed } from './ws.mjs';
import { mountAdmin } from './admin.mjs';
import { LOGIN_PATH, createConsentGate, createOwner, sameToken } from './ui-auth.mjs';
import { BridgeStore, authorizePreflight } from '../mcp/auth/store.mjs';
import { BridgeOAuthProvider } from '../mcp/auth/provider.mjs';
import { createMcpServer } from '../mcp/server.mjs';
import { createMcpTools } from '../mcp/tools.mjs';
import { createSelections } from '../mcp/selection.mjs';
import { createTurnCoordinator } from '../host/turn-coordinator.mjs';
import { createTurnJournal } from '../host/turn-journal.mjs';
import { createProjectStore } from '../host/project-store.mjs';
import { resolveProjectDir } from '../host/session-registry.mjs';
import { buildProjects, pathKey } from '../core/workspace.mjs';
import { searchConversations } from '../core/search.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { createApprovals } from '../host/approvals.mjs';
import { createAutoPolicy } from '../host/auto-policy.mjs';
import * as log from '../log.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const classicWebDir = path.join(here, '..', 'web');
// The new UI (React, `web/`) is the default one: it is served when the build is there.
// `CR_REMOTE_UI=classic` goes back to the old UI, which remains the way back.
const nextWebDir = path.join(here, '..', '..', 'web', 'dist');
const uiChoice = String(process.env.CR_REMOTE_UI ?? '').toLowerCase();
const useNextUi = uiChoice !== 'classic'
  && fs.existsSync(path.join(nextWebDir, 'index.html'));
const webDir = useNextUi ? nextWebDir : classicWebDir;

/**
 * Where a dependency really is.
 *
 * It used to be `path.join(here, '..', '..', 'node_modules')` — the folder next to `src/`. That
 * works in the repository and does **not** work in an installation: there the packages flatten into
 * the `node_modules` above `cc-remote/`, that folder does not exist, and `/vendor/xterm/css/xterm.css`
 * answers 404. The terminal still opened, without its stylesheet: a defect that only shows up when
 * installing, which is exactly when it is most expensive.
 *
 * We ask Node, which knows how to do the resolution in both cases.
 */
const requireDaQui = createRequire(import.meta.url);
const packageDir = (name) => path.dirname(requireDaQui.resolve(`${name}/package.json`));

const SCOPE = 'talk';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Does the request come from a browser on **this** machine (or from no browser)?
 *
 * It distinguishes two things that have the same token but not the same meaning: looking at the
 * list from the phone, and **making something happen on the PC** — opening a folder, detaching a
 * window. The first can be done from anywhere; the second only from here.
 *
 * What it really protects: a site opened elsewhere that tries to make you press that button. A
 * cross-site request carries `Origin: https://other-site` and is refused; the gate cookie is
 * `SameSite=Lax`, so it does not even travel.
 *
 * What it does **not** protect: whoever has the token. The `Origin` header is written by the client,
 * and a client that is not a browser can omit it or make it up. It is not a guarantee of local
 * network origin — it is the rail that keeps another site's browser out. (In the model of
 * docs/SECURITY.md the token *is* the authorization: whoever has it is you.)
 */
export function isLocalRequest(request, config = {}) {
  const origin = request.headers?.origin;
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname.replace(/\.$/, '').toLowerCase();
    if (LOOPBACK_HOSTS.has(hostname)) return true;
    // Single-host **with explicit consent** (`CR_SINGLE_HOST_ADMIN`): the dashboard arrives from the
    // same hostname this server serves, and on the internet it sits behind Cloudflare Access.
    // That is the local network now, and treating it as foreign would mean that from the phone you
    // can neither open a folder nor restore a backup — that is, the dashboard is half done.
    //
    // The consent is a separate variable **on purpose**: accepting the public host here means
    // accepting that an operation acting on the machine can start from the internet, and such a
    // thing is not turned on as a consequence of something else.
    return Boolean(config.singleHostAdmin) && Boolean(config.mcpHost) && hostname === config.mcpHost;
  } catch {
    return false;
  }
}

/** Opens a folder in the system file manager. Only an already validated path arrives here. */
function openFolder(target) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [target], { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // the file manager may not exist: that is not a failure of ours
  child.unref();
}

// Security headers: the UI loads nothing from outside (xterm is served from here) and the websocket
// is on the same origin. No `unsafe-eval`; inline styles are needed by the two pages (login and
// consent) the server generates.
function securityHeaders(_request, response, next) {
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

/**
 * The two public surfaces do not overlap.
 *
 * On the **dashboard** public hostname there is the person: the site, `/local/*`, the websocket.
 * On the **MCP endpoint** public hostname there is the machine: OAuth and `/mcp`.
 *
 * The lock goes in both directions, and that is intended: thus an error on one surface cannot open
 * the other. If the dashboard domain mistakenly also ended up in the list of machine routes (or the
 * other way around), the only thing left between ChatGPT and the dashboard would be the token — that
 * is, the extra barrier that was wanted, silently gone.
 *
 * The comparison is on the request host, not the IP: behind a tunnel everything arrives from
 * 127.0.0.1, and the IP would not distinguish a browser from ChatGPT.
 */
/**
 * A request's hostname, normalized: without port and without the trailing dot.
 *
 * The trailing dot matters: `mcp.example.com.` is the same name as `mcp.example.com` (DNS accepts
 * it, and a tunnel may forward it that way), but string comparison does not — and with a `!==` the
 * surface lock would fail **silently**, which is the worst way to not work.
 */
const requestHost = (request) => normalizeHost(request.headers.host);

/**
 * The actions that change **who can do what**, beyond the panel: the permissions mode (including
 * `bypassPermissions`), auto-approval, and opening a conversation to an external client.
 *
 * They are the "administrative modes" that are not exposed without explicit consent, and the token
 * alone is not enough to say so: the token says **who you are**, not what you decided to leave on.
 * On a hostname that is on the internet, the difference matters.
 */
const cambiaAutorizzazione = (percorso) => /^\/local\/sessions\/[^/]+\/(permissions|auto|mcp)$/.test(percorso);

/**
 * The request comes from **this** machine's browser.
 *
 * Different from `isLocalRequest`, and the difference is everything: that one also lets through
 * whoever sends no `Origin` — a script, `rc` — because it is meant to stop another site's browser,
 * and for that purpose "no origin" is fine. Here, instead, "from this machine" is a **claim about
 * the origin**, and a missing `Origin` does not prove it: whoever wants to get in from outside just
 * omits that header, and the rule falls without anyone having to force anything.
 *
 * A browser always sends `Origin` on POST, even when it is the same site. So requiring it takes
 * nothing away from whoever uses the dashboard, and takes the excuse away from whoever does not.
 */
const fromLocalBrowser = (request) => {
  const origin = request.headers?.origin;
  if (!origin) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

/**
 * The subset `CR_REMOTE_PERMISSIONS` opens from outside: the mode of **this** conversation, and its
 * exposure to ChatGPT. `auto` is not there — see the comment where it is used.
 */
const permessiDaFuori = (percorso) => /^\/local\/sessions\/[^/]+\/(permissions|mcp)$/.test(percorso);

/**
 * A request's path, reduced to the form in which decisions are made.
 *
 * **It is decoded, and that is not a detail.** Express decodes `:param` before running the route:
 * `POST /local/sessions/<id>/%61uto` reaches the handler with `action = 'auto'`, that is, it executes
 * the real action. The lock, which compared the **raw** path with the words written out, did not
 * recognize anything in `%61uto` and let it through — and with the same move one arrived at `%6dcp`,
 * which exposes to ChatGPT a chat that skips permissions. Verified: it answered **200**, without any
 * flag on and without this machine's browser.
 *
 * Decoding makes the lock match **more**, not less: it is the right direction to err in, because
 * here the opening is "everything passes except". And it applies to every way of writing the same
 * byte — `%61uto`, `au%74o`, `%61%75%74%6f` — because it is decoded once before comparing, instead of
 * trying to guess the variants.
 */
function percorsoDi(request) {
  const grezzo = String(request.path ?? '');
  let decodificato = grezzo;
  try {
    decodificato = decodeURIComponent(grezzo);
  } catch {
    // Crooked percent: it is not a write of an action, and it stays what it is — the comparison will
    // treat it as unrecognized.
  }
  return decodificato.toLowerCase().replace(/\/+$/, '');
}

/**
 * What can be done on this path arriving **from outside**, if consent is there.
 *
 * A single rule, used in two places: by the lock (which looks at the path) and by the action handler
 * (which looks at the action already decoded by Express). Two places because one alone is one
 * place: if the lock gets a comparison wrong, the handler still refuses.
 *
 * @returns {{aperto: boolean, motivo: string|null}}
 */
function consensoDaFuori(percorso, config) {
  if (config.singleHostAdmin) return { aperto: true, motivo: null };
  const amministrativa = percorso === '/local/admin' || percorso.startsWith('/local/admin/') || percorso === '/local/shutdown';
  if (config.remotePermissions && permessiDaFuori(percorso)) return { aperto: true, motivo: null };
  return {
    aperto: false,
    motivo: amministrativa
      ? 'the administrative panel opens only from this machine'
      : 'managing permissions from outside is off',
  };
}

/**
 * The same question, for the two places where a mode is written **in the body** instead of the
 * path: creating a conversation, and updating it. Without this, the path lock would be bypassed by
 * writing `permissionMode` in a `POST /local/sessions`.
 */
function modalitaVietataDaFuori(request, config) {
  if (config.singleHostAdmin) return false;
  if (requestHost(request) !== config.mcpHost) return false; // from this machine it is allowed
  const chiesta = request.body?.permissionMode;
  return typeof chiesta === 'string' && chiesta !== '' && chiesta !== config.permissionMode;
}

function mountSurfaceLocks({ app, config, isOwner }) {
  if (config.mcpHost && config.singleHost) {
    // ── a single hostname, two policies ──────────────────────────────────────────────────────
    // The separation does not disappear: it changes shape. From "two hostnames, one per surface" to
    // "two policies on the same hostname, decided per path". The machine (ChatGPT) talks on `/mcp`
    // and the OAuth routes; the person talks on everything else; the operations that act **on the
    // machine** stay locked outside of here.
    app.use((request, response, next) => {
      if (requestHost(request) !== config.mcpHost) {
        next();
        return;
      }
      const percorso = percorsoDi(request);
      const amministrativa = percorso === '/local/admin' || percorso.startsWith('/local/admin/') || percorso === '/local/shutdown';
      if (!amministrativa && !cambiaAutorizzazione(percorso)) {
        next();
        return;
      }

      const consenso = consensoDaFuori(percorso, config);

      // With consent on, the route is a **normal** route: it passes, and its gate says no (401 to
      // whoever has no token), as for all the others. There is nothing to hide here — it is the
      // usual behavior.
      if (consenso.aperto) {
        // The same rail as the websocket: a declared origin, or none (a script with the token). The
        // gate cookie is `SameSite=Lax`, so another site's browser does not carry it anyway — this
        // is the extra belt.
        if (originAllowed(request.headers.origin, config)) {
          next();
          return;
        }
        // "Origin not allowed" is explained only to whoever has already proven they are the owner.
        // Not to a stranger: it would tell them the route exists and that consent is on.
        if (!isOwner(request)) {
          response.status(404).json({ error: 'not found' });
          return;
        }
        response.status(403).json({
          error: 'origin not allowed',
          hint: 'these requests are made from the dashboard address',
          path: percorso,
        });
        return;
      }

      // Closed. Whoever has the token is the owner and deserves to know **why** and how to turn it on
      // — instead of a "not found" that sends them looking for a fault that is not there. Whoever
      // does not have the token is answered as with a path that does not exist: saying "forbidden"
      // would say something is there, and the hint would also say *what* is on.
      if (!isOwner(request)) {
        response.status(404).json({ error: 'not found' });
        return;
      }
      response.status(403).json({
        error: consenso.motivo,
        hint: amministrativa
          ? 'to open it from here too: CR_SINGLE_HOST_ADMIN=1 (opens the whole panel)'
          : 'to turn it on: CR_REMOTE_PERMISSIONS=1 — opens only conversation permissions, not the panel',
        path: percorso,
      });
      return;
    });
  } else if (config.mcpHost) {
    // The machine (ChatGPT) plus the consent round, which is the only piece of OAuth that sees the
    // person's browser: `/authorize` is its public authorization_endpoint, and consent cannot happen
    // elsewhere. Those pages stand on their own (inline styles, no file to load) and are anyway
    // behind the WRA token.
    const machine = new Set(['/mcp', '/register', '/token', '/revoke']);
    const isOurs = (path) => machine.has(path)
      || path.startsWith('/.well-known/')
      || path === '/authorize'
      || path.startsWith('/authorize/');
    app.use((request, response, next) => {
      if (requestHost(request) !== config.mcpHost) {
        next();
        return;
      }
      if (isOurs(percorsoDi(request))) {
        next();
        return;
      }
      response.status(404).json({ error: 'not found' });
    });
  }

  if (config.dashboardHost && config.dashboardHost !== config.mcpHost) {
    // On the other side: the dashboard domain serves the person, and is **not** an OAuth endpoint. A
    // client trying to get a token issued there must find nothing to talk to: the machine has its own
    // address.
    const machineOnly = (path) => path === '/mcp'
      || path === '/register'
      || path === '/token'
      || path === '/revoke'
      || path.startsWith('/.well-known/')
      // And the consent round: it is the issuer's authorization_endpoint, and the issuer is the
      // machine. Leaving it here too, an OAuth code could be issued from the dashboard domain — that
      // is, the two surfaces would become one.
      || path === '/authorize'
      || path.startsWith('/authorize/');
    app.use((request, response, next) => {
      if (requestHost(request) !== config.dashboardHost) {
        next();
        return;
      }
      if (machineOnly(percorsoDi(request))) {
        response.status(404).json({ error: 'not found' });
        return;
      }
      next();
    });
  }
}

/**
 * Mounts the MCP bridge **if** a public URL is configured. The bridge is an extra: without it, the
 * terminal still works.
 */
function mountMcp({ app, config, registry, coordinator, selections, logger }) {
  if (!config.issuerUrl || !config.resourceUrl) {
    logger.warn('MCP bridge off: CR_ISSUER_URL and CR_RESOURCE_URL are missing (the terminal still works)');
    return { enabled: false };
  }

  const issuerUrl = new URL(config.issuerUrl);
  const resourceUrl = new URL(config.resourceUrl);

  const store = new BridgeStore({
    allowedRedirectHosts: config.redirectUriHosts,
    codeTtlMs: config.codeTtlMs,
    accessTokenTtlS: config.accessTokenTtlS,
    refreshTokenTtlS: config.refreshTokenTtlS,
    scope: SCOPE,
    resourceUrl: config.resourceUrl,
    // The only thing that survives a restart: clients registered by themselves. A client that
    // registered yesterday and today is no longer there gets `invalid_client` forever, because it
    // kept its own `client_id` and does not regenerate it.
    clientsFile: config.oauthClientsFile,
  });

  const provider = new BridgeOAuthProvider({ store, scope: SCOPE });
  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    expectedResource: resourceUrl,
  });

  const owner = createOwner(config);
  // Consent is not requested for a request the OAuth router would refuse anyway: the person would
  // approve and then see a 400, and the client would retry forever. The same error the router would
  // give is returned, one step earlier.
  const consent = createConsentGate({
    preflight: (query) => authorizePreflight(store.getClient(String(query?.client_id ?? '')), query),
  });
  const authorizePath = new URL('/authorize', issuerUrl).pathname;
  // One limiter per path: against whoever insists, not against whoever works (the values are in
  // config, and can be lowered from the environment to test them).
  const limits = Object.fromEntries(Object.entries(config.rateLimits).map(([name, rules]) => [name, createRateLimiter(rules)]));
  const limit = (name) => limits[name].middleware();

  /**
   * A trace of what the OAuth surface answers.
   *
   * It is needed because a client saying "the server denied access" leaves nothing to read: without
   * these lines, diagnosis is guessing. With them, ChatGPT's attempt can be read in the history —
   * and that is how the real defect was found (`/.well-known/openid-configuration` requested nine
   * times, always 404, and never a registration).
   *
   * It sits **first**, and before the path rewrites: the path written is the one the client
   * requested, not the one we turned it into, and the request the authorization endpoint gate stops
   * by answering on its own is also visible (after the gate, that response's `finish` would no longer
   * pass through here). Method, path, code and who are written — never bodies, headers, tokens or
   * `client_id`: whoever reads this log must not be able to find a secret in it.
   *
   * It is written to the **file** log (`src/log.mjs`) and not to the injected `logger`: that one is
   * `console`, and the server started by `rc start` has no console.
   */
  const oauthSurface = /^\/(\.well-known\/|mcp$|register$|token$|revoke$|authorize)/;
  const percorsiVisti = new Set();
  app.use((request, response, next) => {
    const method = request.method;
    const route = request.path;
    const chi = String(request.headers['user-agent'] ?? '').slice(0, 80);
    const registrazione = method === 'POST' && route === '/register';
    const scoperta = route.startsWith('/.well-known/');
    // A successful discovery is reported **once per path**: what matters is *which* paths a client
    // requested, and a public endpoint must not be able to fill the log by repeating the same request.
    const primaVolta = scoperta && !percorsiVisti.has(route);
    // `/authorize` is written **always**, even when it answers 200: it is the step the person must
    // see, and it is the one a 200 response would make disappear from the log. The question "did the
    // window reach us, or stop in front?" is answered only this way — and the rate limiter on that
    // path keeps the file small anyway.
    const sempre = route === '/authorize' || route.startsWith('/authorize/');
    response.on('finish', () => {
      const daScrivere = sempre || response.statusCode >= 400 || (registrazione && response.statusCode < 400) || primaVolta;
      if (daScrivere && oauthSurface.test(route)) {
        if (scoperta) percorsiVisti.add(route);
        log.info('OAuth surface', { method, path: route, status: response.statusCode, chi });
      }
    });
    next();
  });

  // The token POST sits *before* the gate: the small page is sent to whoever does not have the token.
  app.post(LOGIN_PATH, limit('login'), express.urlencoded({ extended: false }), owner.login);
  app.use(authorizePath, limit('authorize'), owner.gatePage);
  // Consent comes before the OAuth router: a code is not born without the person having seen who
  // they are giving it to.
  app.get(authorizePath, consent.handleGet);
  app.post(`${authorizePath}/consent`, express.urlencoded({ extended: false }), consent.handlePost);
  /**
   * A direct POST to `/authorize` is the same request **without** passing through the page.
   *
   * The OAuth router accepts it (RFC 6749 §4.1.1 allows form POST) and mints the code: consent lives
   * only in the gate, and the gate is mounted on GET. So a POST produced a code the person had never
   * approved — and nobody saw who it went to — bypassing both the page and the check that the client
   * exists in one stroke. A code is born only from here: `GET /authorize` → page →
   * `POST /authorize/consent`.
   *
   * The round this server needs is the browser's, so the other methods have nothing to do. Better to
   * say it (`405`) than let a client believe it completed the round.
   */
  app.use(authorizePath, (request, response, next) => {
    if (request.method === 'GET') {
      next();
      return;
    }
    response.setHeader('Allow', 'GET');
    response.status(405).json({ error: 'invalid_request', error_description: 'authorization endpoint: GET only' });
  });

  // The limiter goes **before** the OAuth router, which mounts /register, /token and /revoke itself:
  // they are the only paths of that router reachable from outside without already being authenticated.
  app.use(['/register', '/token', '/revoke'], limit('token'));

  /**
   * The two discovery paths the SDK does **not** serve, and which real clients call anyway.
   *
   * 1. `/.well-known/oauth-protected-resource` (the PRM **at the root**). It is the path of RFC 9728
   *    §3 — and also the one in the MCP specification's diagram — while the SDK serves only the
   *    variant with the resource path (`…/oauth-protected-resource/mcp`, §3.1). At the root there was
   *    a 404 with Express's "Cannot GET" page.
   *
   * 2. `/.well-known/openid-configuration` (the **authorization server metadata** in the OIDC
   *    location). No OpenID Provider is invented here: the **same document** as
   *    `…/oauth-authorization-server` is served — no `userinfo_endpoint`, no `id_token_signing_alg_*`,
   *    no `openid` scope, because we do not have them and do not declare them. It is the location
   *    OpenAI's documentation puts on the same level as the other ("publish discovery metadata at
   *    either the OAuth 2.0 or OIDC well-known location"), and it is the same thing the other MCP
   *    servers ChatGPT connects do.
   *
   * Why it was needed: while testing the connector, OpenAI's platform (`Python/aiohttp`) requested
   * `/.well-known/openid-configuration` **nine times**, getting 404 each time, and never registered a
   * client. It was the last thing it did before giving up: the first decisive failure was neither
   * Access nor the consent page, it was a document that was not there.
   *
   * It **rewrites** instead of writing the documents twice: two copies diverge, and the one the
   * client reads must be the same. The resource path is taken from `CR_RESOURCE_URL`, not written by
   * hand, so the variant stays tied to the configuration.
   */
  const RICONDUZIONI = new Map([
    ['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${resourceUrl.pathname === '/' ? '' : resourceUrl.pathname}`],
    ['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server'],
  ]);
  app.use((request, _response, next) => {
    const destinazione = RICONDUZIONI.get(request.path);
    if (destinazione) {
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      request.url = `${destinazione}${query}`;
    }
    next();
  });

  app.use(mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: resourceUrl,
    scopesSupported: [SCOPE],
    resourceName: 'WRA',
  }));

  // Stateless: server and transport per request. The OAuth client (clientId) ties the chat choice:
  // every connection has its own.
  app.post('/mcp', limit('mcp'), bearer, async (request, response) => {
    const clientId = request.auth?.clientId ?? 'anonymous';
    const tools = createMcpTools({ config, registry, coordinator, selections, clientId });
    const mcp = createMcpServer({ tools });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => {
      transport.close();
      mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });

  const methodNotAllowed = (_request, response) => {
    response.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } });
  };
  app.get('/mcp', bearer, methodNotAllowed);
  app.delete('/mcp', bearer, methodNotAllowed);

  return { enabled: true, store, provider, owner };
}

/**
 * @param {object} input
 * @param {() => void} [input.onShutdown]  how it shuts down **well**: the server and its PTYs close it,
 *   not a signal. Whoever mounts the server knows what has to be closed; here we only know *when*.
 */
export function createServer({ config, registry, logger = console, onShutdown = () => process.exit(0) }) {
  // The turn journal sits next to the registry: it is what makes resending the same `requestId`
  // harmless even after a server restart.
  const journal = createTurnJournal({ file: config.turnJournalFile, size: config.turnJournalSize });
  const coordinator = createTurnCoordinator({ config, registry, journal });
  const selections = createSelections();
  // The organizational metadata of projects lives next to the registry but in a file of its own: a
  // wrong name there cannot cost a conversation.
  const projects = createProjectStore({ file: config.projectsFile });
  projects.load();

  // "Controlled automatic MCP": the policy is built **on the stores**, not on a copy of the state.
  // Every permission request re-reads the conversation switch and the project one, so turning it off
  // applies from the next request — no restart, no cache to invalidate, and no way to "stay on" by
  // inertia.
  const autoPolicy = createAutoPolicy({
    sessionFor: (sessionId) => registry.get(sessionId),
    projectFor: (projectPath) => projects.get(projectPath),
  });
  const approvals = createApprovals({ config, policy: autoPolicy });

  /** The projects as the interface sees them: folders with conversations ∪ registered folders. */
  const projectList = () => buildProjects({ sessions: registry.list(), stored: projects.all() });

  // A session that dies must not leave a request hanging: whoever waits must be able to exit
  // immediately (and their dialog reappear, if the terminal is still there).
  registry.onEvent((event) => {
    if (event.type === 'state' && event.session.state === 'exited') approvals.clear(event.session.sessionId);
  });

  // A permission granted without asking leaves a line in the log: it is the only way to know,
  // afterwards, what went through while nobody was looking. The tool name and the reason, not the
  // content.
  approvals.onEvent((event) => {
    if (event.type !== 'auto') return;
    log.info('permission granted without asking', {
      sessionId: event.approval.sessionId,
      tool: event.approval.toolName,
      reason: event.approval.reason,
    });
  });

  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy (tunnel, Caddy, nginx) X-Forwarded-* arrive: trust only the proxy on
  // loopback, not a header written by anyone.
  app.set('trust proxy', 'loopback');
  app.use(securityHeaders);
  app.use(express.json({ limit: '2mb' }));

  // The surface locks are mounted **always**, before everything else and regardless of the MCP
  // bridge: the dashboard domain must not be able to become an OAuth endpoint just because the
  // bridge is off.
  mountSurfaceLocks({ app, config, isOwner: (request) => owner?.isOwner?.(request) ?? false });
  const mcp = mountMcp({ app, config, registry, coordinator, selections, logger });
  const owner = mcp.owner ?? createOwner(config);

  // Health: it is not public. It lists the sessions and ids, which is the owner's business.
  app.get('/healthz', (request, response) => {
    const token = request.get('x-cc-remote-token') ?? (typeof request.query.token === 'string' ? request.query.token : '');
    if (!sameToken(token, config.token) && !(owner.isOwner?.(request) ?? false)) {
      response.status(401).json({ error: 'token required' });
      return;
    }
    response.json({
      ok: true,
      proto: 2,
      mcp: mcp.enabled,
      sessions: registry.list(),
      mcpSelections: selections.list(),
      // What is running now: how many queues, for how long, and how many permission requests are
      // pending. It is the part needed to understand "is it stuck or working?".
      turns: coordinator.snapshot(),
      approvals: approvals.list().length,
      autoApprovals: approvals.autoCount(),
      journal: journal.size(),
      clients: web.stats(),
      // The bridge: if on, how many consents and how many tokens are around. Behind the person's
      // gate, so nothing secret — but no tokens, not even here: only counts.
      oauth: mcp.enabled
        ? { ...mcp.store.count, authorizationEndpoint: '/authorize', resource: config.resourceUrl, host: config.mcpHost || null }
        : null,
    });
  });

  // --- local API: the same thing the browser sees, for scripts and the CLI ----------------
  // It goes through the person's gate (token in the header, cookie or ?token=): it is the same secret
  // the user already has, so it opens nothing new. The target is never global: every call says which
  // session it wants.
  app.get('/local/sessions', owner.gate, (_request, response) => {
    // Projects travel with the conversations: the list is drawn once, and the browser does not have
    // to guess a project name from a Windows path.
    response.json({
      sessions: registry.list(),
      projects: projectList(),
      selections: selections.list(),
      approvals: approvals.list(),
      // Recent automatic grants: whoever opens the dashboard must be able to see what went through
      // without asking, not only what is waiting now.
      autoApprovals: approvals.autoList(),
    });
  });

  app.post('/local/sessions', owner.gate, (request, response) => {
    // The mode is requested explicitly, and bypass is requested only by the local CLI, for itself.
    // Here it is **verified** that this is the case: without it, writing `permissionMode` in the body
    // of a request arriving from the internet was enough to create a conversation that never asks for
    // permission. The path lock would not cover it — the mode, in this route, is in the body.
    if (modalitaVietataDaFuori(request, config)) {
      response.status(404).json({ error: 'not found' });
      return;
    }
    try {
      const session = registry.create({
        projectPath: request.body?.projectPath ?? config.defaultProject,
        name: request.body?.name ?? null,
        permissionMode: request.body?.permissionMode ?? null,
      });
      response.json({ session });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post('/local/sessions/:id/:action', owner.gate, (request, response) => {
    const { id, action } = request.params;
    // The belt, in addition to the suspenders. The surface lock decides on the **path**, and a path
    // can be written in several ways (`%61uto`): Express decodes before arriving here, so the action
    // about to be executed is checked **here**, on the real word. One rule, two places that apply it:
    // if the first gets a comparison wrong, this one refuses.
    if (requestHost(request) === config.mcpHost && ['permissions', 'auto', 'mcp'].includes(action)) {
      const consenso = consensoDaFuori(`/local/sessions/x/${action}`, config);
      if (!consenso.aperto) {
        response.status(403).json({ error: consenso.motivo, hint: 'this mode is changed from this machine', action });
        return;
      }
    }
    try {
      if (action === 'rename') {
        response.json({ session: registry.rename(id, request.body?.name ?? '') });
      } else if (action === 'mcp') {
        const allowed = request.body?.allowed === true;
        // Exposing a chat that skips permissions to MCP is a consent given **from this machine**: it
        // is rule 2 of the administrative routes (the action that raises a privilege only from the
        // browser here), applied to the only point that deserves it. For normal chats nothing
        // changes: exposure can also be turned on from the phone, as before.
        // `CR_REMOTE_PERMISSIONS=1` moves this decision where the owner needs it: from the phone. The
        // consent remains the same — the confirmation that repeats the chat name, the date, the
        // expiry — and only **where** it can be given changes. Without that flag, the previous rule:
        // authorization is given from this machine's browser.
        // **On the public hostname "from this machine" cannot be proven.** The `Origin` is written by
        // the client — and whoever wants to get in from outside writes whatever they like — while
        // the socket is `127.0.0.1` anyway, because the tunnel is in front: there is nothing, in a
        // request arriving from there, that distinguishes your browser from someone else's. So on
        // that hostname the only thing that authorizes exposing a chat that skips permissions is the
        // **explicit consent** (`CR_REMOTE_PERMISSIONS`), which is a decision and not a header.
        //
        // Outside the public hostname the distinction makes sense and is used: the dashboard on
        // `127.0.0.1` sends `Origin: http://127.0.0.1:4310`, and that really is this machine.
        const suHostPubblico = requestHost(request) === config.mcpHost;
        const daQuestaMacchina = !suHostPubblico && fromLocalBrowser(request);
        if (allowed && registry.get(id)?.permissionMode === 'bypassPermissions'
          && !daQuestaMacchina && !config.remotePermissions) {
          response.status(403).json({
            error: 'exposing a chat that skips permissions to ChatGPT is authorized from this machine\'s browser',
            hint: 'to do it from outside too (phone, tailnet): CR_REMOTE_PERMISSIONS=1',
          });
          return;
        }
        const before = registry.get(id);
        const session = registry.setMcpAllowed(id, allowed, { confirm: request.body?.confirm ?? null });
        // The operations log: a high-privilege grant and its revocation are written **when they
        // happen**, with the chat and when. It is the only way to know, afterwards, how long that
        // combination had been on and who turned it on.
        if (session.mcpBypassAt && !before?.mcpBypassAt) {
          log.info('high-privilege exposure', { sessionId: id, name: session.name, quando: session.mcpBypassAt });
        } else if (!session.mcpBypassAt && before?.mcpBypassAt) {
          log.info('high-privilege exposure revoked', { sessionId: id, name: session.name });
        }
        response.json({ session });
      } else if (action === 'permissions') {
        const before = registry.get(id);
        const session = registry.setPermissionMode(id, request.body?.mode);
        // Changing mode drops the consent (in `setPermissionMode`), and it is a revocation in every
        // respect: if it were not written here, the only revocation **not** recorded would be the one
        // passing through the most common gesture — and the operations log would tell half the story.
        if (before?.mcpBypassAt && !session.mcpBypassAt) {
          log.info('high-privilege exposure revoked', { sessionId: id, name: session.name, causa: `mode ${session.permissionMode}` });
        }
        response.json({ session });
      } else if (action === 'auto') {
        response.json({ session: registry.setAutoApprove(id, request.body?.enabled === true) });
      } else if (action === 'start') {
        response.json({ session: registry.start(id) });
      } else if (action === 'stop') {
        response.json({ session: registry.stop(id) });
      } else if (action === 'archive') {
        response.json({ session: registry.setArchived(id, request.body?.archived !== false) });
      } else if (action === 'favorite') {
        response.json({ session: registry.setFavorite(id, request.body?.favorite !== false) });
      } else if (action === 'label') {
        response.json({ session: registry.setLabel(id, request.body?.label ?? '') });
      } else if (action === 'forget') {
        response.json({ forgotten: registry.forget(id) });
      } else {
        response.status(404).json({ error: `unknown action: ${action}` });
      }
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  // --- projects: organizational metadata ------------------------------------
  // None of this touches the disk: the name is a label, the star and hidden are preferences, and the
  // real folder stays where it is. The only action that *does* something on the machine is `open`, and
  // that is why it accepts only requests from here.
  app.post('/local/projects/:action', owner.gate, (request, response) => {
    const { action } = request.params;
    const raw = String(request.body?.path ?? '').trim();
    const key = pathKey(raw);
    const known = projects.get(raw);
    const registered = registry.list().find((session) => session.projectKey === key);
    const hasSessions = Boolean(registered);
    // The path saved is the **real** one, not the spelling it arrived with: the key treats the two
    // spellings as the same folder, and showing one different from the conversations' would only be
    // confusing.
    const canonical = known?.path ?? registered?.projectPath ?? raw;

    try {
      if (action === 'add') {
        // A new folder must really exist and be under the allowed roots: it is the same rule with
        // which an agent is started, and it must not be wider just because nothing is started here.
        const checked = resolveProjectDir(raw, { allowedRoots: config.allowedRoots, home: config.home });
        if (!checked.ok) {
          response.status(400).json({ error: checked.reason });
          return;
        }
        const project = projects.set(checked.path, { name: request.body?.name ?? '' });
        response.json({ project, projects: projectList() });
        return;
      }
      if (action === 'update') {
        if (!known && !hasSessions) {
          response.status(400).json({ error: 'unknown project' });
          return;
        }
        const project = projects.set(canonical, {
          name: typeof request.body?.name === 'string' ? request.body.name : undefined,
          favorite: typeof request.body?.favorite === 'boolean' ? request.body.favorite : undefined,
          hidden: typeof request.body?.hidden === 'boolean' ? request.body.hidden : undefined,
          // It applies to the conversations of this folder that have not chosen for themselves: it is
          // the project switch, and it stays off until it is turned on here.
          autoApprove: typeof request.body?.autoApprove === 'boolean' ? request.body.autoApprove : undefined,
        });
        response.json({ project, projects: projectList() });
        return;
      }
      if (action === 'forget') {
        // Forgetting a project removes **metadata**: the folder on disk stays, its conversations stay,
        // the transcripts stay. It is the only action of this route that removes something, so it is
        // also the only one that requires the explicit list of what to remove: the server does not
        // decide by itself which entries are test entries — that decision has tests, and the tests are
        // where they can be seen (`src/core/registry-hygiene.mjs`).
        const quali = Array.isArray(request.body?.paths)
          ? request.body.paths.filter((voce) => typeof voce === 'string' && voce.trim())
          : [];
        if (!quali.length) {
          response.status(400).json({ error: 'no entries to forget' });
          return;
        }
        // The backup is kept by `save()`: a single write, so the copy is how the file was before.
        const removed = projects.forget(quali);
        response.json({ removed, projects: projectList() });
        return;
      }
      if (action === 'open') {
        if (!isLocalRequest(request, config)) {
          response.status(403).json({ error: 'a folder can only be opened from this machine' });
          return;
        }
        const checked = resolveProjectDir(raw, { allowedRoots: config.allowedRoots, home: config.home });
        if (!checked.ok) {
          response.status(400).json({ error: checked.reason });
          return;
        }
        openFolder(checked.path);
        response.json({ opened: checked.path });
        return;
      }
      if (action === 'remove') {
        // The metadata is forgotten, and only if there is nothing left inside: a project with
        // conversations leaves the list with "hide", which is reversible.
        if (hasSessions) {
          response.status(400).json({ error: 'this project still has conversations: hide it instead of forgetting it' });
          return;
        }
        response.json({ removed: projects.remove(canonical), projects: projectList() });
        return;
      }
      response.status(404).json({ error: `unknown action: ${action}` });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  // Search **inside** the conversations. It is the only route that reads transcripts on request, so it
  // has a time cap and a byte cap, and while reading it returns the turn to the event loop: two tabs
  // searching together do not block the terminal, the approvals, or each other.
  let searchQueue = Promise.resolve();
  app.get('/local/search', owner.gate, async (request, response) => {
    const query = String(request.query?.q ?? '');
    // Recent conversations first: with the time cap, order is priority, and this morning's chat
    // counts more than June's.
    const when = (session) => Date.parse(session.lastActivityAt ?? session.createdAt ?? '') || 0;
    const sessions = registry.list().filter((session) => !session.archived).sort((a, b) => when(b) - when(a));

    // One at a time: two tabs searching together queue up instead of doubling disk reads. The queue
    // holds on a `catch` because a round gone wrong must not block the ones after it.
    const run = searchQueue.then(() => searchConversations({ sessions, query }));
    searchQueue = run.then(() => undefined, () => undefined);
    try {
      response.json(await run);
    } catch (error) {
      // `searchConversations` does not throw — every read is already protected — but one day it could:
      // better a clear line than Express's stack in the response body.
      response.status(500).json({ error: `search failed: ${error.message}` });
    }
  });

  app.get('/local/sessions/:id/chat', owner.gate, (request, response) => {
    response.json({ messages: web.history(request.params.id) });
  });

  // --- permission approvals ------------------------------------------------
  // The person decides, and the person is whoever has the token: this endpoint adds no new way in, it
  // uses the same gate as everything else.
  app.get('/local/approvals', owner.gate, (_request, response) => {
    response.json({ approvals: approvals.list() });
  });

  app.post('/local/approvals/:id', owner.gate, (request, response) => {
    try {
      const decided = approvals.decide(request.params.id, {
        behavior: request.body?.behavior,
        message: request.body?.message,
      });
      if (!decided) {
        response.status(404).json({ error: 'request no longer pending' });
        return;
      }
      response.json({ approval: decided });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  // The hook inside `claude` calls here, and stays pending until the person answers.
  // The answer can also be "I am not deciding": then the terminal shows its dialog.
  app.post('/local/approve', owner.gate, async (request, response) => {
    const sessionId = String(request.body?.sessionId ?? '');
    const toolName = String(request.body?.toolName ?? '');
    if (!registry.exists(sessionId) || !toolName) {
      response.json({ decision: null });
      return;
    }
    const decision = await approvals.ask({
      sessionId,
      toolName,
      input: request.body?.input && typeof request.body.input === 'object' ? request.body.input : {},
      suggestions: Array.isArray(request.body?.suggestions) ? request.body.suggestions : [],
    });
    response.json({ decision });
  });

  // Detach requested by the CLI: `rc detach` makes attached windows let go. It is needed because
  // detaching must not depend on a key — if the terminal eats Ctrl+Q, there is still a way. It concerns
  // **only** `rc attach` windows: the browser would reconnect by itself, so it is not touched.
  app.post('/local/detach', owner.gate, (request, response) => {
    const sessionId = typeof request.body?.sessionId === 'string' && request.body.sessionId ? request.body.sessionId : null;
    response.json({ detached: web.detach(sessionId) });
  });

  // Shutdown requested by the CLI: it goes through the gate, and closes the terminals in an orderly way.
  app.post('/local/shutdown', owner.gate, (_request, response) => {
    response.json({ stopping: true });
    // The shutdown is done by the server itself, not by a signal to itself: on Windows `SIGTERM` is
    // `TerminateProcess`, that is, no cleanup — the process died without closing the PTYs and without
    // removing its own `server.json`, which remained there pointing to a pid that was no longer its own.
    setTimeout(() => onShutdown(), 150).unref();
  });

  app.post('/local/talk', owner.gate, async (request, response) => {
    const sessionId = String(request.body?.sessionId ?? '');
    const message = String(request.body?.message ?? '');
    const requestId = typeof request.body?.requestId === 'string' && request.body.requestId ? request.body.requestId : null;
    try {
      const { turn, reused } = coordinator.submit({ sessionId, message, source: 'local', requestId });
      const waited = await coordinator.settle(turn, (config.defaultWaitSeconds ?? 25) * 1000);
      response.json({ turn: { ...waited, reused } });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  const server = http.createServer(app);
  // The hook request stays pending until the person answers: Node's default limit (5 minutes) would cut
  // it first, and the cut would look like a bridge failure.
  server.requestTimeout = Math.max(300_000, config.approvalTtlMs + 60_000);
  const web = attachWeb({ server, registry, coordinator, approvals, config });

  // --- administration ------------------------------------------------------
  // In a file of its own (`src/net/admin.mjs`): the routes that can change something on the machine are
  // read all together, with their four rules (token, origin, confirmation, no commands from the
  // browser). It is mounted **before** the static files, so a path cannot be served as a page by
  // mistake.
  const admin = mountAdmin({
    // The configuration is bound here, once: whoever receives `isLocalRequest` asks "from this
    // machine?" and that is it, without having to know that in single-host the answer depends on an
    // explicit consent. A single signature, and the rule in one place.
    app, config, registry, mcp, approvals, journal, web, owner,
    isLocalRequest: (request) => isLocalRequest(request, config),
    onShutdown, logger,
  });

  // The UI is static and without a bundler: xterm is served from the installed packages.
  app.use('/', express.static(webDir, {
    extensions: ['html'],
    // A PWA manifest must be served with its type: with `text/plain` the browser ignores it and the app
    // does not appear installable — without saying why.
    setHeaders: (response, file) => {
      if (file.endsWith('.webmanifest')) response.setHeader('content-type', 'application/manifest+json');
    },
  }));
  // The new UI is a SPA: browser routes (`/c/:id`, `/projects`, `/settings`) are not files, and without
  // this a reload on one of them would answer 404. GET only, and never under routes that have already
  // answered above.
  if (useNextUi) {
    app.get(/^\/(?!local\/|mcp|healthz|authorize|register|token|revoke|vendor\/|\.well-known\/).*/, (_request, response) => {
      response.sendFile(path.join(webDir, 'index.html'));
    });
  }
  app.use('/vendor/xterm', express.static(packageDir('@xterm/xterm')));
  app.use('/vendor/fit', express.static(packageDir('@xterm/addon-fit')));

  return { app, server, web, mcp, coordinator, selections, approvals, journal, admin };
}