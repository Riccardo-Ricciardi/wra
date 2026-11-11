import crypto from 'node:crypto';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export class BridgeOAuthProvider {
  constructor({ store, scope }) {
    this.store = store;
    this.scope = scope;
  }

  get clientsStore() {
    return this.store;
  }

  async authorize(client, params, res) {
    // requireAccessIdentity has already put the verified identity on req: here we do not accept
    // "it came through Cloudflare", we accept a JWT validated against the JWKS.
    const identity = res.req?.accessIdentity;
    if (!identity) throw new InvalidGrantError('Cloudflare Access identity missing');

    if (!this.store.redirectAllowed(params.redirectUri) || !client) {
      throw new InvalidGrantError('redirect_uri not allowed');
    }

    const code = crypto.randomBytes(32).toString('base64url');
    this.store.putCode(code, {
      codeChallenge: params.codeChallenge,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      subject: identity.sub,
      email: identity.email,
      expiresAt: Date.now() + this.store.codeTtlMs,
    });

    const url = new URL(params.redirectUri);
    url.searchParams.set('code', code);
    if (params.state) url.searchParams.set('state', params.state);
    res.redirect(302, url.href);
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const record = this.store.getCode(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('unknown or expired authorization code');
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
    // Validate before consuming: a wrong request must not burn the code.
    const record = this.store.getCode(authorizationCode);
    if (!record) throw new InvalidGrantError('unknown or already used authorization code');
    if (record.clientId !== client.client_id) throw new InvalidGrantError('client mismatch');
    if (redirectUri && record.redirectUri !== redirectUri) throw new InvalidGrantError('redirect_uri mismatch');
    this.store.takeCode(authorizationCode);
    return this.store.issueTokens({ subject: record.subject, email: record.email, clientId: client.client_id });
  }

  /**
   * Refresh rotation: the old one is spent and a new one is born in the same family.
   *
   * If an **already spent** refresh arrives, that is not a harmless error: someone has a copy of
   * the token. It is unknown whether it is the attacker or the legitimate party, so the whole
   * family is revoked and consent must be redone — this is the OAuth rule for reuse
   * (RFC 9700 §4.14.2).
   */
  async exchangeRefreshToken(client, refreshToken) {
    const record = this.store.getRefresh(refreshToken);
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('invalid refresh token');

    if (record.reused) {
      const revoked = this.store.revokeFamily(record.family);
      throw new InvalidGrantError(
        `refresh token already used: consent was revoked (${revoked} tokens) and must be redone from scratch`,
      );
    }

    this.store.takeRefresh(refreshToken);
    return this.store.issueTokens({
      subject: record.subject,
      email: record.email,
      clientId: client.client_id,
      family: record.family, // same family: it is the same grant continuing
    });
  }

  async verifyAccessToken(token) {
    const record = this.store.getAccess(token);
    if (!record) throw new InvalidTokenError('invalid or expired token');
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      // The resource is the one written at issuance time, not the one configured now: otherwise
      // the middleware check compares the value with itself and verifies nothing.
      resource: (record.resource ?? this.store.resourceUrl) ? new URL(record.resource ?? this.store.resourceUrl) : undefined,
      extra: { subject: record.subject, email: record.email },
    };
  }

  /**
   * Revocation. A client can revoke **only its own** tokens: `client_id` is the only thing that
   * distinguishes two grants. If the token belongs to another, it is left alone and 200 is still
   * returned (RFC 7009 does not want anyone to be able to discover which tokens exist).
   */
  async revokeToken(client, { token }) {
    const record = this.store.getAccess(token) ?? this.store.getRefresh(token);
    if (record && client?.client_id && record.clientId && record.clientId !== client.client_id) return;
    this.store.deleteToken(token);
  }
}