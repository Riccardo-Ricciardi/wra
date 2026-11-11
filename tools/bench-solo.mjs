#!/usr/bin/env node
// Ogni controllo, **da solo**, su un registro nuovo.
//
//   node tools/bench-solo.mjs [--tool ui-check.mjs]
//
// Un controllo che passa solo perché ne ha eseguito un altro prima è un controllo che dipende da
// dove ha lasciato la pagina — la famiglia di difetti che ha tenuto in piedi per un giro intero la
// diagnosi sbagliata di «una sezione raggruppa». Il giro intero non può rispondere a questa
// domanda: solo il controllo solo può.
//
// Costa un banco per controllo (server + browser + seme, ~35 secondi l'uno). Si lancia quando si
// vuole la risposta, non a ogni commit.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { argsOf } from './cdp.mjs';

const { arg } = argsOf();
const tools = arg('tool', 'ui-check.mjs,ui-admin-check.mjs').split(',').map((t) => t.trim()).filter(Boolean);
const repo = path.resolve(import.meta.dirname, '..');
const out = path.join(os.tmpdir(), 'cc-remote-solo');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/** I nomi dei controlli, letti dall'output di un giro intero. */
function nomiDi(text) {
  return text.split('\n')
    .filter((line) => /^\s+[✔✖] /.test(line))
    .map((line) => line.replace(/^\s+[✔✖] /, '').replace(/ — .*$/, ''));
}

const esiti = [];
for (const tool of tools) {
  const intero = spawnSync(process.execPath, [path.join(repo, 'tools', tool), '--shot', path.join(out, 'shots')], {
    cwd: repo, encoding: 'utf8',
  });
  const testo = `${intero.stdout ?? ''}${intero.stderr ?? ''}`;
  fs.writeFileSync(path.join(out, `${tool}.intero.txt`), testo);
  const nomi = nomiDi(testo);
  console.log(`${tool}: ${nomi.length} controlli — ognuno adesso gira da solo`);
  if (!nomi.length) {
    console.log('  nessun nome letto: il giro intero non ha prodotto controlli');
    continue;
  }

  for (const nome of nomi) {
    const solo = spawnSync(process.execPath,
      [path.join(repo, 'tools', tool), '--shot', path.join(out, 'shots'), '--only', nome],
      { cwd: repo, encoding: 'utf8' });
    const uscita = `${solo.stdout ?? ''}${solo.stderr ?? ''}`;
    fs.writeFileSync(path.join(out, `${tool}.${nome.replace(/[^\w]+/g, '_').slice(0, 60)}.txt`), uscita);
    const passati = nomiDi(uscita).length;
    const falliti = uscita.split('\n').filter((line) => /^\s+✖ /.test(line));
    const ok = solo.status === 0 && passati === 1 && !falliti.length;
    esiti.push({ tool, nome, ok });
    console.log(`  ${ok ? '✔' : '✖'} ${nome}${ok ? '' : ` — ${falliti[0]?.replace(/^\s+✖ /, '') ?? `uscita ${solo.status}`}`}`);
  }
}

console.log('');
const rotti = esiti.filter((e) => !e.ok);
console.log(rotti.length
  ? `✖ ${rotti.length} controlli su ${esiti.length} NON passano da soli`
  : `✔ tutti i ${esiti.length} controlli passano anche da soli`);
console.log(`output in ${out}`);
process.exit(rotti.length ? 1 : 0);
