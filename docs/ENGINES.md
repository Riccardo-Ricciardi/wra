# Adding another agent engine

WRA 1.0 runs Claude Code, and only Claude Code. This note is the seam a second engine would use;
nothing here is implemented for an engine that does not exist yet.

## What is already engine-neutral

- **Conversations are the unit.** `src/host/session-registry.mjs` owns id, project, permission mode,
  favorites, MCP exposure and lifecycle. None of that depends on the agent's CLI.
- **The PTY layer takes a command.** `src/host/pty-host.mjs` spawns `config.claudeCmd` with
  `config.claudeArgs`; changing the command is a configuration concern, not a code change.
- **The MCP bridge and the approval relay** speak in session ids and tool requests, not in Claude
  events (`src/mcp/tools.mjs`, `src/host/approvals.mjs`).
- **The web API** (`/local/*`) exposes sessions, messages and approvals in a generic shape.

## What is Claude-shaped today

| Area | File | What an adapter must provide |
|---|---|---|
| Transcript discovery | `src/host/pty-host.mjs` (`transcriptDirFor`), `src/core/history.mjs` | where the engine writes conversation history, and how to enumerate/resume it |
| Transcript parsing | `src/core/conversation.mjs` | map engine events to `{role, parts: text/thinking/tool}` |
| Permission integration | `src/host/session-registry.mjs` (`--settings`, hook), `src/host/perm-hook.mjs` | a way to ask before a tool runs, and the allow/deny reply |
| Permission modes | `src/config.mjs` (`permissionModes`), registry `setPermissionMode` | the engine's own mode names and which are safe to expose |
| Process detection | `src/host/processes.mjs` | how to recognise a live engine process and its conversation id |
| Diagnostics | `src/host/diagnose.mjs` | version probe and health checks for the engine |

## The shape of a second engine

1. Add an `engine` field to the registry record (`'claude' | ...`), defaulting to `'claude'` for
   records written before the field existed. Persisted state stays valid: absent means Claude.
2. Introduce an engine descriptor `{ id, command, args, capabilities, transcript, permissions }`
   and select it when a conversation is created. Do not put engine branches in the UI: the API
   already returns the fields the UI draws.
3. Implement one adapter per row of the table above. The PTY host and the turn coordinator should
   not learn a second protocol; they keep talking to a process.
4. Keep Claude Code as the only production engine until the adapter has the same safety properties
   (approval before tools, a single process per conversation, resumable state).

The deliberate constraint: do not abstract before the second engine is real. The interfaces above
are the ones a second engine would actually touch; inventing more today would be a guess.
