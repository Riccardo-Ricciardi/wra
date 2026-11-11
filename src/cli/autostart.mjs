// `wra autostart` — WRA (and the tunnel) start on their own at session start, without windows
// and without asking for the administrator password.
//
// It is a command and not an instruction page because an instruction page is followed once and
// grows old: the repository path changes, the `.cmd` written there moves, and the shortcut stays
// pointing at nothing. This one is re-run and puts itself back in place; `remove` takes it out,
// and touches nothing else.
//
// It installs **nothing** outside two places, and knows both by name:
//   * `~/.cc-remote/autostart/*.vbs` — the launchers;
//   * the shortcut in the user's Startup folder.
// No registry keys, no service, no privileges.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRY_IDS, autostartDir, autostartPlan, shortcutCommand, startupFolder } from '../core/autostart.mjs';

const cli = fileURLToPath(new URL('./index.mjs', import.meta.url));
const cwd = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const argomenti = process.argv.slice(2);
const azione = argomenti[0] ?? 'stato';
const valoreDi = (nome) => {
  const at = argomenti.indexOf(`--${nome}`);
  return at === -1 ? null : argomenti[at + 1] ?? '';
};

const wscript = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');

function doveE(command) {
  try {
    const out = execFileSync('where', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.split(/\r?\n/).map((r) => r.trim()).filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

function esiste(percorso) {
  try {
    fs.accessSync(percorso);
    return true;
  } catch {
    return false;
  }
}

/** The plan of files to write, or an error that says **what** is missing to be able to do it. */
function piano() {
  if (process.platform !== 'win32') {
    return { error: 'autostart for this command is for Windows: elsewhere use systemd or launchd.' };
  }
  if (!esiste(wscript)) {
    return { error: `missing ${wscript}: without \`wscript\` an autostart would show a black window on every session.` };
  }
  const tunnel = valoreDi('tunnel');
  const cloudflared = valoreDi('cloudflared') ?? doveE('cloudflared');
  if (tunnel && !cloudflared) {
    return { error: 'the tunnel needs `cloudflared`: put it on PATH, or say where it is with `--cloudflared <path>`.' };
  }
  if (tunnel && !esiste(tunnelConfigDir() ?? '')) {
    return { error: `the tunnel "${tunnel}" needs its configuration in ${tunnelConfigDir()} — I will not invent a tunnel that is not there.` };
  }
  return {
    tunnel,
    cloudflared,
    voci: autostartPlan({
      home: os.homedir(),
      appData: process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      node: process.execPath,
      cli,
      cwd,
      tunnel,
      cloudflared,
    }),
  };
}

const tunnelConfigDir = () => path.join(os.homedir(), '.cloudflared');

/**
 * The shortcut is created with PowerShell, the only way to write a `.lnk` without dependencies.
 * The command comes from `core/autostart.mjs` in base64: `cmd`'s command line and PowerShell's
 * eat quotes in two different ways, and a path with a space inside is the norm
 * ("C:\Program Files\…"), not the exception.
 */
function creaCollegamento({ shortcut, target, args, description }) {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', shortcutCommand({ shortcut, target, args, cwd, description })], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf8',
  });
}

function stato() {
  // The state is read from the **file names**, not from the plan of the moment — as for `remove`,
  // and for the same reason: the plan only knows what it was asked to install. Asked without
  // `--tunnel` it does not contain the tunnel, and the command answered "the tunnel is not
  // installed" while its shortcut was there, in Startup. A status command that says something
  // false is worse than a status command that is missing.
  const dir = autostartDir(os.homedir());
  const avvio = startupFolder(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'));
  const cosa = { [ENTRY_IDS.server]: 'the server', [ENTRY_IDS.tunnel]: 'the Cloudflare tunnel' };

  let mancante = false;
  const righe = Object.entries(ENTRY_IDS).map(([, nome]) => {
    const collegamento = path.join(avvio, `${nome}.lnk`);
    const lanciatore = path.join(dir, `${nome}.vbs`);
    const haCollegamento = esiste(collegamento);
    const haLanciatore = esiste(lanciatore);
    if (!haCollegamento || !haLanciatore) mancante = true;
    const statoVoce = haCollegamento && haLanciatore ? 'installed' : haCollegamento || haLanciatore ? 'half' : 'absent';
    return `  ${nome.padEnd(18)} ${statoVoce.padEnd(11)} ${haCollegamento ? `${collegamento}  (${cosa[nome]})` : '(no shortcut)'}`;
  });

  console.log(`autostart at every session (${dir}):`);
  console.log(righe.join('\n'));
  if (!esiste(path.join(dir, `${ENTRY_IDS.tunnel}.vbs`))) {
    console.log('  (the tunnel is not installed: `wra autostart install --tunnel <name>`)');
  }
  if (mancante) console.log('\nFix it with: wra autostart install');
  return 0;
}

function installa() {
  const p = piano();
  if (p.error) {
    console.error(`I am not installing anything: ${p.error}`);
    return 1;
  }
  fs.mkdirSync(autostartDir(os.homedir()), { recursive: true });
  for (const voce of p.voci) {
    fs.writeFileSync(voce.script, voce.content, 'utf8');
    creaCollegamento({
      shortcut: voce.shortcut,
      target: wscript,
      args: `"${voce.script}"`,
      cwd,
      description: `WRA — ${voce.label}, without windows`,
    });
    console.log(`  ${voce.label}: ${voce.shortcut}`);
  }
  console.log('\nThey start at the next logon. To try them now, without restarting the session:');
  console.log(`  wscript.exe "${p.voci[0].script}"`);
  console.log('They are removed with: wra autostart remove');
  return 0;
}

/**
 * Removes **all** the entries this command knows how to write, not only those in the current plan.
 *
 * The defect this line closes: the first version removed what `piano()` had just listed, and
 * without `--tunnel` the plan contains only the server — so the tunnel installed yesterday stayed
 * there, with its shortcut, and "remove" said it had removed everything. The file names are fixed,
 * so there is nothing to guess: both are always looked at.
 */
function rimuovi() {
  const dir = autostartDir(os.homedir());
  const avvio = startupFolder(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'));
  const percorsi = Object.values(ENTRY_IDS)
    .flatMap((id) => [path.join(avvio, `${id}.lnk`), path.join(dir, `${id}.vbs`)]);

  let tolti = 0;
  for (const percorso of percorsi) {
    if (!esiste(percorso)) continue;
    // Only inside the two places this command knows: a `remove` that deletes a path from outside
    // is the way to lose something that was not its own.
    const ammesso = percorso.startsWith(dir) || percorso.startsWith(avvio);
    if (!ammesso) continue;
    fs.rmSync(percorso, { force: true });
    console.log(`  removed: ${percorso}`);
    tolti += 1;
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // not empty or already gone: fine either way
  }
  console.log(tolti ? `\nremoved ${tolti} files: nothing starts at logon anymore.` : 'there was nothing to remove.');
  return 0;
}

if (azione === 'install' || azione === 'installa') process.exit(installa());
else if (azione === 'remove' || azione === 'rimuovi') process.exit(rimuovi());
else if (azione === 'stato' || azione === 'status') process.exit(stato());
else {
  console.error(`wra autostart: I do not know "${azione}". Use: (empty) | install [--tunnel <name>] | remove`);
  process.exit(1);
}