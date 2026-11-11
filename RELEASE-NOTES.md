# WRA 1.0.0 — release notes

First public release of **WRA — Workspace Relay for Agents**, previously developed as `cc-remote`.

## What it is

WRA drives the real Claude Code TUI on your own machine and puts a browser, a phone and an MCP
client (ChatGPT) around it. One process per conversation, conversations that survive restarts, an
approval relay that never grants anything on its own unless you switch on the controlled automatic
mode, and a registry you can back up and restore.

## Highlights

- **React 2.0 interface is the default** (conversations, projects, settings, chat, terminal,
  approvals, admin). The classic interface stays available with `CR_REMOTE_UI=classic`.
- **Guided onboarding** at `/welcome`: agent detection, workspace choice, optional remote access,
  first conversation.
- **`wra new`** creates a conversation in the current folder and attaches the terminal to it;
  **`wra -c`** resumes the most recently active conversation of that folder.
- **Windows installer** (`installer/`): prerequisite detection, per-user install, user PATH,
  optional autostart, uninstall that keeps your data. Versioned, checksummed tarball.
- **Security hardening**: the dashboard/MCP surface locks now normalize case and trailing slashes;
  the OAuth review of the five Cloudflare Access findings is in
  `docs/security/CLOUDFLARE-ACCESS-REVIEW.md`.
- Docs: CLI reference, troubleshooting, engine-addition note, contributing guide, CI.

## Compatibility

- Command: `wra`; `rc` and `cc` remain aliases.
- State: `~/.cc-remote` — unchanged keys, unchanged file names. Existing conversations keep their
  ids. OAuth client registrations persist across restarts, as before.
- Environment: `CR_*` variables, `x-cc-remote-token` header, MCP endpoint URLs unchanged.
- Upgrade: install the new tarball over the old one. No migration step; no user data is touched.

## Breaking changes

None. The rebrand is naming only: the package is `wra`, the product is WRA, and the old commands
still work.

## Known limitations

- Claude Code is the only supported engine (see `docs/ENGINES.md` for the seam).
- The Windows installer is a PowerShell script, not an MSI, and is not code-signed.
- The classic fallback interface is still partly in Italian; the default React interface is English.
- Cloudflare Access policies for the machine routes are documented but must be applied by the
  owner in the Cloudflare dashboard. No DNS, tunnel or policy change is made by this release.
- A physical Android device and a real ChatGPT client completing consent are not part of the
  automated suite; the paths are verified at phone width and against the live server.

## Verification

`node --test` (543 tests before this release, plus the new security regression tests),
`node tools/check-contrast.mjs`, the package smoke test `node tools/pack-check.mjs`, and the
installer dry-run/install/uninstall-dry-run on Windows 11 x64.
