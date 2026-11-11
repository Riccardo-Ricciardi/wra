#!/usr/bin/env node
// `wra web` — opens the interface in the browser.
import { execFile } from 'node:child_process';
import { baseUrl } from './api.mjs';

// `cmd` does not take an argument list: it takes a **line** to interpret, and inside a line
// `&`, `|` and `^` are commands. The address comes from `CR_HOST`/`CR_PORT` — that is, from an
// environment variable — so only what an address can be is passed here: if it is not one, nothing
// is opened and the address to open by hand is printed. This applies only on Windows, the only one
// of the three where the launched program is a shell.
const url = baseUrl();
const apribile = /^https?:\/\/[A-Za-z0-9.\-]+(:\d{1,5})?(\/[^\s"&|^<>]*)?$/.test(url);
const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
if (process.platform === 'win32' && !apribile) {
  console.log(`open it yourself: ${url}`);
  process.exit(0);
}
// `windowsHide`: without it, `cmd /c start` gets a **new** console allocated when the one that
// launches it has none (Claude Code, a script, a service) — and that console is a black window that
// flashes on the screen before the browser opens. The browser opens anyway.
execFile(command, args, { windowsHide: true }, (error) => {
  if (error) console.log(`open it yourself: ${url}`);
  else console.log(`opened: ${url}`);
});
