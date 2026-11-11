# Contributing

Small project, small rules.

## Setup

```bash
git clone <repo> wra && cd wra
npm ci
cd web && npm ci && npm run build && cd ..
node --test
```

Node.js 24+ is required (`node-pty` is the only native dependency).

## Before opening a pull request

- `node --test` must be green. Add or update a test for every behaviour change; the suite is the
  contract, not the documentation.
- `node tools/check-contrast.mjs` for UI colour changes.
- `cd web && npm run build` when touching `web/src`.
- Keep the change focused. `src/net/server.mjs` and `src/host/session-registry.mjs` are the two
  places where a small change has a large blast radius: run `node --test` after either.
- Do not commit state: `~/.cc-remote/`, `server.json`, tokens, logs, `web/dist`, `installer/dist`.

## Code conventions

- Plain ESM JavaScript on the server (`src/`), TypeScript + React in `web/`.
- The existing code explains *why* in comments, not *what*. Keep that: a comment that repeats the
  code is noise; a comment that records a defect and its cause is the most valuable line nearby.
- No new dependencies without a reason in the pull request. The dependency list is deliberately
  short.
- User-facing strings are English. Tests may keep descriptive names in any language.

## Security

Anything touching authentication, tool permissions, the OAuth bridge, file paths or process
management needs a test that proves the refusal, not only the success. Read `docs/SECURITY.md`
first. Report a vulnerability privately to the repository owner rather than in a public issue.
