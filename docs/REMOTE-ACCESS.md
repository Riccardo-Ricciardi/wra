# Reaching the dashboard from outside

Two official modes, and you can use both at once:

| | **Tailscale** | **Cloudflare Tunnel** |
|---|---|---|
| address | one of your tailnet (`pc-xxx.tailYYY.ts.net`) | one of your domains (`cc.yourdomain.com`) |
| who can get in | the devices on your tailnet | whoever passes **Cloudflare Access** on your domain |
| needs a domain | no | yes |
| needs the open internet | no (it is a VPN between your devices) | yes, but only from the declared hostname |
| phone | with the Tailscale app | with the browser, no app |
| certificate expiry | handled by Tailscale | handled by Cloudflare |

Neither one exposes the server: it keeps listening on `127.0.0.1` and no home port is opened. What
changes is **who carries the traffic to you**.

## The two things not to confuse

```
ADMIN DASHBOARD                         MCP / OAUTH ENDPOINT
the site, /local/*, the websocket       /mcp, /register, /token, /revoke
the person                              the machine (ChatGPT)
protected by: Access + the token        protected by: OAuth (PKCE, rotation, revocation)

   cc.yourdomain.com                       mcp.yourdomain.com
        ↑                                        ↑
   Cloudflare Access                        Access Bypass
```

They are **two different hostnames** and the code keeps the two surfaces apart:

- on the dashboard hostname the machine routes answer **404** (including the consent round: an
  OAuth code cannot be issued from the dashboard's domain);
- on the MCP endpoint hostname the site and the person's APIs answer **404**.

That way an error on one does not open the other: if the dashboard domain ended up among the
machine routes by mistake, the only thing left between ChatGPT and the dashboard would be the
token — that is, the extra protection you wanted, gone silently. `wra access check` and
`wra doctor` report it.

## Configuring

Everything goes through one command that **runs nothing**: it writes your choice and prints the
commands to run. They are commands that change how your machine is reachable from the internet,
and that is your decision.

```bash
wra access                                   # what there is now, and what is missing
wra access tailscale pc-mine.tail1234.ts.net # Tailscale mode
wra access cloudflare cc.yourdomain.com --mcp mcp.yourdomain.com
wra access off [tailscale|cloudflare]        # turns one mode off (or all of them)
```

The choice goes into `~/.cc-remote/access.json` and is read by the server at every start. The
environment variables (`CR_PUBLIC_ORIGIN`, `CR_MCP_HOST`, …) remain possible and **always win**
over the file: they exist to force a value for a test, without touching the saved configuration.

After that: `wra stop; wra start`. The server does not restart itself because restarting it closes
the processes of the open conversations — and closing someone else's work to apply a configuration
would be an unpleasant surprise.

### Tailscale, step by step

```bash
# 1. the device is on the tailnet (the app is installed and signed in)
tailscale status

# 2. expose the server **only inside the tailnet**
tailscale serve --bg --https=443 http://127.0.0.1:4310

# 3. tell WRA where the browser will come from
wra access tailscale pc-mine.tail1234.ts.net
wra stop; wra start
```

`tailscale serve` (not `funnel`): it stays inside your tailnet, and does not exist on the internet.
The address to use is the one `tailscale serve status` prints.

To turn it off: `tailscale serve --https=443 off`.

### Cloudflare Tunnel, step by step

```bash
# 1. install cloudflared and sign in to your account
cloudflared tunnel login

# 2. create the tunnel (once)
cloudflared tunnel create cc-remote

# 3. DNS for the two hostnames, towards that tunnel
cloudflared tunnel route dns cc-remote cc.yourdomain.com
cloudflared tunnel route dns cc-remote mcp.yourdomain.com

# 4. run the tunnel towards the server
cloudflared tunnel run cc-remote
```

Then in the Cloudflare panel, **two different Access applications**:

| hostname | policy |
|---|---|
| `cc.yourdomain.com` (dashboard) | **Allow** only for your identity (email, Google, GitHub…). No Bypass here. |
| `mcp.yourdomain.com` (machine) | **Bypass** on `/.well-known/*`, `/mcp`, `/register`, `/token`, `/revoke` — and Allow/whatever on the rest, or nothing. |

The rule on the second **must** be of type *Bypass*, not *Allow* with a path criterion:
with Allow, the Access login page also covers `/mcp`, and ChatGPT (which cannot do an interactive
login) receives an HTML page instead of a JSON response. The connection never starts, and it looks
like a WRA failure.

Finally:

```bash
wra access cloudflare cc.yourdomain.com --mcp mcp.yourdomain.com
wra stop; wra start
```

To keep the tunnel up, install it as a service (`cloudflared service install`) or as a scheduled
task: `docs/WINDOWS.md`.

### Both at once

```bash
wra access tailscale pc-mine.tail1234.ts.net
wra access cloudflare cc.yourdomain.com --mcp mcp.yourdomain.com
wra stop; wra start
```

There are now two allowed origins, and the browser can come in through both: the tailnet from the
phone (no app in between besides Tailscale) and the domain from the home browser. `wra access
check` lists them. If you accept only one, on the other side the page opens and **stays silent** —
a failure that looks like a broken server: that is why the websocket accepts them all.

## Permissions from the phone (`CR_REMOTE_PERMISSIONS`)

There is one thing you want to be able to do from outside without opening the panel: **manage the
permissions of your own conversations**. It is a narrower choice than `CR_SINGLE_HOST_ADMIN`, and
it is the one you need.

```powershell
$env:CR_REMOTE_PERMISSIONS = '1'
```

What it opens, exactly — and nothing else:

| route | what it does |
|---|---|
| `POST /local/sessions/:id/permissions` | changes the mode of **that** conversation |
| `POST /local/sessions/:id/mcp` | exposes it to ChatGPT, or removes it |

These stay closed: the panel, restores, settings, access, and **shutting the server down**
(`/local/shutdown`, which closes all terminals) — and `auto`, which makes the agent act without
asking inside a project and is not the same thing as "this conversation skips permissions". For
those there is `CR_SINGLE_HOST_ADMIN`, which is the wide choice.

Whoever gets in must have the **WRA token**, as with everything else, and the request must come
from a declared origin. The refusal is **explained**: someone with the token receives a `403` that
says what is missing and which variable to turn on; someone without it receives a `404` that says
nothing — no data, no hints, no clues about what is on — because "forbidden" would mean saying
there is something there.

**Cloudflare headers are not trusted.** `Cf-Access-Authenticated-User-Email` and `X-Forwarded-*`
are written by whoever sends them, and the server is also reached from `127.0.0.1` and the tailnet:
a header claiming an authenticated user authenticates nobody. What authorises is the token, and the
person in front of the dashboard is stopped by Access — outside this code.

### Exposing a conversation that skips permissions to ChatGPT

It is the heaviest condition this program knows how to turn on, and it does not turn on by
accident: in bypass the agent **never asks**, so the point where the person decides does not exist,
and with the chat exposed the one composing the message is a remote model. Consent has three extra
things:

- **the confirmation repeats the chat's name** (the server compares it, not a window in the
  browser): `{ allowed: true, confirm: "<chat name>" }` — a string, not something that looks like
  one;
- **on the public hostname `CR_REMOTE_PERMISSIONS` is required**, always, even from this machine's
  browser: there "from this machine" cannot be proven — the client writes `Origin` and the socket
  is `127.0.0.1` anyway, because the tunnel is in front. Outside that hostname the local browser
  is enough, and the rule stays as before;
- **it is dated** (`mcpBypassAt`), and **it expires** — `CR_MCP_BYPASS_TTL_S`, twelve hours by
  default;
- **it falls away by itself** when the conversation is archived, when its mode is changed, and when
  bypass is left: it was consent to *that* configuration, not to the chat, and it is not inherited.

You revoke it by removing the exposure. From that moment the chat is no longer reachable
**immediately**, even for someone who already had a `turn_id` or a selection: authorisation is
re-read at every request, not remembered.

## Verifying that it really is protected

From a device **outside** (the phone on 4G, not on the home wifi):

```bash
# 1. the dashboard must ask for the Access login (or not answer at all, if it is not you)
curl -sI https://cc.yourdomain.com | head -3

# 2. without a token, the person's APIs must say 401 — not 200, not a login page
curl -s -o /dev/null -w '%{http_code}\n' https://cc.yourdomain.com/local/sessions

# 3. on the dashboard hostname, the machine routes must not exist
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cc.yourdomain.com/mcp      # expected 404

# 4. on the machine hostname, the dashboard must not exist
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.yourdomain.com/               # expected 404
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.yourdomain.com/local/sessions # expected 404
```

Then the real round, which is the one that matters: open the address from the phone, get in, open a
conversation, write a message. And for the MCP endpoint:
`node tools/smoke-oauth.mjs https://mcp.yourdomain.com` (the six "no"s are expected: they are the
answers that arrive **downstream** of the Access login).

## What protects what

| | dashboard | MCP endpoint |
|---|---|---|
| Access (or the tailnet) | **yes, mandatory** | only on the non-machine parts |
| WRA token | yes (`/local/*`, the websocket) | no: there authorisation is OAuth |
| OAuth + PKCE | does not apply | yes, with rotation and revocation |
| attack from any site | `Origin` is checked on the websocket; the gate cookie is `SameSite=Lax` | does not apply |

The dashboard token is the only lock in front of `/local/*`: Access is the front door, the token is
the room key. If you publish the dashboard **without** Access, the token is all you have — and on
the internet it is not enough. It is also written in `docs/SECURITY.md`.

## A single hostname (`CR_SINGLE_HOST`)

A single public domain that serves **everything**, instead of two. The separation between the two
surfaces does not disappear: it changes shape — from "two hostnames" to "two policies on the same
hostname, decided per path".

| path | who talks | what protects it |
|---|---|---|
| `/mcp`, `/register`, `/token`, `/revoke`, `/.well-known/*` | the machine (ChatGPT) | OAuth + PKCE |
| `/authorize` | the person, once | Access, and then the WRA token |
| everything else: `/`, `/app.js`, `/local/*`, `/ws` | the person | Access, and then the WRA token |
| `/local/admin/*` | the person | as above, **and** `CR_SINGLE_HOST_ADMIN=1` — without it, from outside it is 404 |
| `/local/sessions/:id/permissions`, `/auto`, `/mcp` | the person | same: they are the modes that decide **who can do what** |

```powershell
$env:CR_SINGLE_HOST   = '1'
$env:CR_MCP_HOST      = 'mcp.example.com'
$env:CR_PUBLIC_ORIGIN = 'https://mcp.example.com'   # the websocket accepts this origin
# Optional, and only with Cloudflare Access in front: it makes the panel and the operations that
# touch the PC work from outside (opening a folder, restoring a copy, restarting).
$env:CR_SINGLE_HOST_ADMIN = '1'
```

`CR_SINGLE_HOST` alone **does not** open anything new: it serves the dashboard, but `/local/*`
stays behind the token and the admin routes stay invisible from outside. It is
`CR_SINGLE_HOST_ADMIN` that widens — and that is why it is a separate variable, one that does not
turn on as a consequence of something else.

What consent governs, precisely: the panel, the actions that change **who can do what** — the
permission mode (including `bypassPermissions`), auto-approval, opening a conversation to an
external client — and the operations that touch the PC. These stay out: reading the list, reading a
conversation, writing to it, starting and stopping a process, renaming, archiving. They are the
things the dashboard does from the phone, and the token covers them.

The token alone is not enough to decide the first ones: it says **who you are**, not what you
decided to leave on. And that is why `bypassPermissions` does not turn on from the internet even
with the token in hand.

**cloudflared**: no change for this mode. The ingress is already
`mcp.example.com → http://127.0.0.1:4310`. The other ingress rule remains, though,
`claude.example.com → http://127.0.0.1:3001`, which is the **old** system: as long as it
is there, the public subdomains are two, and "a single hostname" holds for WRA but not for the
tunnel. Removing it is a decision about the old rig, not this one — and it is not being taken now.

**Cloudflare Access**: one application on `mcp.example.com`, with **per-path** policies.
Order matters: Access evaluates them from the top, and the first match wins.

| # | path | action | policy |
|---|---|---|---|
| 1 | `/.well-known/*` | Bypass | — |
| 2 | `/register` | Bypass | — |
| 3 | `/token` | Bypass | — |
| 4 | `/revoke` | Bypass | — |
| 5 | `/mcp` | Bypass | — |
| 6 | `/authorize` | Allow | your email |
| 7 | *(everything else)* | Allow | your email |

The five Bypass entries are the machine: ChatGPT cannot do an Access login, and if it found one in
front it would never connect. `/mcp` is Bypass **because OAuth protects it** — a 401 from the
server, not a redirect to a login page.

Verification, from outside:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://mcp.example.com/mcp   # 401 — our lock
curl -s -o /dev/null -w "%{http_code}\n" https://mcp.example.com/      # 302 — Access, not 200
```

The first `401` says the request reached the server (Access did not stop it) and the server is the
one saying no. The second `302` says the dashboard is **not** public: without it, Access is not
covering that route.

**One thing to watch after applying it**: the websocket upgrade through Access. It cannot be
verified from here — it depends on how the application is configured on the Cloudflare side. If the
page opens but stays silent, that is it: you see it immediately from the "not connected" banner and
from the fact that the terminal writes nothing.

## If something does not work

| symptom | almost always the cause |
|---|---|
| the page opens but stays silent (no updates) | `CR_PUBLIC_ORIGIN` does not contain **that** origin: the websocket refuses the upgrade (403). `wra access check` lists them |
| `curl https://mcp.../mcp` returns an HTML login page | the Access rule on the machine hostname is **Allow**, it must be **Bypass** on the machine paths |
| the dashboard answers 404 to everything | the hostname is not the declared one, or the tunnel points to another port |
| `the server did not start` with `EACCES` | on Windows the port is in a range reserved by the system: `netsh int ipv4 show excludedportrange protocol=tcp`, then `CR_PORT=<one outside them>` |
| after the restart the mode is gone | `wra stop; wra start` was not run: the choice is read at startup |