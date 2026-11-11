# Personal-data audit for the public release

Audited 2026-11-10 on `release/1.0`. No history was rewritten and no file was removed. Values are
described, not reproduced: this document must not become another copy of them.

## Current working tree

| Where | What | Status |
|---|---|---|
| `LICENSE` | copyright holder name | **intended**: MIT requires it; confirm the holder spelling |
| `HANDOFF.md` | 19 hits: production hostname, tailnet name, personal machine paths, phone model | **keep private** |
| `SPIEGAZIONE.md` | personal introduction by name | **keep private** |
| `RAPPORTO.md` | daily work diary; machine paths and decisions | **keep private** |
| `docs/REGISTRO-ANALISI.md` | analysis of real conversations and real project names | **keep private** |
| `docs/M81-APERTO.md`, `docs/M9-AUDIT.md` | internal audits with machine paths | **keep private** |
| `docs/PRODUCTION-MIGRATION.md`, `docs/LEGACY-RETIREMENT.md` | activation/retirement plans with machine paths and legacy inventory | **keep private** |
| `docs/screenshots/m9/*/relazione.txt` | bench reports with absolute machine paths | **remove from the release tree** |
| `docs/screenshots/m9/reale/audit.json` | six hits: a real project name in captured ARIA labels | **remove or sanitize** |
| Operational docs and tests | production domain, tailnet name | **cleaned**: replaced with `example.com` / `example` placeholders |
| State files, tokens, `.env`, backups | — | **never tracked** (verified) |
| Secret literals (private keys, `ghp_`, `sk-ant-`, `AKIA`, access tokens) | — | **none in history**; the only pattern hits are the audit's own search words |

No real conversation transcript, OAuth client secret, access cookie or Cloudflare credential is
tracked.

## Git history

- 152 commits, one author identity: a personal name and a personal email address on **every**
  commit. Commit metadata is public on a public repository.
- The production hostname appears in **13** commits, the tailnet name in **8**, all introduced by
  documentation and tests (now sanitized in the tree; old commits still carry them).
- The real registry token is **not** in any commit (`git log -S <token>` empty).
- No state file was ever added (`git log --diff-filter=A` audit empty).

## Proposed strategy (no history rewrite)

1. **Publish a sanitized release tree, not the development history.** Create the public repository
   from a clean export of the release commit (`git archive` or a fresh `git init` + commit). The
   public repo then carries one commit, the sanitized tree, and no personal history.
2. **Keep the full development repository private** (or publish it later only after an explicit
   decision). It contains the diaries and the history above.
3. **Before exporting**, remove the private documents listed above from the exported tree only:
   `HANDOFF.md`, `RAPPORTO.md`, `SPIEGAZIONE.md`, `docs/M81-APERTO.md`, `docs/M9-AUDIT.md`,
   `docs/REGISTRO-ANALISI.md`, `docs/PRODUCTION-MIGRATION.md`, `docs/LEGACY-RETIREMENT.md`,
   `docs/screenshots/m9/*/relazione.txt`, `docs/screenshots/m9/reale/audit.json`.
   The screenshots themselves contain no secrets and can stay.
4. **Commit metadata for the future:** set `user.email` to the GitHub noreply address
   (`<id>+<login>@users.noreply.github.com`) in a **new** repository, so later public commits do not
   expose the personal address. Existing commits are untouched.
5. If the full history is ever published, the only remaining item is the domain/tailnet in old
   docs. Decide whether that is acceptable; rewriting history needs explicit approval and
   `git filter-repo`, and is not proposed here.

## What must remain private

`HANDOFF.md`, `RAPPORTO.md`, `SPIEGAZIONE.md`, `docs/REGISTRO-ANALISI.md`, `docs/M81-APERTO.md`,
`docs/M9-AUDIT.md`, and the M9 bench reports. They describe the owner's machine, network, real
conversations and working routine, and have no value for an external reader of the product.
