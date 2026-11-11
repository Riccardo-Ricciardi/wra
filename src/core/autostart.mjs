// L'avvio automatico su Windows: cosa scrivere, e dove. Puro — niente `fs`, niente processi —
// così si può provare in Node quello che altrimenti si prova riavviando la sessione.
//
// La forma è questa, e ogni pezzo risponde a un difetto visto:
//
//  * **un collegamento nella cartella Esecuzione automatica**, non un'attività pianificata:
//    creare un'attività richiede l'elevazione, e chiedere la password per accendere un server
//    locale è un prezzo che non si paga. Il collegamento lo scrive l'utente, per l'utente.
//  * **il collegamento lancia `wscript.exe`**, non `node.exe` e nemmeno un `.cmd`. Un `.cmd` si
//    fa allocare una console e la mostra; `node.exe` lanciato dal sistema operativo fa lo stesso.
//    `wscript` con lo stile di finestra `0` non ne mostra nessuna — ed è la ragione per cui c'è
//    un file `.vbs` in mezzo invece di un comando diretto.
//  * **un file per cosa**, non un file che fa tutto: il server e il tunnel si accendono e si
//    spengono separatamente, e se uno dei due non parte l'altro non c'entra.
import path from 'node:path';

/** Dove finiscono i lanciatori. Sotto lo stato di cc-remote, che è già suo. */
export const autostartDir = (home) => path.join(home, '.cc-remote', 'autostart');

/** La cartella Esecuzione automatica dell'utente: nessun privilegio per scriverci. */
export const startupFolder = (appData) => path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

/** Il nome del collegamento, e quello del lanciatore, per ognuna delle due cose. */
export const ENTRY_IDS = { server: 'cc-remote', tunnel: 'cc-remote-tunnel' };

/**
 * Una stringa dentro una stringa VBScript: le virgolette si raddoppiano.
 * (`"` diventa `""` — non c'è un altro modo, e sbagliarlo produce uno script che non parte.)
 */
const vbsString = (value) => `"${String(value).replace(/"/g, '""')}"`;

/**
 * Il lanciatore: un file `.vbs` che esegue **una** cosa, con la finestra a zero.
 *
 * `CurrentDirectory` si fissa perché `cloudflared` legge la sua configurazione dalla cartella
 * dell'utente ma i percorsi relativi li risolve da dove lo si lancia: senza, un tunnel che
 * funziona a mano non funziona all'avvio, ed è il genere di differenza che si scopre tardi.
 *
 * @param {{ exe: string, args?: string[], cwd?: string, what: string }} input
 */
export function launcherScript({ exe, args = [], cwd = null, what }) {
  // Le virgolette servono **dentro** la riga che `Run` riceve, non solo attorno al pezzo di
  // VBScript: `"C:\Program Files\nodejs\node.exe"` concatenato così com'è diventa un percorso
  // senza virgolette, e Windows prova a eseguire `C:\Program`. Ogni pezzo è quindi una stringa
  // VBScript il cui *valore* è un pezzo già virgolettato.
  const virgolettato = (value) => vbsString(`"${value}"`);
  const riga = [exe, ...args].map(virgolettato).join(' & " " & ');
  return [
    `' WRA — ${what}.`,
    "' Written by `wra autostart`: re-run the same command to refresh it, `wra autostart remove` to delete it.",
    "' La finestra è 0 — nessuna console, nemmeno per un istante.",
    'Set shell = CreateObject("WScript.Shell")',
    cwd ? `shell.CurrentDirectory = ${vbsString(cwd)}` : null,
    `shell.Run ${riga}, 0, False`,
    '',
  ].filter((line) => line !== null).join('\r\n');
}

/**
 * Cosa scrivere e dove, per intero. Chi chiama la esegue: qui c'è solo la decisione.
 *
 * @param {object} input
 * @param {string} input.home          la cartella dell'utente
 * @param {string} input.appData       `%APPDATA%`
 * @param {string} input.node          il percorso di `node.exe`
 * @param {string} input.cli           il percorso di `src/cli/index.mjs`
 * @param {string} [input.cwd]         da dove far partire i comandi
 * @param {string} [input.tunnel]      il nome del tunnel Cloudflare, se lo si vuole
 * @param {string} [input.cloudflared] il percorso di `cloudflared.exe`
 * @returns {Array<{id: string, label: string, shortcut: string, script: string, content: string}>}
 */
export function autostartPlan({ home, appData, node, cli, cwd = null, tunnel = null, cloudflared = null }) {
  const dir = autostartDir(home);
  const startup = startupFolder(appData);
  const voci = [{
    id: ENTRY_IDS.server,
    label: 'the server',
    shortcut: path.join(startup, `${ENTRY_IDS.server}.lnk`),
    script: path.join(dir, `${ENTRY_IDS.server}.vbs`),
    content: launcherScript({
      exe: node,
      args: [cli, 'start'],
      cwd,
      what: 'starts the server at session start',
    }),
  }];

  if (tunnel) {
    voci.push({
      id: ENTRY_IDS.tunnel,
      label: `the Cloudflare tunnel "${tunnel}"`,
      shortcut: path.join(startup, `${ENTRY_IDS.tunnel}.lnk`),
      script: path.join(dir, `${ENTRY_IDS.tunnel}.vbs`),
      content: launcherScript({
        exe: cloudflared,
        args: ['tunnel', 'run', tunnel],
        cwd,
        what: `keeps the Cloudflare tunnel "${tunnel}" up`,
      }),
    });
  }

  return voci;
}

/**
 * Lo script PowerShell che crea un collegamento. Si passa con `-EncodedCommand`, perché la riga
 * di comando di `cmd` e quella di PowerShell hanno due modi diversi di mangiarsi le virgolette, e
 * un percorso con uno spazio — «C:\Program Files\…» — è la norma, non l'eccezione.
 */
export function shortcutCommand({ shortcut, target, args, cwd = null, description }) {
  const ps = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psString(shortcut)})`,
    `$s.TargetPath = ${psString(target)}`,
    `$s.Arguments = ${psString(args)}`,
    cwd ? `$s.WorkingDirectory = ${psString(cwd)}` : null,
    `$s.Description = ${psString(description)}`,
    // 7 = ridotta a icona. Con `wscript` non si vede comunque niente: è una cintura in più, e
    // costa una riga.
    '$s.WindowStyle = 7',
    '$s.Save()',
    'Write-Output "ok"',
  ].filter(Boolean).join('; ');
  return Buffer.from(ps, 'utf16le').toString('base64');
}

/** Una stringa dentro una stringa PowerShell fra apici singoli: l'apice si raddoppia. */
const psString = (value) => `'${String(value).replace(/'/g, "''")}'`;
