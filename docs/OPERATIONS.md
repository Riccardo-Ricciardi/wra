# WRA — operations and release criteria

## Service model
- The WRA server runs on the Windows PC, listening only on 127.0.0.1:4310.
- Tailscale Serve exposes HTTPS only to authorised devices on the tailnet; do not use Funnel for the browser.
- One Claude Code process per conversation. Every session has a persistent sessionId and MCP state disabled by default.
- The old claude-remote remains a fallback until the final acceptance test: do not delete it to free a port.

## Long turns: what to watch when it "does not answer"
An MCP turn no longer dies when the listening window expires: it continues, and the result is
retrieved later. Three different values, and confusing them is the mistake that lost two turns:

| Variable | Default | What it really decides |
|---|---|---|
| `CR_MAX_WAIT_S` | 90 | How long an MCP call **stays hanging**. Below Cloudflare's ~100 s cut: raising it above leads to a 524, not a longer answer. |
| `CR_MAX_WAIT_MS` | 600000 (10 min) | How long **one listening window** of the transcript lasts. When it expires the turn does not end: another one opens from the same point. |
| `CR_TURN_HARD_MS` | 14400000 (4 h) | The real ceiling of a turn. Beyond it, the turn closes with the partial and a reason. |
| `CR_TURN_STALL_MS` | 900000 (15 min) | How long a turn can produce **nothing** before appearing among the suspects in `wra doctor`. It closes nothing: it is only the difference between "it is working" and "it has stopped". |

What to do, in order, when a turn seems lost:

```powershell
wra doctor                                                    # the suspicious turns, with how long they have been idle
curl -H "x-cc-remote-token: $(Get-Content ~/.cc-remote/token)" http://127.0.0.1:4310/healthz
```

In the `turns` field: `sessions` says what is running now and how many are queued, `stuck` lists the
turns that are no longer producing anything. The **journal** (`~/.cc-remote/turns.json`) keeps the
last answer of every `requestId`, even after a restart: it is there that you find a turn whose id
the client lost. An in-progress turn is **not** a failure: `watches` in the result says how many
listening windows have followed one another.

## State and recovery
- Registry: ~/.cc-remote/sessions.json. The automatic backup is sessions.json.bak (previous version).
- **Organisational project metadata**: ~/.cc-remote/projects.json (display name, star, hidden),
  with its .bak. They live **outside** the registry on purpose: renaming a project in the interface
  must not be able to touch a conversation. The folder's real path is never changed from here, nor
  is the transcript.
- **Remote access choice**: ~/.cc-remote/access.json (mode, hostname), with its .bak. No secrets
  inside. `wra access` writes it; the server reads it at startup, and environment variables always
  win over it. See docs/REMOTE-ACCESS.md.
- **Self-registered OAuth clients**: ~/.cc-remote/oauth-clients.json (RFC 7591), with its .bak.
  They must stay on disk because the client keeps the `client_id`: if the server forgets it on
  restart, the client keeps presenting the old one and gets `invalid_client` forever. Inside there
  are **only the clients**: codes and tokens stay in memory and expire or are revoked as before. It
  contains the `client_secret`s of clients that have one, so the file is kept close.
- **`server.json`** (pid and port of the running server) sits **next to the registry**: if the
  registry is in its own place, so is this — that way a test does not write into the file of
  whoever uses the machine.
- If the JSON is unreadable, startup recovers from the backup and keeps the original as sessions.json.corrupt-<timestamp>.
- If both files are unreadable, the server **refuses to start** instead of wiping the conversations.
- Do NOT delete the registry to solve an error. Save a copy of sessions.json, .bak and .corrupt-* before any intervention.
- Claude transcripts are separate from the registry: ~/.claude/projects/<slug>/<sessionId>.jsonl. Recovery from .bak can lose the last change to the registry (for example MCP authorisation), not the transcript. Re-check authorisations after a recovery.

## Start and diagnostics (PowerShell)
```powershell
wra status
wra doctor
wra start
wra access            # how to get there from outside (Tailscale / Cloudflare): shows, does not run
wra sessions
wra detach            # detaches the attached windows (Ctrl+Q does the same)
wra migrate            # conversations already on disk, to bring into the registry
wra backup             # safety copy of the state (--list, --verify, restore)
```

- `wra migrate` **does not** touch the transcripts and **does not** start processes: it only
  registers. The server must be stopped (the server writes the registry). See docs/MIGRATION.md.
- **Detaching from an attached window**: `Ctrl+Q` (or `Ctrl+]`). If the key does not arrive,
  `wra detach` from another window: the server releases the grip, and the conversation stays alive.
  The reason the key could fail to arrive is closed in the code — see "The input-mode filter" below.
- Opening a folder on the PC from the interface (`Open the folder on the PC`) is the only UI action
  that does something on the machine. The server accepts it only if the request comes from a
  browser on this machine: from the phone (or from a site opened elsewhere) it remains a 403, and
  that is intended. Be careful what that means: it is a check on the **`Origin` header**, that is,
  the rail that keeps another site's browser out — not a guarantee that the request comes from the
  local network. Whoever has the token can omit or forge that header, and then it passes; but
  whoever has the token can already run the agent and read every transcript, so they gain nothing.
- `wra backup` and its `restore` need the server stopped for the same reason, and the restore sets
  the current state aside in `backups/pre-restore-*` before overwriting. See docs/BACKUP.md.
- Conversation names are unique **within the project**, and the automatic name counts per project.
  `CR_MAX_SESSIONS_PER_PROJECT` puts a ceiling on a single project (0 = none).
- Archiving removes from the list without removing the conversation, and archived conversations are
  not exposed to MCP even if the switch had been left on.
- Do not run two servers manually: wra start applies the checks against a double start.
- Before updating: git status; commit/backup the changes; stop the new rig with wra stop; do not touch the old one.
- After updating: npm ci; node --test; wra start; wra doctor; try an existing chat, a new one, an approved/denied permission.
- In case of regression, return to the verified commit, reinstall dependencies and repeat the tests. Do not migrate state data blindly.
- **`wra stop` says it cannot verify the process**: it means the recorded pid is no longer the
  server's (pids are reused) or cannot be queried. It deliberately does not stop it: do it yourself
  with `taskkill /PID <n> /T /F` (or `kill -TERM <n>`) **after** checking that it is the right one.
- **If the server is killed by force** (`taskkill /F`, Task Manager, crash), its terminals remain
  orphans: the `claude` processes of the open conversations survive. `wra stop` does not do this
  (it closes the PTYs before exiting). After a forced start, check with `tasklist | findstr claude`
  and close the ones you do not need: an orphan agent on the same conversation, plus a new one, are
  two writers on the same transcript.
- **The port does not open (`EACCES`)**: on Windows some port ranges are reserved by the system
  (`netsh int ipv4 show excludedportrange protocol=tcp`). Choose `CR_PORT` outside them. It is not a
  program permission problem, and the startup message now says so.

## Security
- Never share ~/.cc-remote/token, cookies, URLs with ?token= or OAuth tokens.
- Use the URL without a query string and enter the token on the protected page.
- Private browser access via Tailscale. The public MCP endpoint is HTTPS, with OAuth and separate
  checks for the browser and for the MCP path: see docs/CHATGPT.md.
- Do not enable bypass permissions in exposed sessions; all approvals must fail safely.
- Test token rotation over HTTP, WebSocket and already-connected sessions.

### What is already done in the code (and how to verify it)
- Per-origin rate limits on /mcp, /token, /register, /revoke, /authorize, on login and on refused
  websocket upgrades. They are tuned via `CR_RATE_<NAME>_MAX` / `_WINDOW_S`.
  Test: `node --test test/rate-limit.test.mjs`.
- Rotating refresh tokens, with **reuse detection**: an already-spent refresh revokes the whole
  family (access included) and forces consent again. Test: `node --test test/auth.test.mjs`
  and `test/oauth-flow.test.mjs`.
- `/revoke` acts only on the tokens of the client asking for it.
- The token carries which resource it was issued for, and the middleware verifies it.
- The WRA token does not appear in any response, header or log line: test
  `node --test test/secrets.test.mjs`.
- Dependencies: `npm audit` clean (zod updated to 4.x, supported by the MCP SDK).

### The input-mode filter (why Ctrl+Q did not detach)

ConPTY writes `ESC[?9001h` as the very first bytes of every session: it asks the terminal to switch
to "win32-input-mode", that is, to send keys as sequences instead of bytes. `wra attach` forwarded
that request to the local terminal, and from then on `Ctrl+Q` was no longer `0x11` — it was
`ESC[81;0;17;1;40;1_`. `ESC[?9001l`, which the TUI writes, would turn it off, but conhost swallows
it.

Now `src/core/input-mode.mjs` removes that request from the output **before** it becomes replay or
websocket, holding the tail aside when the sequence arrives split in two pieces. Test:
`node --test test/input-mode.test.mjs`. It applies to all clients together — the attached window,
the browser's terminal tab and the replay — because the filter sits where the output is born.

### What to do before exposing MCP on the internet
- Configure the two hostnames and the Access rules: docs/CHATGPT.md.
- Cloudflare Access bypass rules must be of type **Bypass**, not Allow with a path criterion: with
  Allow the Access login also covers /mcp and the connection never starts.
- Verify with `node tools/smoke-oauth.mjs https://<public-address>` before touching ChatGPT.

### The admin panel (Phase 2B)

The `/local/admin/*` routes live in `src/net/admin.mjs`, all in one file because whoever reviews
them must be able to read them together. Four rules, applied route by route:

1. **token**: they go through `owner.gate`, like every other route of the person. Without a token:
   401. Test: `node --test test/admin-api.test.mjs`.
2. **origin**: the actions that change something on the machine are accepted only from this
   machine's browser (`isLocalRequest` → 403 otherwise). It is the rail against another site's
   browser, not a network boundary: the boundary is the token, and it is written in
   `docs/SECURITY.md`.
3. **confirmation**: irreversible actions require a `confirm` that **repeats the object** (the
   copy's name, the pid, `settings`, `restart`, `apply tailscale`) and the server does the
   comparison. A confirmation window is not a protection: this is, because without the right field
   the request does not pass even if it comes from a page opened yesterday.
4. **no commands from the browser**: the only things that run are `tailscale serve` (with this
   server's loopback address, not a received value) and `taskkill` on a **recognised** pid. There is
   no route that runs a received string.

CSRF: writing routes are POSTs with `content-type: application/json`, the gate cookie is
`SameSite=Lax` (it does not travel on a cross-site POST) and a foreign origin is refused. GETs
change nothing.

Dedicated review (`security-reviewer` agent on the diff): three real issues, all closed with a
test — the token in the address of the two downloads, an allowed root that went through a junction
in the middle of the path (with `stat` authenticating the machine to a share during validation),
and the process-closing route that skipped the id check. Details and tests: `docs/SECURITY.md`, and
§5 of HANDOFF.

**What is not verified by an automated test**: running `tailscale serve` and a real restart from
the panel. They would run on the machine of whoever launches the tests, changing the real
configuration — the two guards in front are tested (confirmation and origin), and the rest is a
person's gesture.

### Settings: a safe example

`~/.cc-remote/settings.json` (written from the panel; environment variables always win):

```json
{
  "version": 1,
  "defaultProject": "C:\\path\\to\\my\\projects",
  "allowedRoots": ["C:\\path\\to\\my\\projects"],
  "updatedAt": "2026-11-02T00:00:00.000Z"
}
```

`allowedRoots` is a **boundary**, not a preference: it is the list of folders where an agent is
allowed to run. The starting folder (the home) always remains allowed, and every root is checked
before being written: no network paths (`\\server\folder`), no links (a junction as a root would
make everything on the other side look "inside"), no relative paths. A wrong path makes **all** of
it be refused, instead of saving half. Test: `node --test test/settings-store.test.mjs`.

## Release gate — all mandatory
- [ ] Unit + E2E green on Windows **and** Linux. On Windows: `node --test` → 350/350 (02/11). On
      Linux the workflow runs in CI: **it has never been seen running**, so the box stays open until
      the first push runs it.
- [x] Two chats in the same project, no contamination.
      `node tools/smoke-live.mjs` with the real claude: 9/9.
- [x] Server restart with exact resume of an existing chat.
      `node tools/smoke-resume.mjs` with the real claude: it is made to memorise a number, the
      server is stopped (the PTYs die), started again, and it answers with that number.
      `node --test test/restart.test.mjs` covers the same thing in CI, and in addition that the
      transcript does not grow when the same requestId is sent again.
- [x] Damaged registry file: recovery or safe refusal.
      `node --test test/registry-recovery.test.mjs` (6 checks): recovery from the .bak, original set
      aside as .corrupt-<ts>, refusal to start if both are broken, no .tmp left behind. Also checked
      by hand: with an unreadable registry `wra start` does not start and says so in the log.
- [~] Real desktop interface: done. 35 checks in a real browser (`tools/ui-check.mjs`) and 14 for
      the panel (`tools/ui-admin-check.mjs`), with real mouse clicks, on 520 conversations in 24
      projects; every bench builds its own throwaway registry and takes it away (M8.1), and
      `tools/bench-rounds.mjs` proves that ten rounds in a row give the same result. The panel was
      retried read-only on the live server without disturbing the open chat (02/11).
      **The real Android phone remains to be done** (8 items in `docs/PHONE.md`).
- [~] Server restart: websocket recovered. Restart with resume is proven; websocket recovery after
      a restart is proven in the lab (the client retries and no longer deletes the token), but not
      with Tailscale actually dropping.
- [~] ChatGPT MCP switch: per-chat ACL, two independent clients, idempotence after restart,
      revocation — proven in the lab (`test/mcp-tools.test.mjs`, `test/oauth-flow.test.mjs`,
      `tools/smoke-oauth.mjs`). The full round was then tried **on the live server** by sending the
      tunnel's `Host` header to the port: 17/17, tokens revoked (02/11). **The real ChatGPT client
      is missing**, and the tunnel is missing: `cloudflared` is not running, so the public address
      answers 530.
- [x] Access revocation test and rotated tokens: WRA token rotation verified over HTTP, WebSocket
      and connected sessions; OAuth revocation verified in the full round.
- [x] Verified backup of the old conversations and restore test.
      `test/backup-store.test.mjs` + `test/admin-api.test.mjs` (real restore that reloads the
      registry), and on 02/11 the round from the panel on a **copy of the real registry** (83
      conversations): create, verify the fingerprint, preview, restore. The real registry was not
      touched.
- [ ] Only after: final migration of the cc command and planned dismissal of claude-remote/cloudcli.
      Plan in order, and what is missing first: `HANDOFF.md` §5 of Phase 3 and `docs/RELEASE.md` §7.

**Do not call the project 'production-ready' until every box is satisfied.**
The checklist for publishing on GitHub, with the evidence for each item, is in `docs/RELEASE.md`.