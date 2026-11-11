// Il marchio: una **sola** sorgente per la favicon e per le icone della PWA.
//
//   node tools/make-pwa-icons.mjs          rigenera icon.svg, icon-192.png, icon-512.png
//   node tools/make-pwa-icons.mjs --prova  disegna anche 16 e 32 px e dice se si leggono
//
// Perché genera anche l'SVG invece di lasciarlo scritto a mano: erano due disegni che dicevano la
// stessa cosa, e due copie divergono — è scritto nella storia di questo repository. Adesso il
// disegno è `DISEGNO`, e l'SVG e i PNG escono tutti e tre da lì. Un test
// (`test/pwa-shell.test.mjs`) rifà il conto e confronta con il file su disco: se qualcuno tocca
// l'uno senza l'altro, cade lì.
//
// Il PNG si scrive a mano (zlib per i dati, quattro blocchi con il loro CRC): servono due immagini,
// e non si aggiunge una dipendenza per disegnare due quadrati.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web');

/**
 * The drawing, in one measurement only: a rounded square, and inside it a W — the WRA mark.
 *
 * The numbers are not decorative. At 16px the stroke must be **at least one and a half pixels**, or
 * the pixels thin out and the mark becomes a blot: 9/100 of 16 is 1.44px, which is why the stroke is
 * 9 and not 7 as in the previous version. The glyph sits between 20.5 and 79.5 out of 100 — that is,
 * inside the central 80%, the area a "maskable" icon is not allowed to have clipped by Android.
 */
export const DISEGNO = {
  box: 100,
  radius: 18,
  // The identity black (`--accent` in the light theme: `oklch(22% 0 0)`) and the `--bg` white.
  bg: [26, 26, 26],
  fg: [254, 254, 254],
  stroke: 9,
  chevron: [[20.5, 21], [32.3, 71], [50, 40.4], [67.7, 71], [79.5, 21]],
  bar: [],
};

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** L'SVG, dalla stessa sorgente dei PNG. */
export function svgOf(d = DISEGNO) {
  const punti = (punti) => punti.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ');
  const traccia = (linea) => (linea.length ? `\n  <path d="${punti(linea)}" fill="none" stroke="${hex(d.fg)}" stroke-width="${d.stroke}" stroke-linecap="round" stroke-linejoin="round"/>` : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.box} ${d.box}" role="img" aria-label="WRA">
  <rect width="${d.box}" height="${d.box}" rx="${d.radius}" fill="${hex(d.bg)}"/>${traccia(d.chevron)}${traccia(d.bar)}
</svg>
`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let at = 0;
  for (let y = 0; y < size; y += 1) {
    raw[at] = 0; // filtro: nessuno
    at += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = a;
      at += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit per canale
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Il disegno come funzione dei pixel: da qui escono tutti i PNG, a qualunque misura. */
export function pixelOf(size, d = DISEGNO) {
  const radius = d.radius * (size / d.box);
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return Math.hypot(x - cx, y - cy) <= radius + 0.5;
  };
  const stroke = (px, py, points, width) => {
    for (let i = 0; i < points.length - 1; i += 1) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
      if (Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) <= width / 2) return true;
    }
    return false;
  };

  const s = size / d.box;
  const chevron = d.chevron.map(([x, y]) => [x * s, y * s]);
  const bar = d.bar.map(([x, y]) => [x * s, y * s]);
  const w = d.stroke * s;

  return (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    if (!inRounded(px, py)) return [0, 0, 0, 0];
    if (stroke(px, py, chevron, w) || stroke(px, py, bar, w)) return [...d.fg, 255];
    return [...d.bg, 255];
  };
}

export const pngOf = (size, d = DISEGNO) => png(size, pixelOf(size, d));

/**
 * Il segno si legge a questa misura?
 *
 * Due cose, e sono le due che si rompono per prime quando si rimpicciolisce: un tratto che si
 * sfoltisce fino a sparire (troppi pochi pixel di glifo), e un disegno che si sbriciola in puntini
 * (pixel di glifo circondati dal fondo da tutti e quattro i lati — il segno c'è, ma non si legge).
 *
 * @returns {{size: number, glifo: number, quota: number, isolati: number, leggibile: boolean}}
 */
export function leggibilita(size, d = DISEGNO) {
  const pixel = pixelOf(size, d);
  const glifo = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    const [r] = pixel(x, y);
    return r === d.fg[0];
  };
  let quanti = 0;
  let isolati = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!glifo(x, y)) continue;
      quanti += 1;
      const vicini = glifo(x - 1, y) || glifo(x + 1, y) || glifo(x, y - 1) || glifo(x, y + 1);
      if (!vicini) isolati += 1;
    }
  }
  const quota = quanti / (size * size);
  return { size, glifo: quanti, quota, isolati, leggibile: quota >= 0.05 && isolati === 0 };
}

const file = (name) => path.join(OUT, name);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(file('icon.svg'), svgOf());
  console.log(`icon.svg: ${svgOf().length} byte`);
  for (const size of [192, 512]) {
    const dati = pngOf(size);
    fs.writeFileSync(file(`icon-${size}.png`), dati);
    console.log(`icon-${size}.png: ${dati.length} byte`);
  }

  if (process.argv.includes('--prova')) {
    // Le due misure che contano davvero: 16 è la scheda del browser, 32 il collegamento sul desktop.
    const prova = path.join(OUT, '..', '..', 'docs', 'screenshots', 'm9', 'icone');
    fs.mkdirSync(prova, { recursive: true });
    let rotto = 0;
    for (const size of [16, 32, 192, 512]) {
      const dati = pngOf(size);
      fs.writeFileSync(path.join(prova, `icon-${size}.png`), dati);
      const esito = leggibilita(size);
      if (!esito.leggibile) rotto += 1;
      console.log(`  ${String(size).padStart(3)}px: ${String(esito.glifo).padStart(5)} pixel di glifo (${(esito.quota * 100).toFixed(1)}%), ${esito.isolati} isolati → ${esito.leggibile ? 'si legge' : 'NON si legge'}`);
    }
    console.log(`  scritte in ${prova}`);
    if (rotto) process.exitCode = 1;
  }
}
