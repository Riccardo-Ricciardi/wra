# Connecting ChatGPT to WRA (path B)

Two paths, kept separate on purpose. **A** is the person (browser and phone) and goes through
Tailscale. **B** is the machine (ChatGPT) and needs a **public** address, because OpenAI's servers
are on the internet and not on your tailnet.

This document says what B needs, what has already been verified, and what remains to be done by
hand.

## What is already ready and verified in the code

Verified end-to-end over real HTTP (`node --test test/oauth-flow.test.mjs`, 9 checks):

- **Discovery**: the **four** addresses that real clients ask for answer with issuer, endpoints and
  `S256` — `/.well-known/oauth-protected-resource` (the root, RFC 9728 §3),
  `/.well-known/oauth-protected-resource/mcp` (the variant),
  `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` (the OIDC
  location: **the same** OAuth document, not an OpenID Provider — see §"`/authorize`" for the story
  that made the last two necessary). And `/mcp` without a token answers 401 with
  `WWW-Authenticate: … resource_metadata="…"`.
- **Client registration**: `/register` accepts only https `redirect_uri`s on listed hosts
  (`CR_REDIRECT_URI_HOSTS`, default `chatgpt.com,openai.com,platform.openai.com`); it refuses
  `http://`, fake suffixes (`chatgpt.com.evil.example`) and undeclared subdomains.
- **Consent**: `/authorize` is behind the person's gate (WRA token); the code is born **only**
  after a consent POST started from the page, and is valid for that one request only.
- **PKCE**: mandatory, only `S256`; a wrong `code_verifier` produces no token.
- **Tokens**: single-use authorization code; access lasts `CR_ACCESS_TOKEN_TTL_S` (1 hour), refresh
  lasts `CR_REFRESH_TOKEN_TTL_S` (30 days) and **rotates on every use**.
- **Refresh reuse**: if an already-spent refresh arrives, the **whole family** is revoked (access
  included) and consent must be given again. It is the "token was copied" case, and no attempt is
  made to guess which of the two is the attacker.
- **Revocation**: `/revoke` always answers 200; a client can revoke only its own tokens.
- **Resource**: the token carries which resource it was issued for, and the middleware verifies it
  — a token for another resource does not open this one.
- **Rate limits**: `/mcp`, `/token`, `/register`, `/revoke`, `/authorize` and login attempts have a
  per-origin ceiling (configurable via `CR_RATE_<NAME>_MAX`).
- **The WRA token does not leak**: no response, header or log line contains it
  (`node --test test/secrets.test.mjs`).

## What is missing, and must be done by hand (I have no access to the Cloudflare panel)

**One public hostname** is needed that reaches port 4310, with Cloudflare Access in front of the
authorization endpoint but **not** in front of MCP and OAuth.

The site (path A) is **not** to be exposed on Cloudflare: it stays on Tailscale. Two hostnames on
the same server would mean serving the admin interface on the internet, and the Access rule is not
a sufficient guarantee — one wrong rule, and the panel is out.

### 1. Hostname and tunnel

The existing tunnel already serves the old rig:

```yaml
# ~/.cloudflared/config.yml
tunnel: <your-tunnel-id>
ingress:
  - hostname: mcp.yourdomain.com          # the machine endpoint (ChatGPT)
    service: http://127.0.0.1:4310
  - service: http_status:404
```

**One** hostname is needed for the bridge: the MCP endpoint. The dashboard can live on another
hostname (or stay private, with Tailscale): the configuration of the two modes is in
[docs/REMOTE-ACCESS.md](REMOTE-ACCESS.md), and is done from there with `wra access`.

`cloudflared` forwards to the origin the **same `Host`** the visitor used: that is what the guard in
point 3 relies on.

### 2. Cloudflare Access

On **`mcp.yourdomain.com`** two rules are needed, in order:

1. **Bypass** (action *Bypass*, not *Allow*) for the machine:
   ```
   /.well-known/*
   /mcp
   /register
   /token
   /revoke
   ```
2. **Allow** for everything else (email/IdP, as you already do on the old one).

**Careful, and this is not a detail**: Cloudflare Access lets bypass paths through only if the rule
is of type *Bypass*. An *Allow* rule with a "path" criterion is not enough: it shows the login even
for `/mcp`, and ChatGPT cannot talk to anything.

#### `/authorize`: what was believed, and what was true (03/11)

`/authorize` is **not** in the list, so it goes through Access. Navigating it from a real browser on
the public address lands on
`<your-team>.cloudflareaccess.com/cdn-cgi/access/login/…` with the title "Sign in ・ Cloudflare
Access": the request **does not reach the server**.

On 03/11 this looked like the culprit for "the MCP server denied access". **It was not.**
Rereading the trace of the real attempt, OpenAI's platform did this, in this order:

| # | Request | Response | Who |
|---|---|---|---|
| 1 | `GET /.well-known/oauth-authorization-server` | 200 | `Python/aiohttp` (the platform) |
| 2 | `GET /.well-known/openid-configuration` | **404** | `Python/aiohttp` |
| 3 | `GET /.well-known/openid-configuration` | **404** | `Python/aiohttp` |
| 4 | `POST /mcp` | 401 (correct: that is how the OAuth round starts) | `openai-mcp/1.0.0` |
| 5… | `GET /.well-known/openid-configuration` **nine times in all**, for 50 seconds | **404** | `Python/aiohttp` |

And then it gave up: **no registration** (`POST /register` does not appear), **no request to
`/authorize`**. So Access was never reached, and could not have been the cause: the first decisive
failure was a document that did not exist.

What remains true about Access: it sits in front of the **browser** step, and when the round gets
there the person will see the Access login first and then the WRA one. If the window ChatGPT opens
does not like that hop, the rule to add is `/authorize` and `/authorize/*` in **Bypass** — it does
not remove protection: `/authorize` grants nothing without the person's token, and the code is born
only after consent. But **it is not what stopped the connection**, and it must not be touched before
seeing the next trace.

### 3. The guard in the code (not only in the panel)

With `CR_MCP_HOST` declared, the server decides **from the request host**: on that host only the
OAuth surface answers, and everything else is 404 — before any gate, without even saying what is
there. If Access is reconfigured by mistake, the admin interface still does not end up online. Tried
in `test/mcp-host.test.mjs`.

On the public host **only** these pass:

```
/.well-known/*      /mcp      /register      /token      /revoke
/authorize          /authorize/login         /authorize/consent
```

`/authorize*` is the only human piece that must pass: it is the `authorization_endpoint` ChatGPT
opens in the browser, and consent cannot happen anywhere else. Those pages stand on their own
(inline styles, no files to load) and stay behind the WRA token.

Everything else — `/`, `/app.js`, `/local/*`, `/healthz`, `/ws` — answers 404 on the public host.

> The comparison is on the **host**, not the IP: behind the tunnel every request arrives from
> `127.0.0.1`, so the IP would not distinguish a browser from ChatGPT.

### 4. Starting the server with the two public addresses

`CR_ISSUER_URL` and `CR_RESOURCE_URL` must be the **public address**, not the local one: it is what
ChatGPT reads in the metadata, and if it says `127.0.0.1` the connection never starts.

```powershell
$env:CR_ISSUER_URL   = 'https://mcp.yourdomain.com'
$env:CR_RESOURCE_URL = 'https://mcp.yourdomain.com/mcp'
$env:CR_MCP_HOST     = 'mcp.yourdomain.com'
wra stop; wra start
```

> `CR_PUBLIC_ORIGIN` is for the **websocket** origin check, that is, for the dashboard, not the
> bridge. If the dashboard stays private (Tailscale), leave it as it is. If you also want it on
> your domain, declare it there — but **only with Cloudflare Access in front**: `wra access` does
> this, and keeps the two surfaces apart (`docs/REMOTE-ACCESS.md`). Do not declare a hostname that
> has no Access in front: that would be the admin dashboard on the internet with only the token.

## Verification, before touching ChatGPT

From any network (not from the tailnet), these commands must give these results:

```bash
BASE=https://mcp.yourdomain.com

# 1. the metadata is public (no Access login), all four addresses
for p in oauth-protected-resource oauth-protected-resource/mcp oauth-authorization-server openid-configuration; do
  curl -s -o /dev/null -w "$p → %{http_code}\n" $BASE/.well-known/$p
done
#   expected: 200, 200, 200, 200.   A 404 on openid-configuration is what stopped the
#   ChatGPT connector: the platform asked for it nine times before giving up.

curl -s $BASE/.well-known/oauth-protected-resource | head -c 200
#   expected: {"resource":"https://mcp.yourdomain.com/mcp", ...}
curl -s $BASE/.well-known/oauth-authorization-server | head -c 200
#   expected: {"issuer":"https://mcp.yourdomain.com/", ...}

# 2. /mcp answers 401 (from OUR server), not a redirect to cloudflareaccess.com
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/mcp
#   expected: 401     if it returns 302 → the bypass rule is not of type Bypass

# 3. the site must NOT exist on this host: 404 from our guard, not a page
curl -s -o /dev/null -w '%{http_code}\n' $BASE/
#   expected: 302 to Access (which covers everything except the bypasses) — and, with Access
#   removed, 404 from the guard. If a WRA HTML page comes out, the site's hostname ended up here:
#   that is the failure.

# 4. /authorize: it is the authorization_endpoint ChatGPT opens in the browser, and it is behind
#    Access.
curl -s -H 'accept: application/json' -o /dev/null -w '%{http_code} %{content_type}\n' \
  "$BASE/authorize?response_type=code&client_id=x"
#   expected: 302 towards cloudflareaccess.com (the Access browser comes first).
#   Downstream of Access, OUR server answers **200 text/html** with the token page — never 401:
#   an authorization endpoint always answers with a page.
#   In no case a 404: if it returns 404, the guard is closing /authorize too.
```

The rest of the surface must be closed: `/app.js`, `/local/sessions`, `/healthz`, `/ws` give 302 to
Access (before the server) and 404 to the guard (with Access removed). Never a page of the site.

Then the full round from the browser (once):

1. open the site from path A — `https://<your-tailscale-address>` from the phone, or
   `http://127.0.0.1:4310` from this machine — and sign in with the WRA token;
2. turn on "Allow ChatGPT" on the conversation you want to expose (⋯ option → switch);
3. on ChatGPT: *Settings → Connectors → Add* with URL `https://mcp.yourdomain.com/mcp`;
4. ChatGPT opens the authorization page: you go through Access, then the WRA token, then approve
   consent. The client is ChatGPT, the user is you: what you see on the consent page is ChatGPT's
   return address;
5. ask ChatGPT to list the tools (or ask directly what there is on WRA).

## Where the public round actually stops (measured on 3 November 2026)

`node tools/smoke-oauth.mjs https://<your-endpoint>` on the real public address:

| What | Result |
|---|---|
| OAuth metadata, issuer, resource, `/mcp` 401 from our server | ✅ all |
| a client registers from outside, and one with a redirect outside the list is refused | ✅ 201 / 400 |
| revocation closes immediately | ✅ |
| **`/authorize`** | ❌ **302 to `dark-term-….cloudflareaccess.com/cdn-cgi/access/login/…`** |
| from there on: consent, code, token, `tools/list` | ❌ cascading (six checks) |

It is not a code defect: the **same sequence**, with the tunnel's `Host` header sent to a local
port, passes **all** of it (`node tools/smoke-public-host.mjs <port> <public-host>` → 15/15). The
difference is only one: there is no Access in between.

So the block is **the Access rule on `/authorize`**, and it is a decision for whoever uses the
machine. Two paths, and the first is the smaller one:

1. **Bypass on `/authorize` and `/authorize/*`.** It removes no protection: `/authorize` grants
   nothing without the **person's token**, and the code is born only after consent. It changes
   *which* login is seen first — only ours, instead of Access and then ours.
2. Leave Access and **try anyway**: ChatGPT's browser might complete the Access login. If it does,
   nothing needs changing. If the window stays white or closes, it is this.

The log says which of the two is happening, without guessing:

```powershell
Get-Content "$env:TEMP\cc-remote.log" | Select-String "OAuth surface" | Select-Object -Last 20
```

One line per `/authorize` → the request **arrives** at the server, so Access passed. No line → it
stopped earlier, and the cause is the rule.

## What remains NOT verified

- **The connection with real ChatGPT**: I have not done it. A real ChatGPT client is needed that
  completes the OAuth flow and exchanges messages with an authorised conversation. Until then path
  B is "ready and reachable from the internet", not "proven".
- **The long turn as seen by ChatGPT**: the lifecycle is proven end-to-end on the real server
  (`test/long-turn-live.test.mjs`: 900 ms window, response at 2 500 ms, the final answer arrives
  and `watches` is 2) and on the public path with the `Host` header. What is missing is seeing it
  with the real client, which is the same thing missing in the point above.

## State of the last verification (30 October 2026)

Everything that could be tried without a real ChatGPT client was tried **on the real public
address** `https://mcp.yourdomain.com`:

| What | Result |
|---|---|
| OAuth metadata (`/.well-known/*`) public, without an Access login | ✅ 200, issuer and resource = public address |
| `/mcp`, `/register`, `/token`, `/revoke` in bypass (they do not show the Access login) | ✅ our server answers (401/400) |
| `/authorize` behind Access, then through our gate | ✅ 302 to `cloudflareaccess.com` — the **browser** step: the person logs in to Access first, then to WRA. It is not what stopped the connector (§"`/authorize`") |
| Surface closed by the guard: `/`, `/app.js`, `/local/*`, `/healthz`, `/ws` | ✅ 404 from our guard (and 302 from Access, before reaching it) |
| `tools/smoke-oauth.mjs` from outside | 9/15 ok; the 6 "NO"s are all downstream of `/authorize`, which demands the Access login — intended behaviour |

So: path B is reachable and configured. **Only the real round from ChatGPT is missing**, and it
requires access to the Cloudflare panel and a ChatGPT account with connectors enabled:

1. Access rule on `mcp.yourdomain.com`: **Bypass** (not Allow) for `/.well-known/*`, `/mcp`,
   `/register`, `/token`, `/revoke`; **Allow** for the rest (so `/authorize` stays protected).
2. Server started with `CR_ISSUER_URL`, `CR_RESOURCE_URL`, `CR_MCP_HOST` on the public address.
3. On ChatGPT: *Settings → Connectors → Add* with `https://mcp.yourdomain.com/mcp`, complete Access
   + consent, then ask for the tool list.

- **The websocket through Cloudflare**: path B serves `/mcp` and OAuth, not the websocket. The
  browser stays on Tailscale. If one day you want it there too, it must be verified that the
  Cloudflare proxy supports the upgrade — I have not tried it.