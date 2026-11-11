// Un `createElement` che toglie di mezzo il rumore. Le viste qui sotto costruiscono decine di
// nodi: scritti a mano sono tre righe di `document.createElement` e quattro di `setAttribute`
// per ogni elemento, e a quel punto non si legge più *cosa* disegna la vista.
//
// Niente `innerHTML`, mai: il testo passa da `textContent`, quindi un transcript non può
// iniettare markup per quanto strano sia quello che l'agente ha scritto.

/**
 * @param {string} tag  `div`, oppure `div.classe.altra` con le classi attaccate
 * @param {object} [props]  attributi; `text` per il testo, `on*` per gli ascoltatori,
 *                          `dataset` per i data-*, `html` NON esiste apposta
 * @param {...(Node|string|null|false|undefined|Array)} children
 * @returns {HTMLElement}
 */
export function h(tag, props = null, ...children) {
  const [name, ...classes] = String(tag).split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'list' && typeof value !== 'object') node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Sostituisce il contenuto senza distruggere i nodi che restano gli stessi. */
export function fill(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
  return parent;
}
