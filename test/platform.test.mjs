import assert from 'node:assert/strict';

import path from 'node:path';
import test from 'node:test';
import pty from 'node-pty';

// Il resize del PTY è l'assunzione su cui poggia tutta la politica della larghezza (chi scrive
// impone la misura). Va verificato una volta, sulla piattaforma, con un figlio che *chiede* la
// misura invece di fidarsi della propria cache.
//
// Perché serve: su Windows un figlio Node non vede il resize — `process.stdout.columns` e
// `process.stdout.getWindowSize()` restano quelli dell'avvio, anche se il PTY è cambiato (Node
// cachea la dimensione del tty). Un processo .NET invece la vede subito, quindi è quello che si
// usa qui: se questo passa, il resize è vero e la cache di Node è solo un dettaglio del figlio.
const CHILD = 'while($true){ Write-Host ("W=" + [Console]::WindowWidth); Start-Sleep -Milliseconds 500 }';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('il resize di node-pty arriva al figlio (ConPTY)', { timeout: 30_000 }, async () => {
  if (process.platform !== 'win32') return; // altrove il resize passa per SIGWINCH

  const shell = process.platform === 'win32' ? 'powershell.exe' : 'sh';
  const args = process.platform === 'win32' ? ['-NoProfile', '-Command', CHILD] : ['-c', 'true'];
  const child = pty.spawn(shell, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: path.dirname(import.meta.dirname) });

  let out = '';
  child.onData((data) => {
    out += data;
  });

  try {
    await sleep(2_500);
    assert.match(out, /W=100/, `prima del resize il figlio deve vedere 100 colonne: ${out.slice(-120)}`);

    child.resize(120, 40);
    await sleep(2_500);
    const widths = out.match(/W=(\d+)/g) ?? [];
    assert.equal(widths.at(-1), 'W=120', `dopo il resize il figlio deve vedere 120: ${widths.slice(-4).join(' ')}`);
  } finally {
    child.kill();
  }
});