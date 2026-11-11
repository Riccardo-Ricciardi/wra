// Dove si mette un menu che appartiene a un pulsante.
//
// Puro e senza DOM: entra la geometria, esce la posizione. Esiste perché il difetto che questa
// milestone corregge — **ogni** menu a `left: 8px`, staccato dalla sua ancora — non si vede
// leggendo il codice: si vede misurando. E una misura si tiene ferma solo con una prova, che su un
// modulo puro si scrive in Node (`test/anchor.test.mjs`).
//
// Le tre regole, in ordine di importanza:
//
//  1. **dentro lo schermo**: il menu non esce mai dai quattro bordi, a nessuna larghezza;
//  2. **attaccato alla sua ancora**: il bordo destro del menu sta su quello dell'ancora — i menu di
//     questa interfaccia si aprono da pulsanti che stanno a destra, e uno che cresce verso sinistra
//     resta attaccato al suo;
//  3. **sotto, o sopra se sotto non c'è spazio**: si ribalta solo quando il ribaltamento è davvero
//     meglio, altrimenti un menu alto si limita e scorre.

/** Lo spazio che resta fra il menu e il bordo dello schermo. */
export const GUTTER = 8;
/** Lo spazio fra l'ancora e il menu: quanto basta perché si veda che sono due cose. */
export const GAP = 6;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * @param {{top: number, bottom: number, left: number, right: number}} anchor  il rettangolo dell'ancora
 * @param {{width: number, height: number}} size  quanto è grande il menu
 * @param {{width: number, height: number}} viewport
 * @returns {{left: number, top: number, height: number, flip: boolean, scroll: boolean}}
 *   `height` è l'altezza **usata**: se il menu è più alto dello spazio, si limita e `scroll` dice
 *   che al suo interno si scorre. Un menu che esce dallo schermo è un menu che non si può usare.
 */
export function placeAnchored(anchor, size, viewport, { gutter = GUTTER, gap = GAP } = {}) {
  const height = Math.min(size.height, Math.max(0, viewport.height - 2 * gutter));
  const sotto = viewport.height - anchor.bottom - gap;
  const sopra = anchor.top - gap;
  // Si ribalta solo se sotto non ci sta **e** sopra c'è più spazio: ribaltare un menu che non ci
  // sta nemmeno sopra lo manderebbe a coprire la testata senza guadagnare niente.
  const flip = sotto < height && sopra > sotto;
  const top = clamp(
    flip ? anchor.top - gap - height : anchor.bottom + gap,
    gutter,
    viewport.height - height - gutter,
  );
  const larghezzaUtile = Math.max(0, viewport.width - 2 * gutter);
  const left = clamp(anchor.right - size.width, gutter, viewport.width - Math.min(size.width, larghezzaUtile) - gutter);
  return { left, top, height, flip, scroll: size.height > height + 0.5 };
}
