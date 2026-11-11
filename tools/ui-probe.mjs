#!/usr/bin/env node
// Misura l'interfaccia invece di guardarla: le scale di tipo davvero in uso, i bersagli da dito
// che non arrivano a 44px, i contrasti reali, quanto spazio resta vuoto. Serve a scrivere un
// audit con dei numeri dentro, e a rifare la stessa misura dopo per vedere se è cambiato qualcosa.
//
//   node tools/ui-probe.mjs [--dark]        (o --url ... --token ... per un server che c'è già)
import { startBench } from './bench.mjs';
import { argsOf, launch } from './cdp.mjs';

const { arg, has } = argsOf();
const fornito = arg('url', null);
const bench = fornito ? null : await startBench({ name: 'misure' });
const base = (fornito ?? bench.base).replace(/\/$/, '');
const token = arg('token', bench?.token ?? process.env.CR_TOKEN ?? '');
const dark = has('dark');

const page = await launch({
  base, token, shotDir: arg('shot', 'docs/screenshots/m6/prima'), name: `cc-remote — misure (${dark ? 'scuro' : 'chiaro'})`,
  port: Number(arg('port', 9355)), viewport: { width: 1440, height: 900 },
});
const { evaluate, goto, setViewport, click, closeOverlays } = page;

// La stessa lettura del contrasto di `tools/check-contrast.mjs`, ma sui colori **resi** dal
// browser: è l'unico modo di misurare quello che c'è sullo schermo invece di quello che si spera.
// Il browser restituisce i colori come sono scritti — `oklch(...)` — non come RGB: leggerne le
// cifre e chiamarle «rosso, verde, blu» dà rapporti inventati (e infatti la prima versione
// stampava 1.00 su testo perfettamente leggibile). Si passa dal canvas, che è l'unico che sa
// dire qual è il colore **davvero** sullo schermo.
const CONTRAST = `
window.__canvas = document.createElement('canvas');
window.__canvas.width = window.__canvas.height = 1;
window.__ctx = window.__canvas.getContext('2d', { willReadFrequently: true });
window.__rgb = (color) => {
  window.__ctx.clearRect(0, 0, 1, 1);
  window.__ctx.fillStyle = '#000';
  window.__ctx.fillStyle = color;
  window.__ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = window.__ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a };
};
window.__lum = ({ r, g, b }) => {
  const lin = [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};
window.__ratio = (a, b) => { const [x, y] = [window.__lum(a), window.__lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Il fondo **dipinto** dietro un nodo: si risale finché qualcuno non è opaco. */
window.__bgOf = (node) => {
  for (let at = node; at; at = at.parentElement) {
    const rgb = window.__rgb(getComputedStyle(at).backgroundColor);
    if (rgb.a > 0.9) return rgb;
  }
  return window.__rgb(getComputedStyle(document.body).backgroundColor);
};
true;
`;

const report = {};

await setViewport(1440, 900, { dark });
await goto();
await evaluate(CONTRAST);

// ── 1. La scala di tipo davvero in uso ───────────────────────────────────────
report.type = await evaluate(`(() => {
  const counts = new Map();
  for (const node of document.querySelectorAll('body *')) {
    if (!node.textContent.trim() || node.children.length) continue;
    const style = getComputedStyle(node);
    const key = style.fontSize + ' / ' + style.fontWeight;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).map(([size, count]) => ({ size, count }));
})()`);

// ── 2. Contrasto reale dei testi ─────────────────────────────────────────────
report.contrast = await evaluate(`(() => {
  const bad = []; const seen = new Set();
  let checked = 0;
  for (const node of document.querySelectorAll('body *')) {
    if (!node.textContent.trim() || node.children.length) continue;
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    checked += 1;
    const ratio = window.__ratio(window.__rgb(style.color), window.__bgOf(node));
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    const key = node.className + '|' + style.color + '|' + style.fontSize;
    if (ratio < need && !seen.has(key)) {
      seen.add(key);
      bad.push({ chi: (node.className || node.tagName).toString().slice(0, 30), text: node.textContent.trim().slice(0, 30), size: style.fontSize, ratio: Math.round(ratio * 100) / 100, need });
    }
  }
  return { controllati: checked, sotto: bad };
})()`);

// ── 3. Quanto spazio resta vuoto nella home ──────────────────────────────────
report.home = await evaluate(`(() => {
  const body = document.querySelector('#home-body');
  const viewport = document.querySelector('#viewport');
  if (!body || !viewport) return null;
  const a = body.getBoundingClientRect(); const b = viewport.getBoundingClientRect();
  return { colonna: Math.round(a.width), contenitore: Math.round(b.width), riempimento: Math.round((a.width / b.width) * 100) + '%' };
})()`);

// ── 4. La lista: quante informazioni per riga, e quali ───────────────────────
// Il guscio è cambiato in M8 — non c'è più un cassetto con i progetti da aprire, né
// una classe `.conv` — e questa sezione era rimasta ferma a quello. Adesso misura la riga
// che c'è: quella dell'elenco delle conversazioni.
await evaluate(`new Promise((r) => setTimeout(r, 400))`);
report.riga = await evaluate(`(() => {
  const row = document.querySelector('#conversations-body .list .row[data-id]')?.closest('li');
  if (!row) return null;
  return {
    altezza: Math.round(row.getBoundingClientRect().height),
    testo: row.textContent.replace(/\\s+/g, ' ').trim(),
    figli: row.children.length,
    nodi: row.querySelectorAll('*').length,
  };
})()`);

// ── 5. I chip in circolazione: quante parole diverse per dire «stato» ────────
report.chip = await evaluate(`(() => {
  const texts = new Set();
  for (const node of document.querySelectorAll('.chip, .badge, [class*="chip"]')) {
    const text = node.textContent.trim();
    if (text) texts.add(text);
  }
  return [...texts];
})()`);

// ── 6. Da telefono: i bersagli che non arrivano a 44px ───────────────────────
await setViewport(390, 844, { dark, mobile: true });
await evaluate(`document.querySelector('#scrim')?.click()`);
await evaluate(`new Promise((r) => setTimeout(r, 300))`);
// Tolleranza di 1px: un bersaglio largo 43.86px è largo 44 — la differenza viene da come il flex
// distribuisce lo spazio, e non è una differenza che un dito possa sentire. Senza tolleranza la
// misura segnala falsi positivi, e una misura che grida al lupo è una misura che si smette di
// leggere.
report.bersagli = await evaluate(`(() => {
  const small = [];
  for (const node of document.querySelectorAll('button, [role="button"], a[href], input, textarea, [tabindex="0"]')) {
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (getComputedStyle(node).visibility === 'hidden') continue;
    if (rect.height < 43 || rect.width < 43) {
      small.push({ chi: (node.getAttribute('aria-label') || node.textContent.trim() || node.id || node.className).slice(0, 34), w: Math.round(rect.width * 10) / 10, h: Math.round(rect.height * 10) / 10 });
    }
  }
  return small;
})()`);

// ── 7. La testata da telefono: quanto resta del nome ─────────────────────────
report.testataTelefono = await evaluate(`(() => {
  const name = document.querySelector('#conv-name');
  const style = getComputedStyle(name);
  return { larghezza: Math.round(name.getBoundingClientRect().width), testo: name.textContent, troncato: name.scrollWidth > name.clientWidth + 1, overflow: style.textOverflow };
})()`);

// ── 8. Quanti colori distinti, e quante ombre ────────────────────────────────
report.palette = await evaluate(`(() => {
  const colors = new Set(); const shadows = new Set(); const radii = new Set();
  for (const node of document.querySelectorAll('body *')) {
    const style = getComputedStyle(node);
    if (style.color) colors.add(style.color);
    if (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)') colors.add(style.backgroundColor);
    if (style.boxShadow && style.boxShadow !== 'none') shadows.add(style.boxShadow);
    radii.add(style.borderRadius);
  }
  return { colori: colors.size, ombre: shadows.size, raggi: radii.size };
})()`);

// ── 9. Da tastiera: dove si arriva ───────────────────────────────────────────
report.tastiera = await evaluate(`(() => {
  const reachable = [...document.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.disabled && node.offsetParent !== null);
  const noName = reachable.filter((node) => !(node.getAttribute('aria-label') || node.textContent.trim() || node.getAttribute('title')));
  return { raggiungibili: reachable.length, senzaNome: noName.length };
})()`);

await closeOverlays();
console.log(JSON.stringify(report, null, 2));
await page.close();
await bench?.stop();
