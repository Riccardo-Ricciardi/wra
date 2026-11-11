// Contrasto calcolato davvero: oklch -> oklab -> sRGB lineare -> luminanza relativa (WCAG).
// La luminanza si calcola sui valori LINEARI: farlo sui valori codificati in gamma gonfia il
// rapporto, ed è il modo classico di illudersi che una palette passi.
//
// I valori **non** sono scritti qui: si leggono da `src/web/app.css`. Prima erano una tabella
// copiata a mano, ed era già andata fuori sincrono una volta — un controllo che verifica una copia
// verifica la copia, non il foglio che il browser riceve.
//
//   node tools/check-contrast.mjs
import fs from 'node:fs';
import path from 'node:path';

const FOGLIO = path.join(import.meta.dirname, '..', 'src', 'web', 'app.css');
const css = fs.readFileSync(FOGLIO, 'utf8');

/** I token di un blocco `:root`, per nome, come triple oklch. */
function tokensOf(selettore) {
  const blocco = css.match(new RegExp(`${selettore}\\s*\\{([^}]*)\\}`));
  if (!blocco) throw new Error(`blocco non trovato in app.css: ${selettore}`);
  const fuori = {};
  for (const [, nome, l, c, h] of blocco[1].matchAll(/--([\w-]+):\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/g)) {
    fuori[nome] = [Number(l), Number(c), Number(h)];
  }
  return fuori;
}

const oklchToLinear = (L, C, hDeg) => {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h); const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3; const m = m_ ** 3; const s = s_ ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map((v) => Math.max(0, Math.min(1, v)));
};
const hex = (lin) => `#${lin.map((v) => Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255).toString(16).padStart(2, '0')).join('')}`;
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// `--reach` e `--accent` non compaiono qui perché non sono coppie testo/fondo: l'esposizione
// remota e l'accento sono **segni**, e la soglia di un segno è 3:1, non 4.5.
const COPPIE = [
  ['testo su sfondo', 'fg', 'bg', 4.5],
  ['testo su superficie', 'fg', 'surface', 4.5],
  ['testo attenuato su sfondo', 'muted', 'bg', 4.5],
  ['testo attenuato su superficie', 'muted', 'surface', 4.5],
  ['testo tenue (didascalie) su superficie', 'faint', 'surface', 4.5],
  ['chip accento (testo su tinta)', 'accent-fg', 'accent', 4.5],
  ['accento su superficie', 'accent', 'surface', 4.5],
  ['verde su superficie', 'ok', 'surface', 4.5],
  ['ambra su superficie', 'warn', 'surface', 3],
  // L'ambra come **testo**: un'altra cosa dall'ambra come segno. Un pallino si vede anche a 3:1,
  // una parola da 11px no — e questa parola dice quanto è pericolosa la conversazione.
  ['ambra-inchiostro su superficie', 'warn-ink', 'surface', 4.5],
  ['ambra-inchiostro su tinta ambra', 'warn-ink', 'warn-soft', 4.5],
  ['rosso su superficie', 'danger', 'surface', 4.5],
  ['collegamento su superficie', 'link', 'surface', 4.5],
];

let failures = 0;
let mancanti = 0;
for (const [tema, selettore] of [['chiaro', ':root'], ['scuro', ':root\\[data-theme="dark"\\]']]) {
  const token = tokensOf(selettore);
  const c = Object.fromEntries(Object.entries(token).map(([k, v]) => [k, oklchToLinear(v[0] / 100, v[1], v[2])]));
  console.log(`\n${tema}  (sfondo ${hex(c.bg)}, superficie ${hex(c.surface)}, testo ${hex(c.fg)})`);
  for (const [etichetta, fg, bg, need] of COPPIE) {
    if (!c[fg] || !c[bg]) { mancanti += 1; console.log(`  ${etichetta.padEnd(38)} token mancante: ${c[fg] ? bg : fg}`); continue; }
    const r = ratio(c[fg], c[bg]);
    const ok = r >= need;
    if (!ok) failures += 1;
    console.log(`  ${etichetta.padEnd(38)} ${r.toFixed(2)}:1  (serve ${need})  ${ok ? 'ok' : 'BASSO'}`);
  }
}
console.log(`\n${failures === 0 && mancanti === 0
  ? 'tutte le coppie passano, lette da app.css'
  : `${failures} coppie sotto la soglia, ${mancanti} token mancanti`}`);
process.exit(failures === 0 && mancanti === 0 ? 0 : 1);
