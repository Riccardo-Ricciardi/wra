# Design

Why WRA is built the way it is. Every decision here was paid for by a problem in the
previous system (`claude-remote`, built on a patched copy of cloudcli): the point of this
document is that nobody has to rediscover them.

## The one decision everything follows from

**One conversation = one process = one id.**

The old system keyed the PTY on the *project folder*: the second conversation in the same folder
attached to the first one. The transcript then followed "the most recent file in this folder",
which with two conversations in a folder is a guess. That produced the worst failure of the
project: two processes writing the same conversation, and a turn landing in the wrong chat.

Now the registry (`~/.cc-remote/sessions.json`) gives every conversation an id we choose, passes
it to `claude --session-id` (or `--resume`), and knows the transcript path exactly:

```
~/.claude/projects/<folder-as-slug>/<sessionId>.jsonl
```

No searching, no guessing, and the transcript stays where Claude Code writes it — we do not copy
or move it.

## Components

| Piece | File | Responsibility |
|---|---|---|
| PTY host | `src/host/pty-host.mjs` | spawns the real `claude` in a PTY, inheriting your environment; kills the whole tree, not just the child |
| Registry | `src/host/session-registry.mjs` | durable conversations: id, name, folder, MCP switch, archive; atomic writes with a verified backup |
| Turn coordinator | `src/host/turn-coordinator.mjs` | one turn at a time per conversation, idempotent `requestId`, bounded queue |
| Turn journal | `src/host/turn-journal.mjs` | which `requestId`s already ran and how they ended — the memory that survives a restart |
| Transcript reader | `src/core/transcript.mjs`, `src/core/conversation.mjs` | turns the event stream into messages: text, reasoning, tool cards, diffs |
| Approvals | `src/host/approvals.mjs`, `src/host/perm-hook.mjs` | the `PermissionRequest` hook, the pending requests, the decision |
| Web + WS | `src/net/*` | HTTP routes, websocket protocol, token gate, consent, rate limits |
| MCP bridge | `src/mcp/*` | the four tools, OAuth (PKCE), per-client selection |
| UI | `src/web/*` | the interface: no bundler, no framework, no `innerHTML` |

### The interface, after M8.1

`app.js` was 2634 lines with everything inside. It is 949 now, and the rest is nine **factories**,
one per responsibility. Each receives what it needs and returns its functions; `app.js` is the
wiring.

```
src/web/
  app.js            the wiring: boot, token, socket, the page hash, and the factories below
  core/    pure, provable in Node   authorization · format · markdown · ordering · registry-hygiene · session-view
  state/   the network, no DOM      api · socket
  ui/      knows the DOM            dom · icons · terminal-reset
    views/ shell · list · chat · selection · terminal · projects · activity · permissions · admin
```

The rule of the boundaries, and each one is real — the benches are what says so:

- `core/` does not know the DOM; `state/` knows the network and not the DOM; `ui/` knows the DOM
  and does not call `api()` directly. Whoever draws does not decide, whoever decides does not draw.
- **selection** does not know about the filters — it reads from the DOM the rows that are on screen,
  so "what you see" and "what you'd take" cannot drift apart;
- **list** does not know what happens when you tick a row: it is handed `pick`;
- **chat** does not know how a conversation is chosen, nor how it is authorised;
- **terminal** does not know what is in the other tabs;
- **shell** is the only one that knows all the others — the nav, the header, one screen at a time —
  and that is its job.

## The turn

Sending a message is the part that looks simple and is not. A conversation is a TUI inside a PTY,
so "send a message" means: wait until the TUI is really ready, type the text, then work out from
the transcript which turn was ours and when it ended.

1. `sinkFor(sessionId)` starts the process if it is not running and waits for the TUI to go quiet
   (its first output, then a pause) — writing too early means the text disappears into a
   startup screen.
2. The prompt is written into the PTY.
3. The transcript is tailed until a user entry matching our text appears: that pins the turn to
   *this* conversation and gives us its `promptId`.
4. The assistant entries are assembled until the turn closes (`end_turn` plus a quiet window).
5. If the process dies meanwhile, the turn ends immediately with a clear error instead of waiting
   for the long timeout.

Every step is bounded, every step gives up with a message that says what happened.

## What the transcript gives us (and what it does not)

Claude Code's transcript is an event log, not a message list: a reply with three tools is four
entries, and tool results arrive later in `user` entries nobody typed. Everything the interface
shows comes from there:

- `text`, `thinking` (with `thinkingDurationMs`), `tool_use`, `tool_result` (`is_error`);
- `toolUseResult`: `stdout`/`stderr` for Bash, `filePath` + `structuredPatch` for edits — a
  **unified diff** already, which is why the UI draws diffs instead of reconstructing them;
- `permissionDecision` per call: allowed by config, by mode, or by a person;
- `timestamp`, `message.model`, `cwd`, `sessionId`.

Everything else in the file (`attachment`, `api-request`, `ai-title`, `mode`, `file-history-*`,
…) is not conversation and is skipped. Nothing is invented: if a field is absent, that piece is
absent. There is no "thinking…" indicator made up by the client — the only activity signal is
`busy`, which the turn coordinator actually knows.

## Storage

| File | Content | If it is lost |
|---|---|---|
| `~/.claude/projects/…/<id>.jsonl` | the conversation itself (Claude Code's) | gone for good — this is why nothing here ever writes to it |
| `~/.cc-remote/sessions.json` | id, name, folder, MCP switch, archive | recovered from `.bak`, or the server refuses to start |
| `~/.cc-remote/sessions.json.bak` | the previous version | only the last change is lost |
| `~/.cc-remote/turns.json` | idempotency of `requestId`s | a retried request could run twice, up to the journal's size |
| `~/.cc-remote/oauth-clients.json` | OAuth clients registered via DCR (RFC 7591) | every client gets `invalid_client` and has to register again |
| `~/.cc-remote/token` | the single secret | rotate it (`wra stop`, replace, `wra start`) |

Codes and tokens are **not** in that file, on purpose: a `client_id` is an identity the client
keeps and re-presents, a token is a live credential. Only the first is worth surviving a restart.

Atomic writes everywhere: write to a temporary file, verify what is there, copy it to `.bak`,
rename. A half-written registry is worse than none.

## Protocols

**Websocket (proto 2)** — the client says who it is (`terminal` writes, `viewer`/`chat` only
watch) and which conversation it follows. The server sends `output` (raw PTY bytes for the
terminal), `chat` (messages; `history: true` means "this replaces what you have", otherwise
upsert by id), `approval`/`approval_gone`, `sessions`. The owner's selection of a client never
moves another client's.

**MCP** — four tools: `list_chats`, `select_chat`, `talk`, `get_turn_status`. The selection is per
OAuth client and lives only in memory: a restart makes clients select again (documented in the
tool descriptions). `mcpAllowed` is a per-conversation ACL, and an explicit `session_id` is not a
way around it.

## Deliberate non-goals

- **No bypass by default.** The permission mode is `default`. It is a property of the
  **conversation**, not the server: `wra new` asks for `bypassPermissions` on the conversation it
  creates (a person, at this machine, who asked for it); the site and MCP clients never do.
  A bypass conversation cannot be exposed to MCP, and an exposed one cannot become bypass — so
  a remote client never drives a conversation where the agent acts without asking.
- **No tunnel provider in the code.** Bind to loopback, one token; the HTTPS front is your
  business (and is documented).
- **No framework, no bundler in the UI.** One stylesheet, one script, hand-drawn SVG icons. It
  loads instantly and there is nothing to keep up to date.
- **No state in the browser** beyond the token and two preferences.
