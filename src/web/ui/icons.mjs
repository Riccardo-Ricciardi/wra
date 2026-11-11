// Le icone. In linea, disegnate a mano, 24×24 con tratto di 1.8: niente font di icone, niente
// pacchetti, niente richieste di rete. Usano `currentColor`, quindi seguono il tema e lo stato
// del pulsante che le contiene — è il motivo per cui non sono immagini.

const PATHS = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  sort: 'M4 7h10M4 12h7M4 17h4M17 8v9M14 14l3 3 3-3',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  chat: 'M21 12a8 8 0 0 1-8 8H8l-5 3 1.4-4.2A8 8 0 1 1 21 12Z',
  terminal: 'M5 6l5 6-5 6M13 18h6',
  send: 'M5 12h13M12 5l7 7-7 7',
  copy: 'M9 9V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3M6 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z',
  check: 'M5 13l4 4L19 7',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 12.5l2.5 2.5 4.5-5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  file: 'M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z',
  pencil: 'M4 20h4L20 8l-4-4L4 16v4ZM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  power: 'M12 3v9M7.5 6.5a7 7 0 1 0 9 0',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  contrast: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 3v18',
  offline: 'M3 3l18 18M9 17h6M5 12a10 10 0 0 1 4-2.5M12 20h.01M8.5 15.5A6 6 0 0 1 12 14c1.3 0 2.5.4 3.5 1.2M2 8.8A15 15 0 0 1 7 6M22 8.8a15 15 0 0 0-7.5-3.6',
  // L'esposizione a un client esterno: una presa, non una porta. Serve a dire «qualcun altro può
  // parlare con questa conversazione» senza usare la forma di un modo di autorizzare — sono due
  // assi diversi e non devono somigliarsi.
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4',
  shield:'M12 3l8 3v6c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V6l8-3Z',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  star: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.6 9.7l5.8-.8L12 3.6Z',
  tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3.6 13.6V3.6h10l7 7a2 2 0 0 1 0 2.8ZM7.5 7.5h.01',
  archive: 'M3.5 7.5h17v3h-17zM5 10.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-8.5M10 14h4',
  eye: 'M2.5 12.8a1.6 1.6 0 0 1 0-1.6C3.5 9.4 7 5 12 5s8.5 4.4 9.5 6.2a1.6 1.6 0 0 1 0 1.6C20.5 14.6 17 19 12 19s-8.5-4.4-9.5-6.2ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.4 5.4A9.6 9.6 0 0 1 12 5c5 0 8.5 4.4 9.5 6.2a1.6 1.6 0 0 1 0 1.6 17 17 0 0 1-3.3 3.9M6.3 7.1A17.6 17.6 0 0 0 2.5 12.8a1.6 1.6 0 0 0 0 1.6C3.5 16.1 7 20 12 20a9.9 9.9 0 0 0 3.6-.7',
  // Il ritorno: una freccia, non un chevron. Un chevron dice «c'è altro da questa parte», una
  // freccia dice «si torna indietro», e qui si torna indietro.
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  // «Da fuori»: una freccia che esce dal riquadro. La sezione dell'accesso la usava già, e senza
  // questa voce cadeva sul cerchio dell'informazione — cioè diceva un'altra cosa.
  arrowUpRight: 'M7 17 17 7M9 7h8v8',
};

/**
 * @param {string} name
 * @param {{size?: number, className?: string, filled?: boolean}} [options]
 * @returns {SVGElement}
 */
export function icon(name, { size = 18, className = '', filled = false } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  // `filled` serve alla stella: piena vuol dire «preferita», e vuota «no». Un contorno grigio
  // non si distingue abbastanza in un elenco lungo, che è esattamente dove serve distinguerlo.
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.info);
  svg.append(path);
  return svg;
}

export const iconNames = Object.keys(PATHS);
