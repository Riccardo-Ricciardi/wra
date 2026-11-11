// I progetti come li vede l'interfaccia. Logica pura: niente filesystem, niente server — così
// si prova senza montare niente, e la stessa funzione la usano il server (che la manda al
// browser) e i test.
//
// Il punto delicato: **cosa è un progetto**. Non ha un record suo obbligatorio — esiste se ha
// conversazioni, o se qualcuno l'ha registrato a mano scegliendo una cartella. La cartella vera
// resta l'unica verità sul disco; nome, preferito e nascosto sono metadati dell'interfaccia, e
// stanno in un file separato dal registro delle conversazioni.

import path from 'node:path';

/** Chiave di confronto di una cartella: lo stesso percorso scritto in due modi è una voce sola. */
export function pathKey(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return path.resolve(raw).replace(/[\\/]+$/, '').toLowerCase();
}

/** L'ultimo pezzo di un percorso: il nome della cartella, che è il nome di partenza. */
export function baseName(value) {
  const raw = String(value ?? '').replace(/[\\/]+$/, '');
  const cut = raw.split(/[\\/]/).pop();
  return cut || raw;
}

const asTime = (iso) => {
  const at = Date.parse(iso ?? '');
  return Number.isFinite(at) ? at : 0;
};

/**
 * Fonde conversazioni e metadati in un elenco di progetti.
 *
 * @param {object} input
 * @param {Array<object>} input.sessions  le conversazioni (viste del registro)
 * @param {Array<object>} input.stored    i metadati salvati: `{path, name, favorite, hidden}`
 * @returns {Array<object>} un progetto per cartella, con i conteggi e l'ultima attività
 */
export function buildProjects({ sessions = [], stored = [] } = {}) {
  const byKey = new Map();

  const slot = (rawPath) => {
    const key = pathKey(rawPath);
    if (!key) return null;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        path: path.resolve(String(rawPath)),
        realName: baseName(rawPath),
        name: baseName(rawPath),
        favorite: false,
        hidden: false,
        // L'«MCP automatico controllato» del progetto: le conversazioni che non hanno scelto
        // niente per sé prendono questo. Nasce spento.
        autoApprove: false,
        registered: false,
        createdAt: null,
        lastActivityAt: null,
        count: 0,
        // Quante conversazioni "contano" quando si guarda il progetto: le archiviate non sono
        // lavoro in corso, e il numero accanto al nome deve dire quello che si vede aprendo.
        open: 0,
        running: 0,
      });
    }
    return byKey.get(key);
  };

  for (const item of stored) {
    const view = slot(item?.path);
    if (!view) continue;
    view.registered = true;
    if (item.name) view.name = String(item.name).slice(0, 60);
    view.favorite = Boolean(item.favorite);
    view.hidden = Boolean(item.hidden);
    view.autoApprove = item.autoApprove === true;
    if (item.createdAt) view.createdAt = item.createdAt;
  }

  for (const session of sessions) {
    const view = slot(session?.projectPath);
    if (!view) continue;
    view.count += 1;
    if (!session.archived) view.open += 1;
    if (session.state && session.state !== 'offline' && session.state !== 'exited') view.running += 1;
    const when = asTime(session.lastActivityAt) || asTime(session.createdAt);
    if (when && when > asTime(view.lastActivityAt)) view.lastActivityAt = new Date(when).toISOString();
  }

  return [...byKey.values()];
}
