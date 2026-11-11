# Backup and restore

What is worth saving, how to verify it, and how to put it back.

## What is saved

| File | Content | Where |
|---|---|---|
| `sessions.json` | the registry: id, name, folder, MCP switch, archive | `~/.cc-remote/` |
| `sessions.json.bak` | the previous version of the registry | `~/.cc-remote/` |
| `turns.json` | which `requestId`s already ran | `~/.cc-remote/` |

**Not saved, on purpose**: the transcripts (they belong to Claude Code, in
`~/.claude/projects/`, and are never touched by this project) and the token (a secret has no
business being copied around).

## Making one

```bash
wra stop                      # the server writes the registry: stop it first
wra backup                    # creates ~/.cc-remote/backups/<timestamp>/
wra backup --list             # what copies exist
wra backup --verify <folder>  # recompute the SHA-256 of every file
```

Every copy carries a `MANIFEST.json` with the creation time, the number of conversations and the
SHA-256 of each file. A backup you cannot verify is a folder you know nothing about.

## Restoring

```bash
wra stop
wra backup restore ~/.cc-remote/backups/2026-10-30T20-33-31
wra start
```

The restore refuses to run if any file does not match its fingerprint, and **before overwriting
anything** it copies the current state into `backups/pre-restore-<timestamp>/`. A wrong restore
must be undoable, otherwise it is just a second way of losing data.

## Automatic recovery (no command needed)

The registry has its own protection, and it runs at startup:

1. the registry is read and validated (a session without id or folder is not a conversation);
2. if it is unreadable, the `.bak` is tried; the damaged file is kept as
   `sessions.json.corrupt-<timestamp>` and the recovery is logged;
3. if **both** are unreadable, the server **refuses to start** and says so. It never replaces
   your conversations with an empty list.

`wra start` prints the last lines of the log when the server does not come up, so a refusal is
never silent. `wra doctor` shows the state of the registry, the backup and any recovery that has
already happened.

## What a backup does not protect against

- Deleting `~/.claude/projects`: that is the conversation itself, and no WRA backup has it.
  If you want those safe, copy that folder.
- A backup older than the last change: the backup holds the *previous* registry version, so at
  most the last change (a rename, an MCP switch) is lost. Re-check those after a recovery — it is
  written in `docs/OPERATIONS.md` for a reason.
