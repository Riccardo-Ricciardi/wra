# Publishing on GitHub — checklist

State as of **02/11/2026**. Items with ✅ are verified with an executable test, not by eye.

## 1. What is ready (verified today)

| What | How | Result |
|---|---|---|
| Full suite | `node --test` | **350/350**, two consecutive rounds |
| Dependencies | `npm audit` | **0 vulnerabilities** |
| Contrast of the two themes (real WCAG, oklch → luminance) | `node tools/check-contrast.mjs` | every pair above threshold |
| Interface in a real browser, 520 conversations in 24 projects | `node tools/ui-check.mjs` | **32/32** |
| Admin panel in a real browser, same registry | `node tools/ui-admin-check.mjs` | **14/14**, zero errors on the page |
| Panel on the **live server** (read-only, no restart, live chat intact) | browser on `http://127.0.0.1:4310` | **8/8** |
| Panel on **real data** (copy of the real registry, 83 conversations, 9 projects) | same bench on a copy | **14/14** |
| OAuth + MCP round on the **live server**, with the tunnel's `Host` header | dedicated script, 17 checks | **17/17**, and revocation of both tokens |
| The phone path (Tailscale address, 390×844, websocket with and without token) | real browser | **9/9** |
| Secrets: the token is in no tracked file **and in 46 commits of history** | `git grep` + full history scan | clean |
| No state file, backup or `.env` has ever been committed | list of files never added | clean |

## 2. What is not verified (declared, not worked around)

- **Physical Android phone**: the path is proven from this machine at phone width, the device in
  hand is not. The checklist is in `docs/PHONE.md` (8 items, 5 minutes).
- **Real ChatGPT**: the OAuth + MCP round is proven on the live server, but **not** with a real
  ChatGPT client completing consent. Today it is **not reachable from outside**: `cloudflared` is
  not running (see §4).
- **`tailscale serve` and the restart from the panel**: they run on the machine of whoever launches
  the tests. The guards in front are tested (confirmation and origin), not the gesture.
- **"Cold" clone on another machine**: portability is verified by inspection, not by trying a
  zero-install on a system without this machine's history.

## 3. Before publishing: three decisions

1. **`HANDOFF.md`, `RAPPORTO.md`, `SPIEGAZIONE.md`** are the work diary in Italian, and they contain
   the public domain, the tailnet name and this machine's paths. Three paths, none wrong:
   - **keep them** (it is a personal project, and the diary is the most useful part of the
     documentation);
   - **clean them** (replace `mcp.<domain>` and `<machine>.<tailnet>.ts.net` with placeholders);
   - **remove them from the repo** (`git rm --cached` + `.gitignore`) — they remain in history, so
     this path only makes sense if you do not care about history.
   > If one day the repo becomes public and those values must not be public, history has to be
   > rewritten (`git filter-repo`): deciding **now** costs zero, later it costs a force-push.
2. **The name and the licence.** `LICENSE` is MIT assigned to a person: it is the normal choice. In
   `package.json` the `author` is empty, `keywords` is empty and `private: true`. `private: true` is
   fine as it is (it prevents an accidental `npm publish`); the rest is cosmetics to fill in.
3. **The repository name.** `wra` describes the product. The old `claude-remote` is another
   project and stays where it is. (The checkout folder on this machine is still `cc-remote`.)

## 4. What to do **before** the first push

```powershell
cd $HOME\Desktop\Projects\cc-remote

node --test                        # 466/466
npm audit                          # 0
node tools/check-contrast.mjs      # every pair passes

# the real-browser test: every bench builds its own registry and takes it away
node tools/ui-check.mjs            # 35/35
node tools/ui-admin-check.mjs      # 14/14
node tools/bench-rounds.mjs 10     # ten rounds in a row, identical
node tools/ui-perf.mjs --sizes 1000  # the big round, timed

# what the repo must NOT contain
git status --short                 # only intended files
git ls-files | Select-String -Pattern 'token|\.env|backup|sessions\.json' # expected: nothing
node -e "console.log(require('fs').readFileSync('README.md','utf8').length)"  # the README is there and is the right one
```

The person's token, the registries and the copies live **outside** the repo (`~/.cc-remote`), and
have never been committed: the proof is in the table of §1.

## 5. Publishing (when you decide — it has not been done today)

```powershell
# 1. empty repo on GitHub, **private** for the first round
git remote add origin git@github.com:<user>/wra.git
git branch -M main
git push -u origin main

# 2. look at the repo from outside: README, licence, screenshots, and that the state files are not there
# 3. only then: Settings → Change visibility → Public
```

The `.github/workflows/ci.yml` workflow runs on **Windows and Ubuntu**: `npm ci`, `node --test`,
contrast, `npm audit` (informational) and two CLI commands. On the first push you see whether it
holds on a machine that is not this one.

## 6. What remains to be configured by hand (outside the repo)

| What | Why it is needed | Command |
|---|---|---|
| **`cloudflared`** | to make `mcp.<domain>` reach port 4310: today the tunnel is **down**, and the public address answers `530`. The Access rules are already right (`/.well-known/*`, `/mcp`, `/register` in bypass; everything else behind Access) — the proof is that those paths answer `530` and not `302` | `cloudflared --config "$HOME\.cloudflared\config.yml" tunnel run` |
| **Phone** | try the PWA on Android | `docs/PHONE.md` |
| **ChatGPT** | after the tunnel: *Settings → Connectors → Add* with `https://mcp.<domain>/mcp` | `docs/CHATGPT.md` |
| **Windows autostart** | the server does not start by itself at login: it is a documented choice, not an oversight | `docs/WINDOWS.md` |

None of these touches the token, DNS, or the active Cloudflare/Tailscale configuration.

## 7. Dismissing the old `claude-remote`

**Not yet.** The conditions, in order, are in `docs/MIGRATION.md`. As of 02/11 these are missing:
the real phone, the real ChatGPT connection, and the import of the historical conversations (13
real ones with a title, plus 59 tests or untitled ones to look at — list ready, see the final
section of `HANDOFF.md`). While they are missing, the old one stays where it is and `rc-old.cmd`
keeps working: it costs one command, not a risk.