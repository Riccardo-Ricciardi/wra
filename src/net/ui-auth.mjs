import crypto from 'node:crypto';

// The human gate. In the old rig it was Cloudflare Access (a JWT verified against their JWKS):
// here it is a single token of our own, because the project must not depend on a provider. The
// person authorizing an MCP client presents the token; the machine client then gets its OAuth
// token from our authorization server (src/mcp/auth).
export const OWNER_COOKIE = 'cc_remote_owner';
export const LOGIN_SUFFIX = '/login';
export const LOGIN_PATH = '/authorize/login';

export const sameToken = (given, expected) => {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/**
 * The human gate and its login. The cookie **is not the token**: it is an opaque identifier that
 * the server maps to an expiry. Thus a leaked cookie (a proxy log, an extension) does not hand
 * over the house key, and a browser session can be revoked without changing the token. `Secure`
 * is added only if the request arrived over HTTPS: on `http://127.0.0.1` a Secure cookie would not
 * be sent back.
 */
export function createOwner(config, { ttlMs = 30 * 24 * 3_600_000, now = () => Date.now() } = {}) {
  const sessions = new Map(); // opaque id -> expiry

  const prune = () => {
    const at = now();
    for (const [id, expiry] of sessions) if (expiry < at) sessions.delete(id);
  };

  const isOwner = (request) => {
    prune();
    const id = cookieValue(request, OWNER_COOKIE);
    if (id && sessions.has(id)) return true;
    return sameToken(headerOrQueryToken(request), config.token);
  };

  /**
   * The gate, in two forms that differ in **one** thing: what is returned to someone who is not the
   * person and is not a browser.
   *
   * `gate` is the one used by all the machine routes: without a token, a 401 with JSON. It is the
   * right answer for a resource, and the caller is a client that can read (the panel, `rc`, a
   * script), or an error to display.
   *
   * `gatePage` is the one used by the **authorization endpoint**, and it always shows the login
   * page. The difference is not cosmetic: an OAuth client that requests `/authorize` and receives a
   * 401 can read nothing there but "the server denied me access" — and that is the message that
   * stops the ChatGPT connection **before** any login page. An authorization endpoint, by
   * convention, always answers with a page: login, consent, or error.
   *
   * Nothing about the protection changes in either one: the page contains no secrets, the only
   * thing that authenticates is the POST of the token, and consent remains a separate step that the
   * code does not skip.
   */
  const gateWith = ({ page }) => (request, response, next) => {
    if (isOwner(request)) {
      request.accessIdentity = { sub: 'owner', email: 'owner' };
      next();
      return;
    }
    const wantsHtml = request.method === 'GET' && (request.headers.accept ?? '').includes('text/html');
    if (page || wantsHtml) {
      response.type('html').send(loginPage({ action: LOGIN_PATH, next: request.originalUrl }));
      return;
    }
    response.status(401).json({ error: 'WRA token required (x-cc-remote-token header, cookie, or ?token=)' });
  };

  return {
    /**
     * The gate's same question, without an answer: "is the caller the owner?".
     *
     * It is needed where refusal cannot be given immediately — the surface lock must be able to say
     * **what** is missing to someone who has already proven they are the owner, and stay silent with
     * everyone else. The token or the browser session, exactly as the gate accepts them: two roads
     * to the same question, and a single answer.
     */
    isOwner,

    /** Authenticates the person, or shows them the token page. */
    gate: gateWith({ page: false }),
    /** The same, for the authorization endpoint: the page is shown to anyone. */
    gatePage: gateWith({ page: true }),

    /** Token POST: creates the browser session and returns to where we were going. */
    login: (request, response) => {
      const token = typeof request.body?.token === 'string' ? request.body.token.trim() : '';
      const next = safeNext(request.body?.next);
      if (!sameToken(token, config.token)) {
        response.status(401).type('html').send(loginPage({ action: LOGIN_PATH, next, error: 'Wrong token.' }));
        return;
      }
      const id = crypto.randomBytes(24).toString('hex');
      sessions.set(id, now() + ttlMs);
      const secure = request.secure || String(request.get('x-forwarded-proto') ?? '').startsWith('https');
      response.setHeader(
        'Set-Cookie',
        `${OWNER_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${Math.floor(ttlMs / 1000)}`,
      );
      response.redirect(next);
    },

    /** How many browser sessions are open (for `rc status`). */
    count: () => {
      prune();
      return sessions.size;
    },
  };
}

function cookieValue(request, name) {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        // malformed cookie (`%` alone): not a session, and must not blow anything up
        return '';
      }
    }
  }
  return '';
}

function headerOrQueryToken(request) {
  const header = request.get('x-cc-remote-token');
  if (typeof header === 'string' && header) return header;
  return typeof request.query.token === 'string' ? request.query.token : '';
}

export function loginPage({ action, next, error = '' }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WRA — sign in</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1318; color: #e7ebef;
         font-family: system-ui, sans-serif; }
  form { background: #171c22; border: 1px solid #2a323b; border-radius: 6px; padding: 1.25rem 1.5rem;
         width: min(22rem, 90vw); display: flex; flex-direction: column; gap: .6rem; }
  h1 { font-size: 1rem; margin: 0; }
  p { margin: 0; color: #9aa6b2; font-size: .8rem; line-height: 1.5; }
  code { font-family: ui-monospace, monospace; color: #6fc0cf; }
  input { background: #0f1318; border: 1px solid #2a323b; border-radius: 4px; color: inherit; padding: .5rem;
          font-family: ui-monospace, monospace; }
  button { background: #6fc0cf; border: 0; border-radius: 4px; color: #0f1318; font-weight: 600; padding: .5rem; cursor: pointer; }
  .err { color: #d1705f; min-height: 1em; }
</style></head>
<body>
  <form method="post" action="${action}">
    <h1>Authorize an MCP client</h1>
    <p>Paste the WRA token (printed by <code>wra serve</code>, stored in <code>~/.cc-remote/token</code>).
       It is needed once: after that it stays in a cookie on this machine.</p>
    <input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}">
    <input type="password" name="token" placeholder="token" autocomplete="current-password" required autofocus>
    <button type="submit">authorize</button>
    <p class="err">${error}</p>
  </form>
</body></html>`;
}
// --- Consent ----------------------------------------------------------------
//
// An OAuth code must not be born without the person having seen *who* they are giving it to.
// Without this step, a click on a prepared link (the Lax cookie also travels in cross-site
// navigations) was enough for a never-seen client to receive the grant — that is, a bearer that
// commands the agent's keyboard. Here the code is issued only after a POST that started from the
// consent page, and the consent applies to that single request.

const CONSENT_TTL_MS = 2 * 60_000;

const consentKey = (query) => crypto
  .createHash('sha256')
  .update([query.client_id, query.redirect_uri, query.code_challenge, query.state].map(String).join('|'))
  .digest('hex');

function safeNext(value) {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/')) return '/';
  // `//evil.com` and `/\evil.com` are normalized by the browser into an absolute address: they
  // are open redirects disguised as relative paths.
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

/**
 * `preflight` is the question asked **before** requesting consent: "could this request ever end up
 * in a code?". The gate knows *who* is asking but is not the authorization server, and without
 * this question it also asked for consent for a `client_id` that does not exist: the person
 * approved, received a 400, and the client — which reads 400 as "retry" — reopened `/authorize`
 * and got the consent page again. A loop that never ended.
 *
 * The gate remains ignorant of OAuth: it receives a function that answers `null` or the error to
 * return.
 */
export function createConsentGate({ ttlMs = CONSENT_TTL_MS, now = () => Date.now(), preflight = null } = {}) {
  const granted = new Map(); // request key -> expiry (already approved)
  const pending = new Map(); // page nonce -> request key

  const prune = () => {
    const at = now();
    for (const [key, expiry] of granted) if (expiry < at) granted.delete(key);
    for (const [nonce, entry] of pending) if (entry.expiry < at) pending.delete(nonce);
  };

  return {
    /** GET /authorize: if consent already exists, proceed; otherwise ask. */
    handleGet: (request, response, next) => {
      prune();
      const refusal = preflight?.(request.query);
      if (refusal) {
        response.status(400).json(refusal);
        return;
      }
      const key = consentKey(request.query);
      if (granted.has(key)) {
        granted.delete(key); // valid for a single request
        next();
        return;
      }
      const nonce = crypto.randomBytes(16).toString('hex');
      pending.set(nonce, { key, expiry: now() + ttlMs });
      response.type('html').send(consentPage({
        action: `${LOGIN_PATH.replace(/\/login$/, '')}/consent`,
        nonce,
        clientId: String(request.query.client_id ?? '(unnamed)'),
        redirectUri: String(request.query.redirect_uri ?? '(none)'),
        next: request.originalUrl,
      }));
    },

    /** POST /authorize/consent: only here is permission born. */
    handlePost: (request, response) => {
      prune();
      const nonce = typeof request.body?.nonce === 'string' ? request.body.nonce : '';
      const next = safeNext(request.body?.next);
      const entry = pending.get(nonce);
      pending.delete(nonce);

      const denied = request.body?.decision === 'deny';
      if (!entry || denied) {
        response.type('html').send(consentPage({
          action: `${LOGIN_PATH.replace(/\/login$/, '')}/consent`,
          nonce: '',
          clientId: '(request expired or rejected)',
          redirectUri: '',
          next,
          error: denied ? 'Request rejected: no access granted.' : 'Consent expired: try again from the original request.',
        }));
        return;
      }

      granted.set(entry.key, now() + ttlMs);
      response.redirect(next);
    },
  };
}

export function consentPage({ action, nonce, clientId, redirectUri, next, error = '' }) {
  const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WRA — consent</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1318; color: #e7ebef;
         font-family: system-ui, sans-serif; }
  form { background: #171c22; border: 1px solid #2a323b; border-radius: 6px; padding: 1.25rem 1.5rem;
         width: min(30rem, 92vw); display: flex; flex-direction: column; gap: .8rem; }
  h1 { font-size: 1rem; margin: 0; }
  dl { margin: 0; display: grid; grid-template-columns: 8rem 1fr; gap: .3rem .8rem; font-size: .85rem; }
  dt { color: #9aa6b2; }
  dd { margin: 0; word-break: break-all; }
  code { font-family: ui-monospace, monospace; color: #6fc0cf; }
  .row { display: flex; gap: .6rem; }
  button { flex: 1; border-radius: 4px; font-weight: 600; padding: .55rem; cursor: pointer; border: 1px solid #2a323b;
           background: #0f1318; color: #e7ebef; }
  button[value="allow"] { background: #6fc0cf; border-color: #6fc0cf; color: #0f1318; }
  .err { color: #d1705f; min-height: 1em; margin: 0; font-size: .8rem; }
</style></head>
<body>
  <form method="post" action="${esc(action)}">
    <h1>A client wants to talk to the agent</h1>
    <dl>
      <dt>Client</dt><dd><code>${esc(clientId)}</code></dd>
      <dt>Returns to</dt><dd><code>${esc(redirectUri)}</code></dd>
    </dl>
    <p class="err">${esc(error)}</p>
    <input type="hidden" name="nonce" value="${esc(nonce)}">
    <input type="hidden" name="next" value="${esc(next)}">
    <div class="row">
      <button type="submit" name="decision" value="allow">Allow once</button>
      <button type="submit" name="decision" value="deny">Reject</button>
    </div>
  </form>
</body></html>`;
}