#!/usr/bin/env node
// Le funzioni spostate fuori da `app.js` sono le **stesse**?
//
//   node tools/estrazione-check.mjs            (confronta con 73f91d4, l'ultimo commit prima)
//   node tools/estrazione-check.mjs --before <ref>
//
// Un'estrazione è un **trasloco**, non una riscrittura. I banchi dicono che l'interfaccia funziona
// (35/35 e 14/14), ma dicono solo quello che i loro controlli toccano: questo confronta i corpi
// delle funzioni spostate, uno per uno, spazi a parte, e per quelle che differiscono dice **cosa**
// è cambiato. Se un corpo è cambiato, o è un difetto o è una modifica da dichiarare.
//
// Il risultato atteso, e quello che si è visto: le differenze sono solo nomi che diventano
// parametri di fabbrica — `knownLabelsQui()` → `knownLabels(state.sessions)`, `PAGE_KEY` →
// `pageKey` — cioè esattamente il refactoring, e niente di più.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { argsOf } from './cdp.mjs';

const { arg } = argsOf();
const prima = arg('before', '73f91d4');
const repo = path.resolve(import.meta.dirname, '..');
const moduli = ['list', 'chat', 'terminal', 'shell', 'selection', 'projects', 'activity'];

const vecchio = execFileSync('git', ['show', `${prima}:src/web/app.js`], { cwd: repo, encoding: 'utf8' });
const leggere = (file) => fs.readFileSync(path.join(repo, file), 'utf8');

/** nome -> corpo, spazi normalizzati. */
function blocchi(testo) {
  const fuori = new Map();
  const re = /^\s*(?:export )?(?:async )?function (\w+)\(/gm;
  let m;
  while ((m = re.exec(testo)) !== null) {
    // `m.end` non esiste: si calcola dalla fine del match.
    const i = testo.indexOf('{', m.index + m[0].length - 1);
    let livello = 0;
    let j = i;
    for (; j < testo.length; j += 1) {
      if (testo[j] === '{') livello += 1;
      else if (testo[j] === '}') { livello -= 1; if (livello === 0) break; }
    }
    if (i === -1 || j >= testo.length) continue;
    fuori.set(m[1], testo.slice(i, j + 1).replace(/\s+/g, ' ').trim());
  }
  return fuori;
}

const diPrima = blocchi(vecchio);
const diOra = new Map();
for (const modulo of moduli) {
  for (const [nome, corpo] of blocchi(leggere(`src/web/ui/views/${modulo}.mjs`))) {
    if (diOra.has(nome)) console.log(`nome doppio fra i moduli: ${nome}`);
    diOra.set(nome, { corpo, dove: modulo });
  }
}

const pezzi = (testo) => testo.match(/[A-Za-z0-9_$.]+|[^\sA-Za-z0-9_$.]/g) ?? [];
const soloIn = (testo, altro) => {
  const resto = pezzi(altro);
  const fuori = [];
  for (const p of pezzi(testo)) {
    const at = resto.indexOf(p);
    if (at === -1) fuori.push(p);
    else resto.splice(at, 1);
  }
  return fuori.join(' ');
};

const identiche = [];
const diverse = [];
const mancanti = [];
const nonSpostate = [...diPrima.keys()].filter((nome) => !diOra.has(nome));

for (const [nome, ora] of diOra) {
  const primaDi = diPrima.get(nome);
  if (!primaDi) { mancanti.push(nome); continue; }
  if (primaDi === ora.corpo) { identiche.push(nome); continue; }

  let k = 0;
  while (k < primaDi.length && k < ora.corpo.length && primaDi[k] === ora.corpo[k]) k += 1;
  diverse.push({
    nome,
    dove: ora.dove,
    contestoPrima: primaDi.slice(Math.max(0, k - 50), k + 50),
    contestoDopo: ora.corpo.slice(Math.max(0, k - 50), k + 50),
    soloPrima: soloIn(primaDi, ora.corpo),
    soloDopo: soloIn(ora.corpo, primaDi),
  });
}

console.log(`${diOra.size} funzioni spostate · ${identiche.length} identiche (spazi a parte) · ${diverse.length} diverse · ${mancanti.length} nuove`);
if (diverse.length) {
  console.log('\nDIVERSE — cosa è cambiato in ognuna:');
  for (const d of diverse) {
    console.log(`\n  ${d.nome} (in ${d.dove})`);
    console.log(`    prima: …${d.contestoPrima}…`);
    console.log(`    dopo:  …${d.contestoDopo}…`);
    console.log(`    solo di prima: ${d.soloPrima || '(niente)'}`);
    console.log(`    solo di dopo:  ${d.soloDopo || '(niente)'}`);
  }
} else {
  console.log('nessuna diversa: il trasloco non ha cambiato niente');
}
if (mancanti.length) console.log(`\nnuove (non c\'erano): ${mancanti.join(', ')}`);
console.log(`\nrimaste in app.js: ${nonSpostate.length} — ${nonSpostate.join(', ')}`);
process.exit(diverse.length || mancanti.length ? 1 : 0);
