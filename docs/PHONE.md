# Browser and phone

The browser path is the private one: it goes through your tailnet, never through a public endpoint.
Nothing administrative is exposed, and the terminal is only reachable with the token.

## Setup (once)

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4310
tailscale serve status          # https://<machine>.<tailnet>.ts.net (tailnet only)
```

Then tell the server which origin to expect — without it the websocket is refused (403) and the
page looks broken while it is only muted:

```powershell
# in claude-aliases.ps1, so every shell has it
$env:CR_PUBLIC_ORIGIN = 'https://<machine>.<tailnet>.ts.net'
```

`CR_PUBLIC_ORIGIN` is the browser's origin check. It takes **one or more** addresses separated by
`;` (or spaces) — declare every address you open the interface from, the tailnet one and a public
one together if you use both. An origin that is not in the list is refused on the websocket upgrade
(403): the page opens and stays silent, which looks like a broken server.

**Tailscale Funnel is not used, and should not be**: it would put the interface on the public
internet, where the token is the only lock.

## Opening it on the phone

1. Install Tailscale on the phone and sign in to the **same account**. `tailscale status` on the PC
   lists the devices; a phone that has been offline for weeks needs to reconnect first.
2. On the PC, read the token: `Get-Content $HOME\.cc-remote\token`.
3. On the phone open `https://<machine>.<tailnet>.ts.net/?token=<token>` — the page strips the token
   from the address bar immediately and remembers it. Or open the bare URL and paste the token into
   the field.
4. Add it to the home screen: it installs as a PWA (its own icon, no browser chrome).

## Checklist for a real phone

Five minutes, and it covers everything that only a real device can tell:

- [ ] **Keyboard**: open a conversation, tap the composer. The keyboard opens and the field stays
      **above** it (it follows `visualViewport`). Type a message and send it.
- [ ] **Conversations**: open the drawer (☰), switch conversation, come back. The chat is where you
      left it.
- [ ] **Approvals**: ask the agent for something that needs a permission (`run the command:
      curl -sS https://example.com`). The card appears above the composer with the command; tap
      *allow once* and the agent continues.
- [ ] **Terminal**: the Terminal tab shows the real TUI; type in it. Going back to Chat does not lose
      anything.
- [ ] **Locked screen**: lock the phone for a minute, unlock, come back to the tab. The banner should
      say it is reconnecting, and then reconnect on its own.
- [ ] **No network**: turn off Wi-Fi and mobile data. A red banner says there is no network and
      offers *retry*. Turn the network back on: it reconnects by itself.
- [ ] **Installation**: the browser offers "Add to home screen"; opening from the icon gives a
      full-screen app, not a browser tab.
- [ ] **Theme**: the interface follows the phone's light/dark setting; the toggle in the drawer
      forces the other one.

If something fails, `wra doctor` on the PC says whether it is the server or the phone.

## What is *not* verified yet

The keyboard, the PWA installation and the reconnection behaviour after a real screen lock have been
exercised by resizing the viewport and by toggling the network on the desktop — not on a physical
Android device. That is what the checklist above is for.