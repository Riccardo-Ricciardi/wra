# WRA installer (Windows)

A PowerShell installer, not an MSI. It needs no administrator rights and writes nothing outside
the current user's profile:

| What | Where |
|---|---|
| Program | `%LOCALAPPDATA%\WRA` (override with `-Prefix`) |
| `wra`, `rc`, `cc` | `%LOCALAPPDATA%\WRA\node_modules\.bin` (added to the **user** PATH) |
| Conversations, OAuth clients, backups, settings | `%USERPROFILE%\.cc-remote` (never touched by an update) |
| Autostart (optional) | the user's Startup folder entries created by `wra autostart install` |

It does not install Node.js, Claude Code or Cloudflare: it detects them and tells you the one
command to run. It never asks you to disable Windows security features.

## Build the artifact

```powershell
installer\build-package.ps1
```

Produces `installer\dist\wra-<version>.tgz` and `wra-<version>.tgz.sha256`. The build is
reproducible from the lockfiles with the same Node.js/npm: `web/package-lock.json` builds the UI,
`package.json` `files` decides what enters the tarball (no state, no secrets, no tests).

## Install

```powershell
installer\Install-WRA.ps1 -PackagePath installer\dist\wra-1.0.0.tgz
```

The script:

1. checks Windows 10 1809+ and x64/ARM64;
2. checks Node.js 24+ and npm;
3. checks the agent command (`claude`, or `CR_CLAUDE_CMD`) and runs `--version`;
4. detects an existing cc-remote/WRA state folder and treats the run as an update;
5. installs the tarball under `%LOCALAPPDATA%\WRA` with `npm install --prefix` (no `-g`);
6. adds that bin folder to the **user** PATH (new terminals only);
7. creates the state folder if missing (the server creates the token there on first start);
8. starts the server only if none is running (`wra start` refuses a second one);
9. optionally installs autostart at logon;
10. opens `http://127.0.0.1:4310/welcome` (the guided onboarding).

Useful switches: `-DryRun` (detect and print the plan, change nothing), `-Yes` (no prompts),
`-NoPath`, `-NoStart`, `-NoAutostart`, `-NoOpen`, `-NoClaudeCheck`, `-Prefix <dir>`.

Non-interactive runs never take the aggressive answer: a prompt that cannot be read uses its
safe default (no autostart, keep state).

## Update

Run the installer again with the newer tarball. It replaces the program folder and leaves
`%USERPROFILE%\.cc-remote` untouched. Existing conversations keep their ids; OAuth clients stay
registered; settings keys are unchanged. To roll back, install the previous tarball the same way.

## Uninstall

```powershell
installer\Uninstall-WRA.ps1            # keeps conversations
installer\Uninstall-WRA.ps1 -PurgeState # asks you to type DELETE, then removes state
```

Default: stops the server, removes the autostart entry, removes the PATH entry and the program
folder, and **keeps** `%USERPROFILE%\.cc-remote`. `-DryRun` shows the plan.

## Limitations

- Not code-signed. Windows SmartScreen may warn on first run; sign the `.ps1`/package with an
  Authenticode certificate before public distribution. Do not tell users to disable SmartScreen.
- No MSI/MSIX: no Add/Remove Programs entry. The uninstall script is the removal path.
- The PATH change applies to new terminals; the current window gets it only for the installer's
  own session.
- Tested on Windows 11 24H2/25H2 (build 26300), x64, PowerShell 5.1 and 7. Node.js ARM64 is
  detected but not exercised on this machine.
