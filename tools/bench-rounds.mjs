#!/usr/bin/env node
// Dieci giri di fila dei due banchi, per rispondere a una domanda sola: **danno sempre lo stesso
// risultato?** Un banco che modifica il registro su cui gira risponde di no, e allora il secondo
// giro non dice niente sul codice.
//
//   node tools/bench-rounds.mjs 10
//
// Confronta l'elenco dei controlli (nome + esito) giro per giro, e dice se due giri differiscono.
// Non è una prova del programma: è la prova del **banco**.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const rounds = Number(process.argv[2] ?? 10);
const out = path.join(os.tmpdir(), 'cc-remote-giri');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const banchi = ['ui-check.mjs', 'ui-admin-check.mjs'];

/** Le righe dei controlli, spogliate del tempo: due giri si confrontano per esito, non per orologio. */
function esiti(text) {
  return text.split('\n')
    .filter((line) => /^\s+[✔✖] /.test(line))
    .map((line) => line.replace(/^\s+/, '').replace(/ — .*$/, ''));
}

/** Il **dettaglio** di ogni controllo (quello dopo il trattino): serve a vedere cosa cambia fra i giri. */
function dettagli(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    if (!/^\s+[✔✖] /.test(line)) continue;
    const [, nome, dettaglio] = /^\s+[✔✖] (.+?)(?: — (.*))?$/.exec(line);
    out.set(nome.trim(), dettaglio ?? '');
  }
  return out;
}

const giri = [];
for (let round = 1; round <= rounds; round += 1) {
  const esito = {};
  for (const tool of banchi) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(repo, 'tools', tool), '--shot', path.join(out, 'shots')], {
      cwd: repo, encoding: 'utf8', env: { ...process.env },
    });
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    fs.writeFileSync(path.join(out, `${tool}.${round}.txt`), text);
    esito[tool] = {
      codice: result.status,
      secondi: Math.round((Date.now() - started) / 1000),
      passati: esiti(text).filter((line) => line.startsWith('✔')).length,
      falliti: esiti(text).filter((line) => line.startsWith('✖')),
      controlli: esiti(text),
      dettagli: dettagli(text),
    };
  }
  giri.push(esito);
  const riassunto = banchi.map((tool) => {
    const e = esito[tool];
    return `${tool}: ${e.passati}✔ ${e.falliti.length}✖ (uscita ${e.codice}, ${e.secondi}s)`;
  }).join('  ·  ');
  console.log(`giro ${String(round).padStart(2)} — ${riassunto}`);
}

console.log('');
let diversi = 0;
for (const tool of banchi) {
  const primo = giri[0][tool];
  const differenti = giri.map((giro, at) => ({ at: at + 1, e: giro[tool] }))
    .filter(({ e }) => JSON.stringify(e.controlli) !== JSON.stringify(primo.controlli)
      || e.passati !== primo.passati || e.codice !== primo.codice);
  if (!differenti.length) {
    console.log(`✔ ${tool}: ${rounds} giri identici — ${primo.passati} controlli passati, ${primo.falliti.length} falliti, uscita ${primo.codice}`);
  } else {
    diversi += 1;
    console.log(`✖ ${tool}: ${differenti.length} giri diversi dal primo`);
    for (const { at, e } of differenti) {
      console.log(`   giro ${at}: ${e.passati}✔ ${e.falliti.length}✖ uscita ${e.codice}`);
      for (const linea of e.falliti) console.log(`      ${linea}`);
    }
  }

  // E il **dettaglio** di ogni controllo, che l'esito non guarda: se cambia, il mondo di prova non
  // è identico — o il controllo racconta qualcosa che dipende dal giro (un pid, un numero di
  // richieste). Non è un fallimento, ed è la cosa da sapere prima di fidarsi del numero.
  const variabili = [];
  for (const nome of primo.dettagli.keys()) {
    const visti = new Set(giri.map((giro) => giro[tool].dettagli.get(nome) ?? null));
    if (visti.size > 1) variabili.push({ nome, visti: [...visti] });
  }
  console.log(variabili.length
    ? `  · ${variabili.length} controlli con un dettaglio che cambia fra i giri (non è un fallimento):`
    : '  · ogni dettaglio è identico in tutti i giri');
  for (const { nome, visti } of variabili.slice(0, 8)) {
    console.log(`      ${nome}: ${visti.map((v) => JSON.stringify(v)).join('  |  ')}`);
  }
}
console.log(diversi ? `\n${diversi} banchi non sono ripetibili` : '\nentrambi i banchi sono ripetibili');
process.exit(diversi ? 1 : 0);
