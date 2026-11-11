# Troubleshooting

Start with `wra doctor`. It checks the server, token, agent command, registry, transcripts, the
journal and the MCP bridge, and prints one line per check. The admin panel has the same information
plus a log tail.

## The command is not found

Open a **new** terminal after installing: the installer updates the user PATH, and the current
window keeps the old value. Or run the CLI by path:

```powershell
node "$env:LOCALAPPDATA\WRA\node_modules\wra\src\cli\index.mjs" doctor
```

## "a server is already running"

That is the intended behaviour: one server, one registry, one set of processes. Use `wra status`
to see it, or `wra restart` after changing settings. Two servers would each own a different
registry, and a conversation opened in one would not be the one the other shows.

## The browser says the token was refused

The token lives in `~/.cc-remote/token`. If it was rotated, the old browser session is invalid: sign
in again with the new value. `wra status` prints where the token is, never the token itself.

## The agent does not start, or starts and exits

- `claude --version` must work in the same terminal, with the same environment.
- If you set `CR_CLAUDE_CMD`, it must point to the real executable; a wrong value is reported by
  `wra doctor` as "the agent command responds: not found".
- Behind a corporate proxy or gateway, the child process inherits your environment unchanged; WRA
  does not rewrite API keys or base URLs.

## A conversation shows no messages

WRA reads the agent's transcripts, it does not store a second copy. If the transcript is gone, the
conversation opens empty but stays in the registry — by design, nothing is deleted to make a list
look tidy. `wra migrate` finds conversations that exist on disk and are not in the registry yet.

## The terminal view is empty but the chat works

The chat and the terminal are two views of the same conversation. A conversation with no running
process shows an empty terminal until you start it (`⋯ → Start process`). Detaching a window
(Ctrl+Q) never stops the conversation.

## I am locked out after `wra stop`

`wra stop` keeps the registry and the token. Start again with `wra start`; the address and token
file do not change. Your conversations keep their ids.

## Updating went wrong

Install the previous tarball the same way (`installer\Install-WRA.ps1 -PackagePath <old.tgz>`).
State in `~/.cc-remote` is never overwritten by an install or an update, and the previous registry
is also kept as `sessions.json.bak`, plus the backups under `~/.cc-remote/backups/`.

## Roll back the interface

The React UI is the default when `web/dist` exists. Start the server with
`CR_REMOTE_UI=classic` to use the classic interface.

## ChatGPT cannot connect

Follow `docs/CHATGPT.md`. The machine routes (`/mcp`, `/register`, `/token`, `/revoke`,
`/.well-known/*`) need a path-scoped Cloudflare **Bypass**; the dashboard needs Access **Allow**.
`wra access` prints the exact rules, and `wra admin` shows what the server currently believes.
