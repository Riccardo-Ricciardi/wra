# CLI reference

`wra` is the primary command. `rc` and `cc` are compatibility aliases: `rc <command>` is the same
as `wra <command>`, and `cc` is `wra attach --new --bypass`.

## Everyday commands

| Command | What it does |
|---|---|
| `wra` | open the workspace: start the server if needed, then open the interface |
| `wra new [name]` | create a conversation in this folder and attach this terminal to it |
| `wra -c` | resume the most recently active conversation of this folder (creates one if none) |
| `wra doctor` | one line per check: server, token, agent, registry, transcripts, bridge |
| `wra status` | server state, conversations, busy turns, MCP selections |
| `wra sessions` | list conversations with state and MCP authorisation |
| `wra start` | start the server in the background (never a second one) |
| `wra stop` | controlled shutdown; conversations stay in the registry |
| `wra restart` | stop and start (settings and restores are read at startup) |
| `wra web` | open the interface in the browser |
| `wra admin` | address of the admin panel and what it says now |

## Conversations

| Command | What it does |
|---|---|
| `wra attach [id\|name]` | attach this window to a conversation (no argument: this folder's) |
| `wra attach --new` | create and attach a new conversation, even if one exists |
| `wra attach --view` | read-only attachment |
| `wra attach --bypass` | the created conversation skips permission prompts |
| `wra detach [id\|name]` | detach attached windows without a key press |
| `wra permissions [mode]` | show or change the mode of a conversation |
| `wra use [id]` | choose the conversation for this machine (`talk`, local CLI) |
| `wra talk [message]` | send a turn to the selected conversation and print the reply |
| `wra migrate` | bring conversations already on disk into the registry |

## State and access

| Command | What it does |
|---|---|
| `wra backup` | copy the state; `--list`, `--verify <folder>`, `restore <folder>` |
| `wra access` | configure/print Tailscale or Cloudflare access; never runs commands |
| `wra autostart` | `status`, `install`, `install --tunnel <name>`, `remove` |
| `wra serve` | run the server in the foreground (for a terminal, not a service) |

## Exit codes and non-interactive use

Commands print human-readable lines and exit non-zero on failure. `wra doctor` exits 1 if any check
fails, which makes it usable in a script. `wra new` without a TTY creates the conversation and
prints how to attach; it never tries to drive a chat through a pipe. `wra attach` requires a real
terminal and says so.

## Environment

Configuration is environment-only (`CR_*`). The common ones: `CR_PORT`, `CR_TOKEN`, `CR_MCP_HOST`,
`CR_ISSUER_URL`, `CR_RESOURCE_URL`, `CR_REDIRECT_URI_HOSTS`, `CR_CLAUDE_CMD`, `CR_PERMISSION_MODE`,
`CR_RATE_<NAME>_MAX` / `_WINDOW_S`, `CR_REMOTE_UI=classic`. Full list with defaults:
`src/config.mjs`.
