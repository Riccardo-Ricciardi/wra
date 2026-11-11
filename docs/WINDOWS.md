# Windows

## First time

```powershell
cd $HOME\Desktop\Projects\cc-remote
npm ci
wra start         # prints the address; the token file is created on first run
wra doctor        # everything green? then you are done
```

Nothing is installed as a service, no scheduled task is created, no registry key is written. To
remove WRA, delete the folder (and `~/.cc-remote` if you also want the registry gone — that
directory keeps its historical name for compatibility).

## The commands

| Command | What it does |
|---|---|
| `wra` | opens the workspace: starts the server if needed, then opens the interface |
| `wra new` | new conversation in the current folder, attached to this window — with permissions bypassed |
| `wra -c` | the most recent conversation of this folder (creates one if there is none); keeps its permission mode |
| `wra start` | starts the server in the background, no window; never a second one |
| `wra stop` | controlled shutdown: closes the PTYs, keeps the conversations |
| `wra status` | what is running, which conversations exist |
| `wra doctor` | registry, backup, journal, `claude`, transcripts, bridge, turns, approvals |
| `wra web` | opens the interface in the browser |
| `wra access` | how to reach the dashboard from outside (Tailscale / Cloudflare): writes the choice, prints the commands, runs nothing |
| `wra attach [id\|name]` | attaches this window to a conversation; Ctrl+Q detaches (`--bypass` to create it with permissions bypassed) |
| `wra detach [id\|name]` | detaches the attached windows, without touching the conversations — the way out when a terminal swallows Ctrl+Q |
| `wra permissions [mode]` | a conversation's permission mode; `wra permissions default` restores the normal one |
| `wra sessions` | list of conversations with state and MCP switch |
| `wra migrate` | conversations already on disk, to bring into the registry |
| `wra backup` | safety copy of the state; `--list`, `--verify`, `restore` |

`wra`, `cc` and the slash commands come from `~/.claude/claude-aliases.ps1` and
`~/.local/bin/rc.cmd`. **`cc`, `cc -c` and `rc …` remain valid aliases for backward compatibility**;
`wra new` and `wra -c` are the normal gestures, and `wra` with no command opens the workspace. The
previous rig's entry point is kept as `rc-old.cmd`.

### Detaching (Ctrl+Q)

`Ctrl+Q` detaches the window; the conversation stays alive in the server. `Ctrl+]` does the same.
If neither arrives — that used to be the normal case, and it is fixed now — run `wra detach` from
another window.

Why it used to fail, since it is the kind of thing that looks like a broken key: ConPTY writes
`ESC[?9001h` (win32-input-mode) as the first bytes of every PTY, and `wra attach` forwarded that to
your terminal, which then started encoding every keypress as a win32 sequence instead of a byte.
`0x11` simply stopped existing. The `ESC[?9001l` that turns the mode off is swallowed by conhost,
so it never went away on its own. WRA now strips both requests from the output before they reach any
client (`src/core/input-mode.mjs`, `test/input-mode.test.mjs`).

### Inside Claude Code

| Command | What it does |
|---|---|
| `/cc` or `/collegati` | opens a window attached to this folder's conversation |
| `/rig` | status, start, stop, web, doctor of the rig |
| `/claudeai` | a window with the official Remote Control (untouched, independent) |

## Starting at login (optional)

```powershell
wra autostart install                            # WRA at every logon
wra autostart install --tunnel <tunnel-name>     # ...and the Cloudflare tunnel too
wra autostart                                    # what is installed right now
wra autostart remove                             # takes both away
```

No administrator password, no service, no registry key. It writes a launcher in
`~/.cc-remote/autostart/` and a shortcut in your Startup folder; `remove` deletes exactly those
files and nothing else.

Why a launcher instead of pointing the shortcut at `rc.cmd`: a `.cmd` is run by `cmd.exe`, which
allocates a console and **shows** it. `node.exe` started by the system does the same. The launcher
is a `.vbs` run by `wscript.exe` with window style `0`, which shows nothing at all — that is the
whole reason for the extra file in the middle. `node tools/popup-check.mjs` measures this: it
watches for visible console windows and has a negative control that must see one, so "no windows"
cannot be the same output as "the detector is broken".

`wra start` is idempotent: if a server is already running, the launcher does nothing.

## Notes

- The server binds `127.0.0.1` only. Nothing on your LAN can reach it.
- `wra start` and `wra serve` both refuse to start a second server: two servers would have two
  registries, and the conversation you open in one would not be the one you see from the phone.
- If `wra start` says the server did not come up, it prints the last log lines. The log is at
  `%TEMP%\cc-remote.log` unless `CR_LOG_FILE` says otherwise (the file name is kept unchanged for
  compatibility).
- Killing the terminal does not kill the conversations: `wra start` runs detached.
- `~/.cc-remote`, `.cc-remote` directories, `CR_*` variables, the `x-cc-remote-token` header and the
  Cloudflare domain/MCP endpoint URLs keep their historical names in this phase.