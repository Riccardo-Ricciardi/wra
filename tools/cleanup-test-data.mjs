// Trova e (su richiesta) rimuove i metadati di progetto che i test hanno lasciato nel profilo
// vero, senza toccare conversazioni, transcript né configurazione.
//
// La regola non è il nome: è una combinazione che esiste **solo** nel codice dei test.
//   S1  il percorso sta sotto la cartella temporanea del sistema
//   S2  un segmento del percorso comincia con `cc-remote-e2e-` (test/e2e.stub.test.mjs)
//   S3  il basename è `progetto-auto-2` (test/e2e.stub.test.mjs)
//   S4  nessuna sessione del registro punta a quel percorso
// Se una sola manca, la voce non si tocca e finisce fra quelle da approvare.
//
// Uso:
//   node tools/cleanup-test-data.mjs            elenca, non tocca niente
//   node tools/cleanup-test-data.mjs --apply    rimuove via API del server acceso
//
// `--apply` passa dal server, non dai file: il server tiene il registro in memoria, e scrivere
// `projects.json` da fuori verrebbe sovrascritto al primo salvataggio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TEST_PREFIX = 'cc-remote-e2e-';
export const TEST_BASENAME = 'progetto-auto-2';

const norm = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * I segnali che mancano perché una voce sia "sicuramente di test". Vuota = tutti presenti.
 *
 * @param {string} rawPath
 * @param {Set<string>} sessionPaths percorsi normalizzati delle sessioni del registro
 * @param {string} [tempRoot]
 */
export function missingTestSignals(rawPath, sessionPaths = new Set(), tempRoot = norm(os.tmpdir())) {
  const full = norm(rawPath);
  const missing = [];
  if (!full.startsWith(`${tempRoot}/`)) missing.push('S1: non è sotto la cartella temporanea');
  const segments = full.split('/');
  if (!segments.some((segment) => segment.startsWith(TEST_PREFIX))) missing.push(`S2: nessun segmento ${TEST_PREFIX}`);
  if (segments[segments.length - 1] !== TEST_BASENAME) missing.push(`S3: basename diverso da ${TEST_BASENAME}`);
  if (sessionPaths.has(full)) missing.push('S4: una sessione del registro punta qui');
  return missing;
}

export function classify({ projects, sessions, tempRoot = norm(os.tmpdir()) }) {
  const sessionPaths = new Set(sessions.map((session) => norm(session.projectPath)));
  const disposable = [];
  const ambiguous = [];
  const kept = [];

  for (const project of projects) {
    const missing = missingTestSignals(project.path, sessionPaths, tempRoot);
    const row = { path: project.path, key: project.key, name: project.name ?? null, missing };
    if (missing.length === 0) disposable.push(row);
    else if (norm(project.path).startsWith(`${tempRoot}/`)) ambiguous.push(row);
    else kept.push(row);
  }

  // Le sessioni non si toccano mai da qui: anche una sessione in una cartella temporanea può
  // essere una conversazione vera. Si segnalano soltanto.
  const tempSessions = sessions
    .filter((session) => norm(session.projectPath).startsWith(`${tempRoot}/`))
    .map((session) => ({
      sessionId: session.sessionId,
      name: session.name ?? null,
      projectPath: session.projectPath,
      imported: Boolean(session.imported),
    }));

  return { disposable, ambiguous, kept, tempSessions };
}

async function forgetThroughServer({ paths, port, stateDir }) {
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${port}/local/projects/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cc-remote-token': token },
    body: JSON.stringify({ paths }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error ?? `il server ha risposto ${response.status}`);
  return json;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const portArg = args.find((value) => value.startsWith('--port='));
  const port = Number(portArg?.split('=')[1] ?? process.env.CR_PORT ?? 4310);
  const stateFile = process.env.CR_STATE_FILE ?? path.join(os.homedir(), '.cc-remote', 'sessions.json');
  const stateDir = path.dirname(stateFile);
  const projectsFile = path.join(stateDir, 'projects.json');

  if (!fs.existsSync(projectsFile)) {
    console.error(`nessun ${projectsFile}: niente da fare`);
    process.exit(1);
  }

  const projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8')).projects ?? [];
  const sessions = JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions ?? [];
  const result = classify({ projects, sessions });

  console.log(`progetti: ${projects.length} · sessioni: ${sessions.length}`);
  console.log(`voci di test (regola S1+S2+S3+S4): ${result.disposable.length}`);
  console.log(`voci da approvare: ${result.ambiguous.length} · voci conservate: ${result.kept.length}`);
  if (result.tempSessions.length) {
    console.log(`sessioni in cartelle temporanee (segnalate, non toccate): ${result.tempSessions.length}`);
    for (const session of result.tempSessions) console.log(`  ${session.sessionId}  ${session.name ?? '(senza nome)'}  ${session.projectPath}`);
  }
  for (const row of result.ambiguous) console.log(`  DA APPROVARE  ${row.path}  [${row.missing.join('; ')}]`);

  const generatedAt = new Date().toISOString();
  const reportFile = path.join(os.tmpdir(), `cc-remote-cleanup-${generatedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(reportFile, JSON.stringify({ generatedAt, action: apply ? 'apply' : 'dry-run', port, ...result }, null, 2));
  console.log(`elenco completo: ${reportFile}`);

  if (!apply) {
    if (result.disposable.length) console.log('nessuna modifica: rilancia con --apply per rimuovere le voci di test');
    return;
  }
  if (!result.disposable.length) {
    console.log('niente da rimuovere');
    return;
  }

  const paths = result.disposable.map((row) => row.path);
  const answer = await forgetThroughServer({ paths, port, stateDir });
  // `forget` risponde con il **numero** di voci tolte, non con l'elenco.
  const removed = typeof answer.removed === 'number' ? answer.removed : (answer.removed?.length ?? 0);
  console.log(`rimosse: ${removed} / ${paths.length}`);
  if (removed !== paths.length) {
    console.error('il numero non torna: controlla il registro prima di considerarla fatta');
    process.exit(2);
  }
}

// Eseguito solo come programma: importarlo (i test) non deve leggere il profilo dell'utente.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
