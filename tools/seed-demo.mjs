#!/usr/bin/env node
// Riempie un registro di prova con tante conversazioni e tanti progetti, per guardare
// l'interfaccia con un volume vero addosso invece che con tre righe.
//
//   node tools/seed-demo.mjs --dir C:\tmp\cc-remote-demo --sessions 500 --projects 24
//
// Scrive **solo** dentro la cartella indicata: un registro, i metadati dei progetti, e un
// transcript finto per la prima conversazione (serve a vedere la chat, non solo l'elenco).
// Non tocca ~/.cc-remote e non avvia nessun processo: è una cartella usa e getta.
import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from '../src/core/workspace.mjs';
import { transcriptDirFor } from '../src/host/pty-host.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};

const dir = path.resolve(arg('dir', path.join(process.env.TEMP || '/tmp', 'cc-remote-demo')));
const total = Number(arg('sessions', 500));
const projectCount = Number(arg('projects', 24));
const withLabels = arg('labels', '1') !== '0';

const NAMES = ['restyling UI', 'migrazione dati', 'il ponte MCP', 'bug del login', 'rapporto mensile',
  'prova del telefono', 'fatture', 'ricerca nel contenuto', 'deploy', 'nota sparsa', 'pulizia registro',
  'idea per il blog', 'lettura del transcript', 'confronto fornitori', 'indice dei progetti'];
const LABELS = ['lavoro', 'casa', 'cliente', 'studio'];

fs.mkdirSync(dir, { recursive: true });
const projectsRoot = path.join(dir, 'projects');
fs.mkdirSync(projectsRoot, { recursive: true });

const sessions = [];
const now = Date.now();

for (let index = 0; index < total; index += 1) {
  const projectIndex = index % projectCount;
  const projectPath = path.join(dir, 'progetti', `progetto-${String(projectIndex).padStart(2, '0')}`);
  // Le cartelle esistono davvero: il registro accetta solo percorsi veri, e il server ci fa
  // partire un processo. Un dato di prova con cartelle inventate proverebbe un'altra cosa.
  fs.mkdirSync(projectPath, { recursive: true });
  const ageHours = Math.floor((index / total) ** 1.6 * 24 * 60); // da adesso indietro fino a ~60 giorni
  const lastActivityAt = new Date(now - ageHours * 3_600_000).toISOString();
  sessions.push({
    sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `${NAMES[index % NAMES.length]}${index >= NAMES.length ? ` ${Math.floor(index / NAMES.length) + 1}` : ''}`,
    projectPath,
    mcpAllowed: index % 37 === 0,
    permissionMode: index % 29 === 0 ? 'bypassPermissions' : 'default',
    favorite: index % 23 === 0,
    label: withLabels && index % 11 === 0 ? LABELS[index % LABELS.length] : null,
    archived: index % 41 === 0,
    imported: index % 5 !== 0,
    createdAt: new Date(now - (ageHours + 6) * 3_600_000).toISOString(),
    lastActivityAt,
  });
}

fs.writeFileSync(path.join(dir, 'sessions.json'), `${JSON.stringify({ version: 1, savedAt: new Date(now).toISOString(), sessions }, null, 2)}\n`);

const projects = Array.from({ length: projectCount }, (_unused, index) => ({
  key: pathKey(path.join(dir, 'progetti', `progetto-${String(index).padStart(2, '0')}`)),
  path: path.join(dir, 'progetti', `progetto-${String(index).padStart(2, '0')}`),
  name: index % 7 === 0 ? `Cliente ${index}` : null,
  favorite: index % 6 === 0,
  hidden: index % 13 === 5,
  createdAt: new Date(now - 30 * 86_400_000).toISOString(),
}));

// Le **voci di prova**: metadati di progetto senza nessuna conversazione, con un nome che il codice
// di produzione non scrive. Sono la forma esatta delle 64 voci che la suite ha lasciato nel registro
// vero — l'audit di M9 le ha contate lì, tutte in `%TEMP%\cc-remote-e2e-*`. Nel banco stanno dentro
// la cartella di prova (che è già una cartella temporanea usa e getta) perché il registro accetta
// solo percorsi veri: le cartelle si creano, i metadati restano orfani come nella realtà.
const ghostCount = Number(arg('ghosts', 8));
const ghosts = Array.from({ length: ghostCount }, (_unused, index) => {
  const percorso = path.join(dir, `cc-remote-e2e-${String(index).padStart(2, '0')}`);
  fs.mkdirSync(percorso, { recursive: true });
  return { key: pathKey(percorso), path: percorso, name: null, createdAt: new Date(now).toISOString() };
});

fs.writeFileSync(path.join(dir, 'projects.json'), `${JSON.stringify({ version: 1, savedAt: new Date(now).toISOString(), projects: [...projects, ...ghosts] }, null, 2)}\n`);

// Un transcript per una conversazione **non archiviata**: così la vista chat e la ricerca dentro
// i messaggi hanno qualcosa da mostrare (e la ricerca, giustamente, non guarda l'archivio). Va
// dove lo cerca il server, cioè nella cartella che Claude Code usa per quel percorso.
// Un turno **vero**, non tre righe: serve a guardare la chat con addosso quello che ci finisce
// davvero — ragionamento, una raffica di strumenti di fila, un diff, una tabella e un blocco di
// codice. Le forme sono quelle che scrive Claude Code (`tool_use`/`tool_result`, `structuredPatch`
// per le modifiche, `toolUseResult` per stdout): se qui fossero inventate, la schermata mostrerebbe
// una chat che non esiste.
//
// Si scrive per le conversazioni **più recenti**, non per una sola scelta a mano: l'elenco si apre
// su quella che ha lavorato per ultima, e quale sia dipende dall'ordinamento — cioè da una regola
// del prodotto, che cambia. Puntare a un indice fisso è il modo di far sparire la chat dal banco
// senza che nessuno tocchi niente.
const conTranscript = sessions
  .map((session, index) => ({ session, index }))
  .sort((a, b) => b.index - a.index)
  .slice(-40)
  .map((entry) => entry.session);

for (const catalogued of conTranscript) {
  const slug = transcriptDirFor(catalogued.projectPath, projectsRoot);
  fs.mkdirSync(slug, { recursive: true });
  const first = catalogued.sessionId;
  const transcript = [
  { type: 'user', sessionId: first, cwd: catalogued.projectPath, version: '2.0.0', timestamp: new Date(now - 900_000).toISOString(), message: { content: 'Riordiniamo l\'elenco: con tutte queste conversazioni non si trova più niente.' } },
  { type: 'assistant', sessionId: first, timestamp: new Date(now - 880_000).toISOString(), message: { model: 'claude-opus-5-5', content: [
    { type: 'thinking', thinking: 'Prima di proporre qualcosa guardo com\'è fatto adesso: quali filtri esistono, come si raggruppa, cosa si può fissare.' },
    { type: 'text', text: 'Ho guardato com\'è fatto adesso:\n\n1. i progetti sono gruppi, non cartelle\n2. l\'elenco non ha filtri\n3. non si può fissare niente in alto\n\nDirei di partire dai filtri.' },
  ] } },
  { type: 'assistant', sessionId: first, timestamp: new Date(now - 870_000).toISOString(), message: { model: 'claude-opus-5-5', content: [
    { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'rg -n "passesFacet|facetCounts" src/web/core/session-view.mjs' } },
  ] } },
  { type: 'user', sessionId: first, timestamp: new Date(now - 868_000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '51:export function facetCounts(sessions, { when = \'any\' } = {}, now = Date.now())' }] }, toolUseResult: { stdout: '51:export function facetCounts(sessions, { when = \'any\' } = {}, now = Date.now())' } },
  { type: 'assistant', sessionId: first, timestamp: new Date(now - 860_000).toISOString(), message: { model: 'claude-opus-5-5', content: [
    { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: 'src/web/ui/views/list.mjs' } },
    { type: 'tool_use', id: 'tu_3', name: 'Grep', input: { pattern: 'data-facet', path: 'src/web' } },
    { type: 'tool_use', id: 'tu_4', name: 'Glob', input: { pattern: 'src/web/ui/views/*.mjs' } },
  ] } },
  { type: 'user', sessionId: first, timestamp: new Date(now - 858_000).toISOString(), message: { content: [
    { type: 'tool_result', tool_use_id: 'tu_2', content: '     1\t// L\'elenco delle conversazioni…\n     2\timport { h, fill } from \'/ui/dom.mjs\';' },
  ] }, toolUseResult: { filePath: 'src/web/ui/views/list.mjs', type: 'read' } },
  { type: 'user', sessionId: first, timestamp: new Date(now - 857_000).toISOString(), message: { content: [
    { type: 'tool_result', tool_use_id: 'tu_3', content: 'src/web/ui/views/list.mjs:112:  h(\'button\', { dataset: { facet } })' },
  ] } },
  { type: 'user', sessionId: first, timestamp: new Date(now - 856_000).toISOString(), message: { content: [
    { type: 'tool_result', tool_use_id: 'tu_4', content: 'src/web/ui/views/list.mjs\nsrc/web/ui/views/chat.mjs\nsrc/web/ui/views/admin.mjs' },
  ] } },
  { type: 'assistant', sessionId: first, timestamp: new Date(now - 840_000).toISOString(), message: { model: 'claude-opus-5-5', content: [
    { type: 'tool_use', id: 'tu_5', name: 'Edit', input: { file_path: 'src/web/ui/views/list.mjs', old_string: 'facet = \'all\'', new_string: 'facet = \'recent\'' } },
  ] } },
  { type: 'user', sessionId: first, timestamp: new Date(now - 838_000).toISOString(), permissionDecision: { decision: 'accept', source: 'user' }, message: { content: [
    { type: 'tool_result', tool_use_id: 'tu_5', content: 'Applied 1 edit.' },
  ] }, toolUseResult: {
    filePath: 'src/web/ui/views/list.mjs',
    type: 'update',
    structuredPatch: [{ oldStart: 108, oldLines: 3, newStart: 108, newLines: 3, lines: [
      '   const facet = state.facet',
      "-  if (!facet) facet = 'all';",
      "+  if (!facet) facet = 'recent';",
      '   return facet;',
    ] }],
  } },
  { type: 'assistant', sessionId: first, timestamp: new Date(now - 820_000).toISOString(), message: { model: 'claude-opus-5-5', content: [
    { type: 'text', text: 'Fatto. Il filtro di partenza ora è «recenti», e i conteggi vengono da `facetCounts`, quindi il numero accanto a ogni filtro è quello vero e non una stima.\n\n| Filtro | Quante | Cosa mostra |\n|---|---|---|\n| tutte | 84 | ogni conversazione non archiviata |\n| recenti | 12 | toccate nell\'ultima settimana |\n| preferite | 4 | quelle che hai fissato |\n| archiviate | 3 | messe via, non cancellate |\n\nPer provarlo:\n\n```bash\nnode --test test/session-view.test.mjs\n```\n\nSe il filtro di partenza non ti piace, si cambia in una riga: `state.facet` è l\'unico posto che lo decide.' },
  ] } },
  { type: 'ai-title', sessionId: first, aiTitle: 'restyling UI' },
  ];
  fs.writeFileSync(path.join(slug, `${first}.jsonl`), `${transcript.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

console.log(`registro di prova in ${dir}`);
console.log(`  ${sessions.length} conversazioni in ${projectCount} progetti (${projects.filter((p) => p.hidden).length} nascosti, ${sessions.filter((s) => s.archived).length} archiviate)`);
console.log(`  ${conTranscript.length} conversazioni recenti con un transcript vero da mostrare`);
console.log(`  avvialo con: CR_PORT=4399 CR_STATE_FILE="${path.join(dir, 'sessions.json')}" CR_PROJECTS_FILE="${path.join(dir, 'projects.json')}" CR_PROJECTS_ROOT="${projectsRoot}" CR_ALLOWED_ROOTS="${dir}" node src/cli/serve.mjs`);
