# Security

What protects what, what was checked, and what is knowingly not covered.

## Shape of the thing

WRA runs a real agent, with your credentials, on your machine. It is single-user: one
person, one token. There is no multi-tenant model and no roles — anything that holds the token is
you, and that is the whole authorisation story for the browser path.

```
internet ──► Cloudflare Access ──► /mcp, /token, /register, /authorize (public routes)
                                        ▲
                                        │ OAuth (PKCE) for machine clients
your tailnet ──────────────────────► /  /local/*  /ws        ◄── the person
                                        │
                                   WRA on 127.0.0.1:4310
```

The server only ever listens on loopback. Nothing is exposed to the LAN or the internet by this
code: the two paths above are HTTPS fronts you configure.

## Layers

| Layer | Protects | Notes |
|---|---|---|
| Loopback bind | everything | `CR_HOST` defaults to `127.0.0.1` |
| Owner token | the interface, `/local/*`, the websocket | 192-bit, in `~/.cc-remote/token`, compared in constant time |
| Origin check on the websocket | DNS rebinding | loopback origins, or the one declared in `CR_PUBLIC_ORIGIN` |
| OAuth + PKCE (S256) | the MCP bridge | authorization code, single use, bound to client, redirect and challenge |
| Consent page | the person | a code is only issued after a POST from the consent page, behind the owner token |
| `mcpAllowed` per conversation | ChatGPT | off by default; an explicit `session_id` does not bypass it |
| Approvals | the tools the agent runs | nothing is ever auto-granted by the relay, except by the controlled automatic mode below |
| Controlled automatic mode | repeated approvals on file edits inside one project | off by default, per conversation or per project, path-verified, fail-closed, revocable at the next request (see below) |
| Rate limits | brute force, registration abuse | per route, per origin; `CR_RATE_<NAME>_MAX` |
| `CR_MCP_HOST` surface lock | the admin interface reaching the internet | on the declared public host only OAuth and `/mcp` exist; everything else is 404 *before* any gate |
| dashboard host lock (`CR_DASHBOARD_HOST`) | the machine surface appearing on the dashboard domain | on the dashboard hostname `/mcp`, `/register`, `/token`, `/revoke`, `/.well-known/*` and `/authorize` answer 404: an OAuth code cannot be issued from the dashboard's domain. Both locks are mounted even when the MCP bridge is off |
| Local-only actions | a page elsewhere triggering "open this folder on the PC" | `POST /local/projects/open` runs only when the request has no `Origin` or a loopback one. It is a **browser-origin check**, not a network guarantee: a non-browser client holding the token can forge the header — and by this document's model, the token is already the authorisation |
| Cloudflare Access | public routes | must be a **Bypass** rule on the machine paths (see docs/CHATGPT.md); path-by-path review in [security/CLOUDFLARE-ACCESS-REVIEW.md](security/CLOUDFLARE-ACCESS-REVIEW.md) |

### Controlled automatic mode (`MCP automatico controllato`)

Why it exists: driving a conversation from ChatGPT through MCP otherwise costs one human approval
per file edit, and an approval you click forty times a day is an approval you stop reading. This
switch trades that ritual for a boundary that is checked by code.

**Off by default, and explicit.** Nothing enables it implicitly — not an environment variable, not
the fact that a conversation is exposed to MCP, not the project it lives in. It is turned on per
conversation (`POST /local/sessions/:id/auto {enabled:true}`) or per project
(`POST /local/projects/update {path, autoApprove:true}`), from the ⋯ menu in the interface. A
conversation says `null` ("whatever the project says"), `true` or `false`; the conversation wins
over the project, and the interface shows which of the two decided.

**What it grants, and nothing else** (`src/host/auto-policy.mjs`):

- `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit` — the tools whose entire effect is **one
  path** — when that path resolves **inside the conversation's project directory**, no component
  below the project root is a symlink or junction, and the target is not in a reserved place:
  `.claude/`, `.git/`, `.cc-remote/`, `.ssh/`, `.aws/`, `.gnupg/`, `.mcp.json`, `.npmrc`,
  `.netrc`, `.htpasswd`, `credentials*`, `.env*`, `id_rsa*`, `*.pem|key|p12|pfx|keystore|jks`.
  Those names are compared after being reduced to what the filesystem actually reads: on Windows
  `percorso::$DATA` *is* the main content of a file (verified: writing `.env::$DATA` puts the text
  inside `.env`) and `file:stream` is a stream inside the same file, so the stream suffix is cut
  before the check, and trailing dots and spaces are stripped as well (Node keeps them as a
  different name; other tools normalise them, and a name that looks like `.env` elsewhere must not
  pass here). A component shaped like an 8.3 short alias (`ENV~1`, `CLAUDE~1`, `CREDEN~1.JSO` — the
  alias Windows keeps next to the real name and which opens the same file) is **not resolved**:
  the request asks. A file genuinely called `a~1` therefore asks too; that is the price, and it is
  the right one.

**What it never grants:**

- `Bash`, PowerShell and every other tool that runs code. Its input is a command string, and
  deciding whether a command is safe means *reading text* — text that `;`, backticks, `$(...)`, a
  script file or a binary compiled yesterday all get around. A permission granted by a filter is
  not a boundary, it is a hope. So commands always ask.
- `Glob`/`Grep`, for the same reason in smaller print: their argument is a *pattern*, and a
  pattern can contain `..` or an absolute path.
- `WebFetch`/`WebSearch`, and any tool whose input has no verifiable path.
- Anything outside the project directory, at any depth, including paths that merely *look* inside
  (`…/project-2` next to `…/project`).

**Fail-closed by construction.** A missing or oddly-typed field, an unreadable path, a policy that
throws, a relay that is off (`CR_APPROVAL_TTL_S=0`), or no policy at all: every one of those ends
in "no decision", which is the ordinary dialog. The only path to `allow` is a path that was
verified. A bug in the policy costs a prompt, never a permission.

**Revocation is server-side.** The policy reads the conversation registry and the project store at
**every** request, so switching it off takes effect on the next request, with no restart and no
cache to invalidate. The registry also refuses both dangerous combinations: turning the automatic
mode on for a `bypassPermissions` conversation, and putting an automatic-mode conversation into
bypass. In bypass the hook never runs, so the policy would not decide anything — the human would
be left believing in a boundary that is not there.

**Transparency.** Every automatic grant is logged (`permesso concesso senza chiedere`, with tool
and reason, never the content), pushed to the browser of whoever is watching that conversation,
and kept in a short in-memory list (`autoApprovals` on `/local/sessions`, `autoApprovals` count on
`/healthz`). The interface shows an `auto (here)` / `auto (project)` chip.

**How to turn it off:** the same ⋯ menu item in the conversation, or the project menu, or
`POST /local/sessions/:id/auto {"enabled": false}`.

### The admin surface (Phase 2B)

`/local/admin/*` is the part of the interface that can change things on the machine: restore a
backup, close a leftover process, write the remote-access choice, change the allowed roots,
restart the server, run `tailscale serve`. It is all in `src/net/admin.mjs`, and it carries four
rules applied route by route:

1. **token** — every route goes through `owner.gate`, like every other route of the person. No
   token: 401. (`test/admin-api.test.mjs` walks the list without a token.)
2. **origin** — actions that change state on the machine are only accepted from this machine's
   browser (`isLocalRequest`): a request carrying a foreign `Origin` gets 403. This is the rail
   against *another site's browser*, not a network boundary — the token is the boundary, and a
   non-browser client holding the token can forge the header. That is this document's model.
3. **confirmation** — irreversible actions require a `confirm` field that **repeats the object**
   (the backup's name, the pid, `impostazioni`, `riavvia`, `applica tailscale`), and the server
   compares it. A dialog is a courtesy; this is the actual check.
4. **no commands from the browser** — the only things executed are `tailscale serve`, with this
   server's loopback address (never a value from the request), and `taskkill` on a process that
   has been **recognised** as ours. No route runs a string it received.

CSRF: state-changing routes are POSTs with a JSON content type; the gate cookie is `SameSite=Lax`
and does not travel on a cross-site POST; a foreign `Origin` is refused. No GET changes anything.

**What a dedicated review of this surface found, and what changed.** Three real issues, all
fixed with a test that would catch them again: the panel's two download links carried the token
in the query string (now fetched with the header, delivered as a blob — a token in a URL ends up
in proxy logs and download history); `checkRoot` followed a junction in the *middle* of a path and
called `stat` before `lstat`, which both accepted a root living on someone else's share and made
this machine authenticate to it *while validating* (now the path is walked piece by piece with
`lstat`, and saved roots are re-checked on load); and the process-kill route skipped its own id
check when the body sent an empty `sessionId`, so it could close a `claude` belonging to a
conversation opened in another window (now the id must be in this registry). Three smaller ones:
backup downloads trusted file names written in the manifest (now the same closed list as restore),
two writing routes were missing the origin check, and a trailing dot in the `Host` header would
have skipped the surface lock silently.

**A process is ours only if we can prove it.** The scan looks for `--session-id`/`--resume` and
compares the id against our own registry — never the executable name, because on a normal machine
`claude` also runs for the interactive session of whoever is at the keyboard and for a previous
rig. A process we cannot recognise is **not** closed, and says why. Leftovers are identified from
a ledger we write ourselves when we spawn, so a conversation opened in another window (`wra new`,
`wra attach`) is never mistaken for a leftover to clean up.

## The parts that matter most

**Approvals never fail open.** The `PermissionRequest` hook calls the server and waits for a
human. If nobody answers within `CR_APPROVAL_TTL_S` (default 120s), if the server is down, or if
the answer is unreadable, the hook exits **silently** — which means "no decision", and Claude Code
shows its normal dialog in the terminal. There is no path through the code that ends in `allow`
by accident. Setting `CR_APPROVAL_TTL_S=0` turns the relay off entirely.

**Tokens are never stored in the clear.** Access and refresh tokens are kept as SHA-256 digests.
Refresh tokens rotate on every use, and a *reused* refresh token revokes the whole family
(access tokens included) and forces a new consent — that is the "token was copied" signal.

**The owner token is never printed.** Not at startup (the log says where the file is), not in
responses, not in headers, not in the log file. `test/secrets.test.mjs` walks twelve responses,
their headers, the server log and stdout, and fails if the token appears anywhere.

**Nothing about the agent's input is trusted as markup.** The UI builds DOM nodes and never uses
`innerHTML`; markdown is parsed into blocks and links are only `http(s)`, `mailto`, relative or
fragment. `javascript:` and `data:` links stay text.

## What was verified, and how

| Claim | Test |
|---|---|
| The full OAuth flow, including PKCE, rotation, reuse revocation and revocation | `test/oauth-flow.test.mjs`, and over real HTTPS with `tools/smoke-oauth.mjs` |
| Redirect allowlist (exact host, no suffix tricks) | `test/auth.test.mjs` |
| The token does not leak | `test/secrets.test.mjs` |
| Rate limits are wired to the public routes | `test/rate-limit.test.mjs` |
| Foreign origins are refused on the websocket | `test/e2e.stub.test.mjs`, `tools/smoke-remote.mjs` |
| The registry refuses to start rather than discarding conversations | `test/registry-recovery.test.mjs` |
| The controlled automatic mode grants only inside the project, never for commands, patterns, network, credentials or reserved paths, and never across a symlink | `test/auto-policy.test.mjs` (9 cases), `test/e2e.stub.test.mjs` |
| A broken policy, a missing decision or a dead relay costs a prompt, never a permission | `test/approvals.test.mjs` |
| Revocation takes effect on the next request, with no restart | `test/approvals.test.mjs`, `test/e2e.stub.test.mjs` |
| The automatic mode cannot be combined with `bypassPermissions`, in either direction | `test/registry.test.mjs`, `test/e2e.stub.test.mjs` |
| The `PermissionRequest` hook's allow/deny/silence contract | Run by hand in an isolated temp directory on 2.1.317 (see below) |

## Known limitations — read these

1. **The token is the only factor.** It lives in the phone's/browser's `localStorage` and is typed
   or passed once via `?token=` (which the page immediately strips from the address bar with
   `replaceState`). Anyone who reads it is you. If you expose the browser path publicly, put an
   identity provider in front (Cloudflare Access or equivalent) — the previous system did.
2. **No second factor, no per-client audit trail** for the browser path.
3. **The OAuth store is in memory.** A server restart invalidates every MCP token; clients must
   re-authorise. That is a security property, and an operational annoyance.
4. **`bypassPermissions` is per conversation, and stays local.** The default is `default`; `wra new`
   asks for the bypass on the conversation it *creates*, and only the CLI does. A resumed
   conversation keeps the mode it had. A bypass conversation **cannot be exposed to MCP** and an
   exposed one cannot be put into bypass (the registry refuses both directions): a remote client
   never drives a conversation where the agent acts without asking. `wra permissions default`
   turns it off; the interface shows a `bypass` chip.
   *Not verified by execution in this session*: that `claude` accepts `bypassPermissions` was
   checked against its own `--help` list and the argument we pass, not by running an agent in
   that mode (the sandbox refuses to launch one). Verify with `wra permissions bypassPermissions`
   on a throwaway conversation.
5. **A local attacker wins.** Anything that can read your files or run a process as you can read
   the token, the registry and the transcripts. This is not a defence against a compromised
   machine.
6. **The agent's own blast radius is not contained.** WRA runs `claude` with your
   credentials and your filesystem access, exactly as your terminal does. The approval relay gives
   you a place to say no; it is not a sandbox.
7. **Cloudflare Access must be configured correctly**, and a wrong rule type (Allow with a path
   criterion instead of Bypass) silently blocks the MCP endpoint. `tools/smoke-oauth.mjs` is how
   you find out before ChatGPT does.
8. **`npm audit` is clean as of this commit** (zod updated to 4.x). Dependencies are few on
   purpose; check again before exposing anything publicly.
9. **A path that goes *through* a link is refused, and that is deliberate.** `resolveProjectDir`
   walks every component below the allowed root with `lstatSync` and rejects symlinks, junctions
   and mount points (a junction towards a network share would otherwise make the machine
   authenticate to somebody else's server *during validation* — the NTLM relay the UNC check
   exists to prevent). The allowed root itself is not checked: it is your configuration, not
   something someone can plant. A junctioned `CR_ALLOWED_ROOTS` entry therefore still works, and
   elsewhere a symlinked projects folder has to be given to WRA by its real path.

10. **The controlled automatic mode's boundary is the machine, not the repository.** Writing
    `package.json`, a `.github/workflows/*.yml`, a `Dockerfile` or a `CLAUDE.md` inside the
    project is auto-approved, because those files *do nothing by themselves*: running any of them
    needs `Bash` (always asked), and a workflow only runs once a human pushes. The boundary is
    drawn at "what executes on this machine, now" — not at "what could be dangerous later, in
    somebody else's judgement". Choose the project accordingly: a workspace containing credentials
    or deploy scripts is not the same as a scratch folder.
11. **A project can arrive carrying its own permission rules.** `.claude/settings.json` inside a
    project is read for the sessions that run there, and can grant tools permissions on its own —
    it cannot select `auto` or `bypassPermissions` (the docs are explicit that those two do not
    take effect from project settings), but a mode like `acceptEdits` is a different story. The
    automatic mode refuses to *write* those files (that is why `.claude/` is reserved), but it
    cannot un-invent one that was already in a repository you cloned. The automatic mode is not a
    substitute for knowing what a project contains.
12. **Nothing here confines the agent's process.** The controlled automatic mode decides *whether
    a tool call is allowed*, at the same point the human would. It does not sandbox the agent, does
    not limit the network, and does not stop an approved tool from doing something unexpected with
    an argument nobody anticipated. For that there is the OS-level sandbox Claude Code ships
    (below), which is enforcement at the kernel, and is the right tool when you want commands to
    run without asking.
13. **A turn is not killed by a timeout, and that is a deliberate widening.** The listen window
    (`CR_MAX_WAIT_MS`, 10 minutes) only decides how long a reader watches the transcript; when it
    expires the turn keeps running and a new window opens on the same offset. The real ceiling is
    `CR_TURN_HARD_MS` (4 hours), after which the turn closes with its partial and a stated reason.
    What this changes for an attacker: **an MCP turn can now occupy a conversation's queue for
    hours** instead of ten minutes. It cannot start a second one (the queue is per session, and a
    resumed turn never re-sends the prompt), it cannot reach a conversation the client has no
    `mcpAllowed` for, and the ceiling bounds it. The cost is availability, not confidentiality —
    and the alternative was losing the answer to any turn longer than ten minutes, which is what
    happened twice before this change.
14. **The turn journal now keeps a partial reply on disk.** `~/.cc-remote/turns.json` stores, for
    turns that did not finish cleanly, up to 4 000 characters of what the agent had written, so a
    client that lost its connection can still read the answer. It is the same material the
    transcripts already hold, under the same directory and the same protection, written only for
    turns that carry a `requestId`. It is not a new place where secrets live; it is a new place
    where **agent output** lives, and agent output was already on disk.
15. **`wait_seconds` is capped at 90 seconds by default, and clamped rather than refused.** A
    public MCP call that blocks longer than ~100 seconds is cut by Cloudflare (524) before it
    reaches the client, and a cut response looks like a broken server. The cap keeps the *HTTP
    call* short; the *turn* is unaffected, and `get_turn_status` retrieves the answer afterwards —
    with or without the `turnId`.

### What native Claude Code can enforce (checked 2026-11-03, Claude Code 2.1.317)

The automatic mode was built after checking what the tool already does on its own, so that the
code here adds a boundary instead of duplicating a weaker one — and so that this document does not
claim a guarantee the tool does not make. Sources: the official docs (fetched 2026-11-03),
`claude --help` on the installed 2.1.317, the strings of the installed binary, and two runs.

| Claim | Evidence |
|---|---|
| **The file tools can be confined to the working directories by Claude Code itself** — the tools *refuse* reads/writes outside them | `permissions.blockReadsOutsideWorkingDirectories` and `permissions.blockWritesOutsideWorkingDirectories` (v2.1.314+), docs/permissions.md: "the `Write`, `Edit`, and `NotebookEdit` tools refuse writes there… **The key doesn't limit shell commands, MCP tools, or the programs hooks run, so use sandboxing to limit where shell commands write.**" |
| **Protected paths are never auto-approved** (`.git`, `.claude`, `.mcp.json`, `.npmrc`, settings files, …), and `permissions.allow` cannot pre-approve them | docs/permissions.md: "`permissions.allow` rules in settings files do not pre-approve protected-path writes. The safety check runs before Claude Code evaluates allow rules from settings." |
| **Deny rules hold in every mode — including `bypassPermissions`** | docs/permission-modes.md: "Deny rules block in every mode, including `bypassPermissions`." |
| **The OS-level sandbox does not run on native Windows** | docs/sandboxing.md: "The sandbox runs on macOS, Linux, and WSL2. **On native Windows, Claude Code runs commands unsandboxed.**" (macOS: Seatbelt; Linux and WSL2: bubblewrap) |
| **Bash rules are text matching, not a boundary** | docs/permissions.md, on `blockWritesOutsideWorkingDirectories`: it "doesn't limit shell commands"; and on Bash rules generally: they match "the command text Claude writes" and "isn't a security boundary around the program" |
| Permission modes: `default`(= `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` | `claude --help` (`--permission-mode`) and docs/permission-modes.md |
| `acceptEdits` auto-approves "Reads, file edits, and common filesystem commands (`mkdir`, `touch`, `mv`, `cp`, etc.)", only "inside your working directory or `additionalDirectories`" | docs/permission-modes.md |
| `--restricted` removes the tools that run code (Bash, PowerShell…) and WebFetch, confines file tools to the working directories, ignores project/user settings, refuses `bypassPermissions` | `claude --help`, verbatim, 2.1.317 |
| A hook's `allow` skips the prompt but **does not override deny/ask rules** | docs/permissions.md: "Deny and ask rules are still evaluated regardless of what the hook returns"; "a matching ask rule still prompts even when the hook returned `"allow"`" |
| A `PreToolUse` hook that exits 2 blocks the call **even in `bypassPermissions`** | docs/hooks.md: "Exit with code 2 to block the action… Exit 2 blocks even when your hook prints JSON"; docs/permissions.md: "A blocking hook also takes precedence over allow rules." (WRA does not use this: `exit 2` is not honoured on the `PermissionRequest` event, which is the one it uses) |

The `PermissionRequest` check was run in an isolated temporary directory with a hook written for
the purpose, in print mode with `--permission-mode default`:

- hook answers `allow` → `Write` creates the file, no prompt, no human;
- hook answers `deny` with a message → the tool is blocked and the message reaches the model
  ("Write negato: `negato dal test`. File non creato.");
- hook produces **no** decision (the first attempt had a bug in the hook itself) → the tool is
  blocked, not allowed.

That third case is the whole design of `src/host/perm-hook.mjs` and of
`src/host/approvals.mjs`: every error path in this codebase ends in silence, because silence means
"not my decision", and the one outcome that must never happen by accident is an `allow`.

**The limits, stated plainly.** On native Windows, shell commands cannot be confined by Claude Code:
the sandbox needs macOS, Linux or WSL2. So the honest position is that *no* configuration makes
`Bash` safe by location on this platform — not WRA's, not a settings file's. That is why the
central rule of this feature is that commands always ask, and why the answer to "commands without
a prompt" is a sandbox (WSL2, a container, a VM), never a filter over command text. Note also that
a configuration which *looks* like confinement can be weaker than it reads: the "common filesystem
commands" that `acceptEdits` auto-approves move and copy files, and `sandbox.credentials` only
masks anything when the sandbox is actually running.

**Alternatives considered, and why this shape was chosen.**

- `bypassPermissions` removes the approvals instead of narrowing them, and leaves nothing enforcing
  anything. Hence the registry's two-way refusal to combine it with MCP exposure or with the
  automatic mode.
- `acceptEdits` is the closest native equivalent — file edits inside the working directory stop
  asking — but it also auto-approves `mkdir`/`touch`/`mv`/`cp`, and it is fixed at process start:
  `--permission-mode` is a launch argument (the registry itself restarts the conversation to change
  it), so "revoked for the next turn, without a restart" is not something the mode can offer. It
  also cannot be limited to conversations exposed to MCP, and a project's own settings can select
  it for a session you did not configure.
- `permissions.allow` rules (`Edit(./src/**)`) move the decision into settings, where it is
  evaluated before the relay, is not per-conversation, and can be carried in by the repository
  itself.
- A `PreToolUse` hook that exits 2 would be *stronger* than this feature in one respect — it blocks
  even in `bypassPermissions` — but it runs on every tool call of every session and its decision is
  still a decision about the input, which for `Bash` means reading command text. Same wall.

The relay policy is the narrowest of these: read fresh at every request, scoped to one
conversation, granting only on a verified path, and unable to override a deny the person wrote.

## Rotating the token

```bash
wra stop
# replace the contents of ~/.cc-remote/token with a new random value (64 hex characters)
wra start
```

The old token dies with the process: sessions, cookies and websocket connections are all in
memory. Verify with `curl -H "x-cc-remote-token: <old>" http://127.0.0.1:4310/local/sessions`
— it must answer 401. Note that a running server keeps accepting the *old* token until it is
restarted, which is why `wra stop` comes first.

## Reporting

This is a personal project. If you find something, open an issue without the exploit details and
say how to reach you.
