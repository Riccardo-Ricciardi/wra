import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { autostartDir, autostartPlan, launcherScript, shortcutCommand, startupFolder } from '../src/core/autostart.mjs';

// L'avvio automatico è la cosa che si prova una volta e non si guarda più: se il lanciatore è
// sbagliato nessuno se ne accorge finché non si riavvia la sessione, e allora sembra che
// «cc-remote non parte da solo» — che è un sintomo, non una causa. Qui si prova la **riga** che
// finisce nel `.vbs`, che è dove stava il difetto.

const WINDOWS = { home: 'C:\\Users\\tizio', appData: 'C:\\Users\\tizio\\AppData\\Roaming' };

test('il lanciatore virgoletta **dentro** la riga, non solo attorno al pezzo di VBScript', () => {
  const script = launcherScript({
    exe: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Users\\tizio\\cc-remote\\src\\cli\\index.mjs', 'start'],
    cwd: 'C:\\Users\\tizio\\cc-remote',
    what: 'prova',
  });
  // Questo è il difetto trovato: senza le virgolette interne, `Run` prova a eseguire `C:\Program`.
  assert.ok(script.includes('"""C:\\Program Files\\nodejs\\node.exe"""'),
    'il percorso dell\'eseguibile deve arrivare virgolettato dentro la riga che `Run` riceve');
  assert.ok(script.includes('"""C:\\Users\\tizio\\cc-remote\\src\\cli\\index.mjs"""'));
  assert.ok(script.includes('"""start"""'));
  assert.ok(script.includes(', 0, False'), 'la finestra deve essere 0 — nascosta');
  assert.ok(!script.includes(', 1,'), 'la finestra 1 è quella visibile: è il difetto da non rimettere');
});

test('una virgoletta dentro un percorso non rompe lo script', () => {
  const script = launcherScript({ exe: 'C:\\a"b\\node.exe', args: ['x'], what: 'prova' });
  // Dentro una stringa VBScript la virgoletta si raddoppia: `""` è una virgoletta, non la fine
  // della stringa. Senza, il percorso `C:\a"b\node.exe` chiuderebbe la stringa a metà e il
  // lanciatore non partirebbe — e non partirebbe **in silenzio**, che è il modo peggiore.
  const riga = script.split('\r\n').find((line) => line.startsWith('shell.Run'));
  assert.ok(riga.includes('"""C:\\a""b\\node.exe"""'), `la virgoletta non è raddoppiata: ${riga}`);
});

test('senza `cwd` il lanciatore non scrive una riga vuota', () => {
  const script = launcherScript({ exe: 'node.exe', args: ['x'], what: 'prova' });
  assert.ok(!script.includes('CurrentDirectory'), 'una `CurrentDirectory` vuota è una cartella che non esiste');
});

test('le due voci: il server sempre, il tunnel solo se lo si chiede', () => {
  const soloServer = autostartPlan({ ...WINDOWS, node: 'node.exe', cli: 'C:\\r\\cli.mjs' });
  assert.equal(soloServer.length, 1);
  assert.equal(soloServer[0].id, 'cc-remote');

  const conTunnel = autostartPlan({
    ...WINDOWS, node: 'node.exe', cli: 'C:\\r\\cli.mjs', tunnel: 'mio-tunnel', cloudflared: 'C:\\cf\\cloudflared.exe',
  });
  assert.equal(conTunnel.length, 2);
  assert.equal(conTunnel[1].id, 'cc-remote-tunnel');
  assert.ok(conTunnel[1].content.includes('"""C:\\cf\\cloudflared.exe"""'));
  assert.ok(conTunnel[1].content.includes('"""tunnel"""') && conTunnel[1].content.includes('"""mio-tunnel"""'));
});

test('i due posti che il comando tocca sono noti e sono suoi', () => {
  assert.equal(autostartDir('C:\\Users\\tizio'), path.join('C:\\Users\\tizio', '.cc-remote', 'autostart'));
  assert.ok(startupFolder('C:\\Users\\tizio\\AppData\\Roaming').startsWith('C:\\Users\\tizio\\AppData\\Roaming'));
  assert.ok(startupFolder('C:\\Users\\tizio\\AppData\\Roaming').endsWith('Startup'));

  const [voce] = autostartPlan({ ...WINDOWS, node: 'node.exe', cli: 'C:\\r\\cli.mjs' });
  assert.ok(voce.shortcut.startsWith(WINDOWS.appData), 'il collegamento sta nell\'Esecuzione automatica dell\'utente');
  assert.ok(voce.shortcut.endsWith('.lnk'));
  assert.ok(voce.script.startsWith(autostartDir(WINDOWS.home)));
});

test('il comando del collegamento è PowerShell vero, e con l\'apice raddoppiato', () => {
  const encoded = shortcutCommand({
    shortcut: "C:\\Users\\tizio\\Startup\\cc-remote.lnk",
    target: 'C:\\Windows\\System32\\wscript.exe',
    args: '"C:\\Users\\tizio\\.cc-remote\\autostart\\cc-remote.vbs"',
    cwd: "C:\\l'utente\\cc-remote",
    description: "cc-remote — l'utente",
  });
  const ps = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(ps.includes('CreateShortcut'), 'deve creare un collegamento');
  assert.ok(ps.includes("'C:\\l''utente\\cc-remote'"), `l'apice non è raddoppiato:\n${ps}`);
  assert.ok(ps.includes("l''utente") && ps.includes('WindowStyle'), 'la finestra va chiesta ridotta');
  assert.ok(ps.includes('$s.Save()'));
  // Si decodifica in UTF-16LE: `-EncodedCommand` non accetta altro.
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8').includes('CreateShortcut'), false,
    'in UTF-8 non si legge: vuol dire che l\'encoding è quello sbagliato');
});
