import crypto from 'node:crypto';
import fs from 'node:fs';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { writeFileAtomic } from '../../core/atomic.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Where a client may have its code sent back. HTTPS only, and only hosts on the list.
 *
 * The host is compared **exactly**: with suffix matching (`endsWith('.openai.com')`) something
 * like `anything.openai.com` would also pass, that is, any subdomain — and one open redirect or
 * XSS on one of those is enough to carry the code away. A subdomain is accepted only if it is
 * written on purpose, as `*.example.com`.
 */
export function redirectAllowed(uri, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const host = String(entry).trim().toLowerCase();
    if (!host) return false;
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      return hostname.endsWith(`.${base}`) && hostname !== base;
    }
    return hostname === host;
  });
}

/**
 * The question the authorization endpoint asks **before** asking the person for consent:
 * "could this request ever end up in a code?".
 *
 * It is needed because the consent gate sits *before* the OAuth router, and the OAuth router is
 * what knows the clients: without this check the person sees the consent page, approves, and only
 * **afterwards** gets a 400 — and the client, which reads 400 as "retry", reopens `/authorize` and
 * gets the consent page again. A lost client_id thus produced an authorization loop that never
 * ended and in which the person could not understand what they were doing wrong.
 *
 * The two rules are the same as the SDK's, and are written here so as not to duplicate them in the
 * gate: the client must exist, and the requested `redirect_uri` must be **one of the registered
 * ones**, compared exactly. The only difference from the SDK is that the RFC 8252 loopback port
 * exception does not apply here: the list of allowed redirects contains host names only (no
 * `localhost` by default), so `https://localhost` does not pass anyway. If that ever changed,
 * this line would be **stricter** than the SDK — it would refuse a request the router accepts, not
 * the other way around.
 *
 * @returns {null | {error: string, error_description: string}} `null` if it can proceed
 */
export function authorizePreflight(client, query) {
  if (!client) return { error: 'invalid_client', error_description: 'Invalid client_id' };
  const registered = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  const requested = query?.redirect_uri;
  if (requested === undefined) {
    return registered.length === 1
      ? null
      : { error: 'invalid_request', error_description: 'redirect_uri must be specified when client has multiple registered URIs' };
  }
  // A repeated parameter arrives as a list: the SDK rejects it (it expects a string), and
  // accepting it here would recreate the consent → 400 loop being removed.
  if (typeof requested !== 'string') {
    return { error: 'invalid_request', error_description: 'Unregistered redirect_uri' };
  }
  return registered.includes(requested)
    ? null
    : { error: 'invalid_request', error_description: 'Unregistered redirect_uri' };
}

export class BridgeStore {
  #clients = new Map();
  #codes = new Map();
  #access = new Map();
  #refresh = new Map();
  #usedRefresh = new Map(); // fingerprint -> family (to notice reuse)

  /**
   * `clientsFile` is the only thing that survives a restart, and it is **only** the list of
   * registered clients: codes, access tokens and refresh tokens stay in memory and keep expiring
   * or being revocable as before. A registered client is configuration data (who presented
   * itself, and where it can return); a token is a live credential, and a credential that survives
   * a restart is a credential nobody decided to keep.
   *
   * Without `clientsFile` everything stays in memory: that is the shape used by tests that want a
   * disposable store.
   */
  constructor({ allowedRedirectHosts, codeTtlMs, accessTokenTtlS, refreshTokenTtlS, scope, resourceUrl, usedRefreshLimit = 500, clientsFile = null }) {
    this.allowedRedirectHosts = allowedRedirectHosts;
    this.codeTtlMs = codeTtlMs;
    this.accessTokenTtlS = accessTokenTtlS;
    this.refreshTokenTtlS = refreshTokenTtlS;
    this.scope = scope;
    this.resourceUrl = resourceUrl;
    this.usedRefreshLimit = usedRefreshLimit;
    this.clientsFile = clientsFile;
    this.#loadClients();
  }

  /** A client read from disk is valid only if it would also have been accepted by registration. */
  #validClient(client) {
    if (!client || typeof client.client_id !== 'string' || !client.client_id) return false;
    const uris = client.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) return false;
    return uris.every((uri) => typeof uri === 'string' && redirectAllowed(uri, this.allowedRedirectHosts));
  }

  /**
   * Re-reads the client list. A broken file is **not silently reset**: it is set aside
   * (`.corrupt-<when>`) and the backup is tried, as with the other state files. If there is
   * nothing to recover, it starts from scratch — and that is damage that fixes itself, because a
   * client that no longer finds its `client_id` registers again.
   *
   * Entries that no longer pass validation (a hand-written file, or a redirect allowed by an old
   * configuration) are **discarded**: the file is state we do not trust.
   */
  #loadClients() {
    if (!this.clientsFile) return;
    const read = (filename) => {
      const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!Array.isArray(parsed?.clients)) throw new Error('invalid client list');
      return parsed.clients;
    };
    if (!fs.existsSync(this.clientsFile)) return;

    let stored;
    try {
      stored = read(this.clientsFile);
    } catch {
      const damaged = `${this.clientsFile}.corrupt-${Date.now()}`;
      try {
        stored = read(`${this.clientsFile}.bak`);
        fs.renameSync(this.clientsFile, damaged);
        fs.copyFileSync(`${this.clientsFile}.bak`, this.clientsFile);
      } catch {
        // It could not be set aside: continue without clients, without writing over it until a
        // new one is registered. Say it out loud, because a file that is *unreadable*
        // (permissions, not broken JSON) is a fault to fix, not a state to restart from: without
        // the line all that would remain is "no registered clients".
        try {
          fs.renameSync(this.clientsFile, damaged);
        } catch {
          // nothing: the file stays where it is, and it is not written over until a client registers
        }
        console.warn(`OAuth client list unreadable (${this.clientsFile}); already registered clients will have to register again`);
        return;
      }
      console.warn(`OAuth client list recovered from backup; the broken original is in ${damaged}`);
    }

    let discarded = 0;
    for (const client of stored) {
      if (!this.#validClient(client)) {
        discarded += 1;
        continue;
      }
      this.#clients.set(client.client_id, client);
    }
    if (discarded > 0) {
      console.warn(`${discarded} OAuth clients discarded: ${this.clientsFile} contained entries with off-list redirects or incomplete`);
      this.#saveClients();
    }
  }

  /**
   * Writes the whole list, every time.
   *
   * `ponytail:` there is no cap on the number of clients, so the file grows as long as someone
   * registers. The de facto cap is set by the limiters on `/register` (the SDK's 20/hour, plus
   * ours): filling a disk takes days of continuous hostile traffic, and the owner notices before
   * then. If it ever needs limiting, the way is to discard the oldest by `client_id_issued_at` —
   * knowing that discarding a client means putting it back in the condition this file exists to
   * avoid.
   */
  #saveClients() {
    if (!this.clientsFile) return;
    const text = `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), clients: [...this.#clients.values()] }, null, 2)}\n`;
    writeFileAtomic(this.clientsFile, text, {
      verify: (parsed) => { if (!Array.isArray(parsed?.clients)) throw new Error('invalid client list'); },
    });
    // The file contains the `client_secret` of clients that have one: keep it readable only by
    // whoever wrote it. Also the `.bak`, which contains the same and which `writeFileAtomic`
    // creates itself. On Windows the mode is mostly ignored, but the cost is zero and on other
    // platforms it makes the difference.
    for (const file of [this.clientsFile, `${this.clientsFile}.bak`]) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // a filesystem without permissions (a share, an exotic volume), or a `.bak` that does not
        // exist yet on the first write: not a reason to refuse a registration
      }
    }
  }

  getClient(clientId) {
    return this.#clients.get(clientId);
  }

  registerClient(clientInfo) {
    const uris = clientInfo.redirect_uris ?? [];
    if (uris.length === 0) throw new InvalidClientMetadataError('at least one redirect_uri is required');
    for (const uri of uris) {
      if (!redirectAllowed(uri, this.allowedRedirectHosts)) {
        throw new InvalidClientMetadataError(`redirect_uri not allowed: ${uri}`);
      }
    }
    // It is written **before** answering: a `client_id` handed out without having saved it is
    // exactly the defect this file exists to avoid repeating. If saving fails, no 201 is sent:
    // better a 500 than a client that believes it is registered and is not.
    this.#clients.set(clientInfo.client_id, clientInfo);
    try {
      this.#saveClients();
    } catch (error) {
      this.#clients.delete(clientInfo.client_id);
      throw error;
    }
    return clientInfo;
  }

  redirectAllowed(uri) {
    return redirectAllowed(uri, this.allowedRedirectHosts);
  }

  putCode(code, record) {
    this.#codes.set(code, record);
  }

  getCode(code) {
    const record = this.#codes.get(code);
    if (!record) return undefined;
    if (record.expiresAt <= Date.now()) {
      this.#codes.delete(code);
      return undefined;
    }
    return record;
  }

  takeCode(code) {
    const record = this.getCode(code);
    if (record) this.#codes.delete(code);
    return record;
  }

  /**
   * Issues the token pair. `family` ties together all the rotations of the same consent: if a
   * refresh is reused (a sign it was copied), the whole family is revoked — not just that token —
   * because it is no longer known which of the two is the attacker.
   *
   * `resource` is written **here**, at issuance time: otherwise the middleware check ("was this
   * token issued for this resource?") compares the configured value with itself, and verifies
   * nothing.
   */
  issueTokens({ subject, email, clientId, family = crypto.randomUUID() }) {
    const accessToken = crypto.randomBytes(32).toString('base64url');
    const refreshToken = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.#access.set(sha256(accessToken), {
      clientId,
      scopes: [this.scope],
      expiresAt: now + this.accessTokenTtlS * 1000,
      subject,
      email,
      family,
      resource: this.resourceUrl,
    });
    this.#refresh.set(sha256(refreshToken), {
      clientId,
      scopes: [this.scope],
      expiresAt: now + this.refreshTokenTtlS * 1000,
      subject,
      email,
      family,
      resource: this.resourceUrl,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTokenTtlS,
      refresh_token: refreshToken,
      scope: this.scope,
    };
  }

  getAccess(accessToken) {
    const record = this.#access.get(sha256(accessToken));
    if (!record) return undefined;
    if (record.expiresAt <= Date.now()) return undefined;
    return record;
  }

  /**
   * Is the refresh valid? If it is no longer among the active ones but we already spent it, the
   * record comes back with `reused: true`: that is the signal that someone is replaying an old
   * token.
   */
  getRefresh(refreshToken) {
    const key = sha256(refreshToken);
    const record = this.#refresh.get(key);
    if (record) {
      if (record.expiresAt <= Date.now()) return undefined;
      return record;
    }
    const spent = this.#usedRefresh.get(key);
    return spent ? { ...spent, reused: true } : undefined;
  }

  takeRefresh(refreshToken) {
    const record = this.getRefresh(refreshToken);
    if (!record) return undefined;
    if (record.reused) return record; // already spent: not spent twice
    const key = sha256(refreshToken);
    this.#refresh.delete(key);
    this.#usedRefresh.set(key, { family: record.family, clientId: record.clientId, at: Date.now() });
    while (this.#usedRefresh.size > this.usedRefreshLimit) {
      this.#usedRefresh.delete(this.#usedRefresh.keys().next().value);
    }
    return record;
  }

  /**
   * Revokes a whole consent: the refresh tokens *and* the access tokens issued in the same
   * family. It is needed when reuse is discovered — leaving the access token alive for an hour
   * would mean having revoked nothing.
   */
  revokeFamily(family) {
    if (!family) return 0;
    let revoked = 0;
    for (const [key, record] of this.#refresh) {
      if (record.family === family) {
        this.#refresh.delete(key);
        revoked += 1;
      }
    }
    for (const [key, record] of this.#access) {
      if (record.family === family) {
        this.#access.delete(key);
        revoked += 1;
      }
    }
    return revoked;
  }

  deleteToken(token) {
    const key = sha256(token);
    const record = this.#access.get(key) ?? this.#refresh.get(key);
    this.#access.delete(key);
    this.#refresh.delete(key);
    this.#usedRefresh.delete(key);
    return record ?? null;
  }

  get count() {
    return {
      clients: this.#clients.size,
      codes: this.#codes.size,
      access: this.#access.size,
      refresh: this.#refresh.size,
      usedRefresh: this.#usedRefresh.size,
    };
  }
}