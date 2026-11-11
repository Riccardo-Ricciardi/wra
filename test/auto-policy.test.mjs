import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAutoPolicy, decideAutoApproval } from '../src/host/auto-policy.mjs';

// Il criterio dell'«MCP automatico controllato». Il caso che conta più di tutti non è quello che
// concede: è quello che **non** concede. Un permesso dato da soli quando non si poteva verificare
// è il modo in cui un confine diventa un ricordo.

const tempRoot = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cc-remote-auto-${name}-`));

const session = (projectPath, extra = {}) => ({
  sessionId: 's1', projectPath, permissionMode: 'default', archived: false, autoApprove: true, ...extra,
});

const edit = (file) => ({ toolName: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } });

test('spento di partenza: senza interruttore non si concede niente', () => {
  const project = tempRoot('off');
  try {
    assert.equal(decideAutoApproval({ session: session(project, { autoApprove: null }), toolName: 'Edit', input: { file_path: path.join(project, 'a.js') } }), null);
    assert.equal(decideAutoApproval({ session: session(project, { autoApprove: false }), projectAuto: true, toolName: 'Edit', input: { file_path: path.join(project, 'a.js') } }), null, 'la conversazione che dice «spento» vince sul progetto');
    assert.equal(decideAutoApproval({ session: null, toolName: 'Edit', input: {} }), null);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('il progetto accende le conversazioni che non hanno scelto per sé', () => {
  const project = tempRoot('inherit');
  try {
    const inherited = decideAutoApproval({ session: session(project, { autoApprove: null }), projectAuto: true, ...edit(path.join(project, 'src', 'a.js')) });
    assert.equal(inherited?.behavior, 'allow');
    assert.match(inherited.reason, /inside the project/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('dentro il progetto si concede: il percorso si verifica, non si indovina', () => {
  const project = tempRoot('inside');
  try {
    const s = session(project);
    assert.equal(decideAutoApproval({ session: s, ...edit(path.join(project, 'src', 'a.js')) })?.behavior, 'allow');
    assert.equal(decideAutoApproval({ session: s, toolName: 'Write', input: { file_path: path.join(project, 'nuovo.js') } })?.behavior, 'allow', 'anche un file che non esiste ancora');
    assert.equal(decideAutoApproval({ session: s, toolName: 'Read', input: { file_path: path.join(project, 'README.md') } })?.behavior, 'allow');
    assert.equal(decideAutoApproval({ session: s, toolName: 'NotebookEdit', input: { notebook_path: path.join(project, 'n.ipynb') } })?.behavior, 'allow');
    // Un percorso relativo si legge rispetto al progetto della conversazione, non a dove gira il
    // server: sono due cartelle diverse.
    assert.equal(decideAutoApproval({ session: s, ...edit('src/relativo.js') })?.behavior, 'allow');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('fuori dal progetto non si concede: si chiede', () => {
  const project = tempRoot('outside');
  const elsewhere = tempRoot('elsewhere');
  try {
    const s = session(project);
    for (const target of [
      path.join(elsewhere, 'a.js'),
      path.join(project, '..', 'vicino.js'),
      path.join(project, '..', path.basename(project) + '-2', 'inganno.js'), // il prefisso non basta
      '/etc/passwd',
      '~/.ssh/id_rsa',
      path.join(project, '..', '..', '..', 'qualsiasi.js'),
    ]) {
      assert.equal(decideAutoApproval({ session: s, ...edit(target) }), null, `${target} non è dentro il progetto`);
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('i comandi non si concedono mai: il testo di un comando non è un confine', () => {
  const project = tempRoot('bash');
  try {
    const s = session(project);
    for (const command of [
      'npm test',
      'ls',
      `cat ${path.join(project, 'README.md')}`,
      'git status',
      'node --version',
    ]) {
      assert.equal(decideAutoApproval({ session: s, toolName: 'Bash', input: { command } }), null, `«${command}» chiede sempre`);
    }
    // Nemmeno gli strumenti che prendono un *pattern* invece di un percorso: `..` e i percorsi
    // assoluti si scrivono nel pattern, e un pattern si legge, non si verifica.
    assert.equal(decideAutoApproval({ session: s, toolName: 'Glob', input: { pattern: '**/*.js', path: project } }), null);
    assert.equal(decideAutoApproval({ session: s, toolName: 'Grep', input: { pattern: 'secret' } }), null);
    // E gli strumenti che escono dalla macchina.
    assert.equal(decideAutoApproval({ session: s, toolName: 'WebFetch', input: { url: 'https://esempio.test' } }), null);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('dentro il progetto, ma credenziali e configurazione di sicurezza: si chiede', () => {
  const project = tempRoot('reserved');
  try {
    const s = session(project);
    const denied = [
      '.env', '.env.local', '.npmrc', '.netrc', '.mcp.json',
      'id_rsa', 'chiave.pem', 'certificato.key', 'credentials.json',
      '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/pre.sh',
      '.git/config', '.git/hooks/pre-commit',
      '.ssh/config', '.aws/credentials',
      // anche scritti con la barra dell'altro sistema, e in maiuscolo
      '.CLAUDE/settings.json', '.Env',
    ];
    for (const relative of denied) {
      const target = path.join(project, ...relative.split('/'));
      assert.equal(decideAutoApproval({ session: s, ...edit(target) }), null, `${relative} chiede sempre`);
      assert.equal(decideAutoApproval({ session: s, toolName: 'Write', input: { file_path: target } }), null);
    }
    // Il controllo vale anche in mezzo al percorso, non solo sull'ultimo pezzo.
    assert.equal(decideAutoApproval({ session: s, ...edit(path.join(project, 'sub', '.git', 'config')) }), null);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('un collegamento dentro il progetto non allarga il confine', () => {
  const project = tempRoot('link');
  const outside = tempRoot('link-out');
  try {
    const link = path.join(project, 'scorciatoia');
    fs.symlinkSync(outside, link, 'junction');
    const s = session(project);
    // Il percorso **si presenta** come dentro il progetto: è tutto il trucco.
    assert.equal(decideAutoApproval({ session: s, ...edit(path.join(link, 'a.js')) }), null, 'passando da un collegamento non si concede');
    assert.equal(decideAutoApproval({ session: s, toolName: 'Write', input: { file_path: path.join(link, 'x.js') } }), null);
    // E il collegamento stesso, nemmeno a nominarlo.
    assert.equal(decideAutoApproval({ session: s, ...edit(link) }), null);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('bypass e archiviate: il criterio si spegne, non si finge', () => {
  const project = tempRoot('bypass');
  try {
    const file = path.join(project, 'a.js');
    // In bypass l'hook non viene nemmeno eseguito: un «sì» da qui sarebbe la risposta a una
    // domanda che nessuno ha fatto, e la persona crederebbe di avere un confine.
    assert.equal(decideAutoApproval({ session: session(project, { permissionMode: 'bypassPermissions' }), ...edit(file) }), null);
    assert.equal(decideAutoApproval({ session: session(project, { archived: true }), ...edit(file) }), null);
    // Campi mancanti o di tipo sbagliato: si chiede.
    const plain = session(project);
    assert.equal(decideAutoApproval({ session: plain, toolName: 'Edit', input: {} }), null);
    assert.equal(decideAutoApproval({ session: plain, toolName: 'Edit', input: { file_path: '' } }), null);
    assert.equal(decideAutoApproval({ session: plain, toolName: 'Edit', input: { file_path: 42 } }), null);
    assert.equal(decideAutoApproval({ session: plain, toolName: 'Edit' }), null);
    assert.equal(decideAutoApproval({ session: session(''), ...edit(file) }), null);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('la revoca vale dalla richiesta successiva: lo stato si rilegge ogni volta', () => {
  const project = tempRoot('revoke');
  try {
    const entry = { sessionId: 's1', projectPath: project, permissionMode: 'default', archived: false, autoApprove: true };
    const projectEntry = { autoApprove: false };
    const policy = createAutoPolicy({
      sessionFor: () => entry,
      projectFor: () => projectEntry,
    });
    const request = { sessionId: 's1', toolName: 'Edit', input: { file_path: path.join(project, 'a.js') } };

    assert.equal(policy(request)?.behavior, 'allow', 'acceso: si concede');

    // Spegnere l'interruttore (dalla dashboard) non deve richiedere un riavvio: il criterio legge
    // lo stato **adesso**, e la richiesta dopo si comporta di conseguenza.
    entry.autoApprove = false;
    assert.equal(policy(request), null, 'spento: si chiede');

    entry.autoApprove = null;
    projectEntry.autoApprove = true;
    assert.equal(policy(request)?.behavior, 'allow', 'vale quello del progetto');

    projectEntry.autoApprove = false;
    assert.equal(policy(request), null, 'spento il progetto: si chiede di nuovo');

    // E una conversazione che sparisce non lascia un criterio acceso su nessuno.
    assert.equal(createAutoPolicy({ sessionFor: () => null })(request), null);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('un nome che il filesystem legge diversamente da come è scritto non passa', () => {
  // Su Windows `percorso::$DATA` è il contenuto **principale** del file (verificato: scrivendo
  // `.env::$DATA` il testo finisce dentro `.env`) e `file:stream` è uno stream dentro lo stesso
  // file. Il controllo si fa sul nome: senza ridurre il nome a quello vero, un nome che non
  // somiglia a niente passerebbe — ed è esattamente la strada per scrivere `.env` senza chiedere.
  const project = tempRoot('nomi');
  try {
    const s = session(project);
    for (const relative of [
      '.env::$DATA', '.env:stream', 'id_rsa::$DATA', 'credenziali.key::$DATA',
      '.claude::$DATA', '.claude/settings.json::$DATA',
      // Punti e spazi finali: con `fs` sono file diversi, ma altri strumenti li normalizzano.
      '.env ', '.env.', '.claude ', '.claude.', '.git.',
      // Alias corti 8.3: `cmd /c dir /x` mostra `ENV~1` accanto a `.env`, e scrivere `ENV~1`
      // finisce dentro `.env` — verificato. L'alias non si risolve: si chiede.
      'ENV~1', 'ID_RSA~1', 'CLAUDE~1', 'CREDEN~1.JSO', 'src/ENV~1', 'ENV~1/x.js', '.claude/GIT~1',
    ]) {
      const target = path.join(project, ...relative.split('/'));
      assert.equal(decideAutoApproval({ session: s, toolName: 'Write', input: { file_path: target } }), null, `${relative} deve chiedere`);
    }
    // E i file normali continuano a passare: il controllo non è diventato «chiedi sempre».
    assert.equal(decideAutoApproval({ session: s, toolName: 'Write', input: { file_path: path.join(project, 'src', 'a.js') } })?.behavior, 'allow');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
