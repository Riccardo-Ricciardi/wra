# Migrating from claude-remote / cloudcli

The old rig (`Desktop/Projects/claude-remote`) is a patched copy of cloudcli with nine patches, a
Cloudflare named tunnel, Cloudflare Access in front, a Flutter app, and one conversation per
project folder. This document maps what depends on what, how to bring the conversations over,
and how to go back.

**Nothing in this phase touches the old system.** It keeps working, and it stays installed.

## Dependency map

| What | Where it lives | Does the new system need it? |
|---|---|---|
| The conversations | `~/.claude/projects/<folder>/<id>.jsonl` | **Already shared.** Same files, same folder — cloudcli ran the same `claude` |
| Model configuration | `~/.claude/settings.json` (`apiKeyHelper`, `ANTHROPIC_BASE_URL` → OpenRouter/DeepSeek) | **Shared.** Nothing to migrate: the PTY inherits your environment |
| Transcript discovery | cloudcli's session list, `rc target` | **Replaced** by the registry: id, name, folder, per-conversation MCP switch |
| `wra new`, `wra -c` (aliases `cc`, `cc -c`) | `~/.claude/claude-aliases.ps1` | **Replaced** — the aliases already call the new `rc.cmd` |
| `/rig`, `/collegati`, `/cc` | `~/.claude/commands/*.md` | **Replaced** — they point at the new rig (`tools/rig.ps1`, `tools/cc-window.ps1`) |
| `/claudeai` | opens a window with the official Remote Control | **Untouched and independent** |
| `rc` command | `~/.local/bin/rc.cmd` | **Replaced**; the old one is kept as `rc-old.cmd` |
| cloudcli binary | `claude-remote/node_modules`, patched | **Not needed.** No operational dependency left |
| Cloudflare tunnel | `~/.cloudflared/config.yml` (hostnames for the old ports 3001/3002) | **Kept for the old rig**; the new one adds its own hostnames (docs/CHATGPT.md) |
| Cloudflare Access | dashboard | **Keep it.** The new MCP endpoint needs a Bypass rule on the machine paths |
| Tailscale Serve | `tailscale serve` | **Kept**, used for the browser/phone path |
| claude-mem | `~/.claude-mem`, hooks in `settings.json` | **Shared.** Every conversation, old or new, feeds it |
| Patches to cloudcli | `claude-remote/tools/patch-cloudcli.js`, overrides CSS/JS | **Not ported, on purpose**: this project does not patch third-party packages |

To see what still points at the old rig:

```bash
rg -l "claude-remote|cloudcli" ~/.claude/claude-aliases.ps1 ~/.claude/commands/*.md ~/.local/bin/*.cmd
```

`rc-old.cmd` is the only remaining entry point, and it is deliberate.

## Bringing the conversations over

The conversations are already on disk in the place Claude Code uses. There is no format to
convert: what was missing was a registry that knows about them.

```bash
wra stop                    # the registry is written by the server: stop it first
wra migrate                 # lists everything found on disk, grouped by project
wra migrate --import --project "C:\path\to\project"     # or --all, or --limit N
wra migrate --verify        # checks each imported conversation is resumable
wra start
```

What the importer does and does not do:

- **Does**: read the transcript's `cwd` and `sessionId`, take the title Claude Code wrote
  (`ai-title`) or the first user message, and write an entry in the new registry marked
  `imported`;
- **Does not**: write, move or delete a transcript; start a process; touch the old system.

An imported conversation stays **offline** until you use it (`wra -c`, or the browser). That is
deliberate: opening 400 conversations to look at them is not a thing anyone wants.

### When a conversation cannot be imported

The importer skips it and says why. The three real cases:

| Reason | What it means |
|---|---|
| `transcript missing` | the file is gone; only the name is left |
| `the transcript does not contain its id` | the file does not carry its own `sessionId`, so `claude --resume` would not find it. The transcript is left where it is, and it is not invented into something resumable |
| `folder outside the allowed roots` | the project folder is outside `CR_ALLOWED_ROOTS`. Importing it would mean starting a process there — widen the roots if you really want that |

Nothing is deleted in any of these cases.

### Proof that resuming works

`tools/smoke-resume.mjs` proves the whole loop with the real Claude Code: a conversation is told
a number, the server is stopped (its PTYs die), restarted, and asked for the number back. The
same has been done on an **imported** conversation: it answered with its actual historical topic
(the School Agent M24 migration window, suite `383/383`), with the same `sessionId` before and
after.

## Rollback

There is nothing to roll back in the old system: it was never modified. Going back means using
`rc-old.cmd` instead of `rc.cmd` — the old server, tunnel and patches are untouched and still
work.

If you want the *aliases* back on the old rig, restore the two files that were changed:

```powershell
Copy-Item $HOME\.claude\claude-aliases.ps1.bak-claude-remote $HOME\.claude\claude-aliases.ps1
Copy-Item $HOME\.local\bin\rc-old.cmd $HOME\.local\bin\rc.cmd
```

The conversations are shared, so switching back and forth does not lose anything: each system
finds them in `~/.claude/projects`. What changes is which registry knows their names.

## Before declaring the migration done

The old system can be dismissed only after:

1. a real Android phone has been through the browser path (keyboard, conversations, approvals);
2. a real ChatGPT client has completed the OAuth flow and exchanged messages with an allowed
   conversation;
3. the historical conversations have been imported and verified (`wra migrate --verify`);
4. an explicit decision to do so. Until then, both systems stay installed.
