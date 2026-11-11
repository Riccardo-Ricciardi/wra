# Cloudflare Access review — the five "overprovisioned policy" findings

Scope: the production installation `mcp.example.com`, one hostname serving both the
dashboard (single-host mode) and the MCP/OAuth surface. Reviewed on 2026-11-10 against the code on
`release/1.0`. No Cloudflare, DNS, tunnel or credential change was made.

## Verdict

The five findings are **expected and necessary**. ChatGPT is a machine client: it cannot complete
Cloudflare Access login and it cannot present an Access service token. It therefore needs
unauthenticated reachability to discovery, dynamic client registration, token exchange and
revocation. Every one of those routes is authenticated or constrained by the application:

- `/mcp` requires an OAuth bearer token with the right scope **and** the right audience.
- `/register` issues an identity, never an authorization. A code is born only after the owner
  token and an explicit consent POST.
- `/token` requires a valid, single-use code bound to client + redirect + PKCE S256, or a valid
  refresh token with reuse detection.
- `/revoke` requires client authentication and can only revoke that client's own tokens.
- `/.well-known/*` returns public metadata and no secrets.

Nothing outside those paths is reachable without Cloudflare Access **and** the WRA owner token.
The warning is about the shape of the policy, not about an authentication bypass.

## Production shape

```
CR_SINGLE_HOST=1
CR_MCP_HOST=mcp.example.com
CR_PUBLIC_ORIGIN=https://mcp.example.com;https://pc-example.tail0000.ts.net
CR_REMOTE_PERMISSIONS=1
CR_SINGLE_HOST_ADMIN unset
```

Because it is single-host, the separation is per path, enforced in `src/net/server.mjs`
(`mountSurfaceLocks`) and in the websocket upgrade guard (`src/net/ws.mjs`), not by two hostnames.

## Path matrix

| Path | Cloudflare policy (current) | Native authentication | Intended public? | Actual exposure | Exploitability | Severity | Recommended remediation | ChatGPT compatible |
|---|---|---|---|---|---|---|---|---|
| `/mcp` | Bypass | OAuth bearer; `requiredScopes: [mcp]`; `expectedResource` = `CR_RESOURCE_URL`; per-conversation `mcpAllowed` | Yes | 401 + `WWW-Authenticate` without a valid token; no tool runs, no transcript is returned | None without a token issued through consent | Informational | Keep a **path-scoped** Bypass. Never a host-level Bypass | Yes, required |
| `/register` | Bypass | RFC 7591 DCR; `redirect_uris` must match the exact host allowlist (`chatgpt.com`, `openai.com`, `platform.openai.com`, HTTPS only); server generates `client_id`; SDK limiter 20/h + WRA limiter 60/5 min per origin | Yes | Anyone can obtain a `client_id`; that grants no authorization | Cannot reach `/mcp` or `/authorize` success without owner token + consent; abuse limited to client-list growth | Low | Keep. Optionally add a Cloudflare WAF rate-limit rule on `/register` | Yes, required |
| `/token` | Bypass | Client authentication when the client has a secret; PKCE S256 verifier checked; code single-use, 10 min TTL, bound to `client_id` + `redirect_uri`; refresh rotation with family revocation on reuse | Yes | Errors only without valid credentials | Brute force limited by WRA + SDK limiters; PKCE verifier unknown to an interceptor | Low | Keep | Yes, required |
| `/revoke` | Bypass | `authenticateClient`; `revokeToken` only deletes records whose `clientId` matches the authenticated client; always answers 200 | Yes | Returns 200 and does nothing for a foreign token | No information disclosure, no cross-client revocation | Informational | Keep | Yes, optional for ChatGPT |
| `/.well-known/*` | Bypass | None (public metadata by RFC 8414/9728) | Yes | Authorization-server and protected-resource metadata; endpoints, scopes, issuer | No secret, no state mutation | Informational | Narrow the wildcard to the four paths actually served (below) | Yes |
| `/authorize`, `/authorize/consent`, `/authorize/login` | Allow (owner identity) | Cloudflare Access **then** WRA owner token (`gatePage`), then a single-use consent POST with a 2-minute nonce | Owner's browser only | A stranger sees the Access login or the WRA token page | The consent page is not reachable without the owner token; a direct `POST /authorize` is 405 | Informational | Keep behind Access Allow. Do not add these to Bypass | Yes — the client redirects the **browser**, which can log in |
| `/`, `/local/*`, `/ws`, `/healthz` | Allow (owner identity) | WRA owner token; websocket also checks `Origin`; admin actions 404 from the public host unless `CR_SINGLE_HOST_ADMIN=1` | Owner only | Reachable only after Access login **and** with the token | Requires owner identity and owner token | Low | Verify no Bypass exists on these paths | Not needed |

Residual, deliberate: `CR_REMOTE_PERMISSIONS=1` lets the owner change a conversation's permission
mode and MCP exposure from outside. It is a decision recorded as configuration, not a header, and
it never opens the admin panel or the restore/settings routes.

## Verification performed

Automated (all passing on `release/1.0`):

- Dynamic registration rejects an off-list redirect: `test/oauth-flow.test.mjs`,
  `test/oauth-clients.test.mjs`.
- PKCE is mandatory and S256-only; a wrong verifier yields no token:
  `test/oauth-flow.test.mjs`. Enforced by the SDK's authorization schema
  (`code_challenge_method: z.literal('S256')`).
- Authorization code expiry, single use, client binding and redirect binding:
  `test/auth.test.mjs`, `test/oauth-flow.test.mjs`.
- Consent is required; no method or path variant mints a code without it:
  `test/oauth-clients.test.mjs`, `test/auth.test.mjs`.
- Refresh rotation, reuse detection and whole-family revocation: `test/auth.test.mjs`.
- Token audience and scope: `test/oauth-flow.test.mjs`, `test/auth.test.mjs`.
- Client registration survives a restart; codes and tokens do not; revocation is not undone by a
  restart: `test/oauth-clients.test.mjs`.
- Unauthenticated `/mcp` is 401, not 404, and points at the resource metadata document:
  `test/mcp-host.test.mjs`, `test/mcp-discovery.test.mjs`.
- The public hostname serves only the machine surface; the dashboard hostname serves no machine
  route: `test/mcp-host.test.mjs`.
- Rate limits cover `/register`, `/token`, `/authorize`, `/mcp`: `test/rate-limit.test.mjs`.

**Defect found and fixed during this review** (commit `7b7c2c5`): Express routes
case-insensitively and ignores a trailing slash, while the dashboard-host surface lock compared the
raw path. `POST /TOKEN` or `/token/` reached the OAuth router on the dashboard hostname. Production
(single-host) was already normalized by `percorsoDi`; two-host installations were not. Both locks
now normalize through the same helper, with a regression test.

Read-only checks against production, when convenient:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.example.com/mcp          # 401
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.example.com/register     # 404/405 without POST
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.example.com/local/sessions  # Access login or 401, never JSON
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.example.com/TOKEN        # must not reach /token
```

## Cloudflare dashboard checklist (owner approval required — not applied)

Nothing below was changed. Each line is a check with the exact value the server expects.

**Zero Trust → Access → Applications**

- [ ] Exactly one self-hosted application for the production hostname, path empty (whole host).
      No second application covers the same host (duplicates change precedence unpredictably).
- [ ] The application's only **Bypass** policies are path-scoped, one path each, with these exact
      values and no trailing wildcard beyond `/.well-known`:
      - [ ] `/mcp`
      - [ ] `/register`
      - [ ] `/token`
      - [ ] `/revoke`
      - [ ] `/.well-known/oauth-authorization-server`
      - [ ] `/.well-known/openid-configuration`
      - [ ] `/.well-known/oauth-protected-resource`
      - [ ] `/.well-known/oauth-protected-resource/mcp`
- [ ] No Bypass on `/`, `/*`, `/local/*`, `/ws`, `/healthz`, `/authorize`, `/authorize/*`.
- [ ] The default policy is **Allow** with an identity selector (the owner's email or IdP group).
      Not "Everyone", not an IP range, not a country rule.
- [ ] No Access **Service Auth** policy on the machine paths: ChatGPT cannot send a service token.
- [ ] Bypass policies are evaluated before Allow for their exact paths; check the policy order in
      the application if the dashboard shows one.
- [ ] Login methods for the Allow policy are the intended IdP only (OTP/PIN disabled if the IdP is
      configured).

**Zero Trust → Access → Settings / session**

- [ ] Session duration is the intended default; no "bypass all" or "allow all" toggle is on.

**SSL/TLS → Overview**

- [ ] Encryption mode **Full (strict)**. Not Flexible. The origin is loopback HTTP and
      `cloudflared` terminates TLS.

**Security → WAF → Rate limiting rules (optional, plan permitting)**

- [ ] One rule on `POST` for the hostname and path `/register`, a few requests per minute per IP.
- [ ] One rule on `POST` for the hostname and path `/token`, same shape.
      These duplicate the application limiters and only affect abuse bursts.

**Security → Bots / Managed rules**

- [ ] Bot Fight Mode and managed challenges stay **off** on the machine paths. A JavaScript
      challenge breaks the ChatGPT client and does not protect anything the bearer token does not.

**Do not**

- [ ] Do not enable Cloudflare **Managed OAuth** over this server: it replaces the authorization
      server's behaviour and has not been proven compatible with this consent flow.
- [ ] Do not put `/authorize` behind Bypass. The consent page must stay behind Access Allow and
      the WRA token; the OAuth client redirects the **browser**, which can log in.
- [ ] Do not add a host-wide Bypass "to make ChatGPT work": it would expose the dashboard with only
      the owner token in front of it.

## Why each finding is accepted

| Security Center finding | Native control that holds | Decision |
|---|---|---|
| `/token` overprovisioned | client auth where a secret exists, PKCE S256, 10-minute single-use code bound to client + redirect, refresh rotation with reuse revocation, WRA + SDK rate limits | Accept, path-scoped Bypass |
| `/mcp` overprovisioned | bearer with `mcp` scope and `expectedResource`, per-conversation `mcpAllowed` | Accept |
| `/.well-known/*` overprovisioned | public metadata by RFC 8414/9728, no secrets, narrowed to four exact paths | Accept, narrowed |
| `/register` overprovisioned | DCR issues an identity only; exact redirect-host allowlist; server-generated `client_id`; authorization still needs owner token + consent; 20/h SDK + WRA limits | Accept |
| `/revoke` overprovisioned | client authentication; a client can revoke only its own tokens; always 200 | Accept |


## Path normalization and method handling

- Express matches routes case-insensitively and ignores one trailing slash; the surface locks now
  normalize the same way before deciding (`percorsoDi`: decode, lowercase, strip trailing slashes).
- Percent-encoded paths do not match Express routes (`/%74oken` is 404), so encoding cannot reach a
  handler that the lock did not see.
- `/mcp` answers GET and DELETE with an explicit 405 JSON, not an empty body. `/authorize` answers
  non-GET with 405; consent is POST-only.
- Cloudflare path matching is case-sensitive and does not decode. That direction is **fail-closed**:
  an alternate-case path falls under the Allow policy and meets Access login first.

## Residual risk

- With single-host, a Cloudflare policy mistake that bypassed the whole hostname would expose the
  dashboard to the internet with only the owner token in front of it. The code still keeps the
  admin panel, restores and settings off that hostname (`CR_SINGLE_HOST_ADMIN` unset), but the
  token becomes the only outer barrier. The path-scoped Bypass is what prevents this.
- `CR_REMOTE_PERMISSIONS=1` intentionally allows permission-mode changes from outside; see above.
- DCR is unauthenticated by design. An attacker can create client records, not grants. The client
  file has no cap, so sustained hostile registration grows it; the registrations are rate limited
  and the owner sees the file. If this ever matters, cap by `client_id_issued_at`.
