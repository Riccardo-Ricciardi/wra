// Come si scrivono le cose: il tempo, i conteggi, le parole che si ripetono.
//
// Puro, e con l'orologio **iniettabile**: `shortWhen(iso, adesso)` e non `shortWhen(iso)`. Non è
// pedanteria — è la differenza fra un modulo che si può provare («due minuti fa» è vero per
// sempre) e uno che si può provare solo entro il minuto in cui l'hai scritto. Il resto del
// programma passa `Date.now()`, i test passano una data fissa.

/** Quanto tempo fa, in breve: `ora`, `12 min`, `3 h`, oppure la data. */
export function shortWhen(iso, now = Date.now()) {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'ora';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h`;
  return new Date(at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
}

/** Da quanto va avanti qualcosa che sta succedendo adesso: `45s`, `3 min`. */
export function elapsed(since, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * «1 conversazione» / «4 conversazioni». Esiste perché la forma sbagliata si vede: il pannello
 * diceva «1 processi accesi», e un'etichetta che non si accorda col numero è il modo in cui un
 * pannello smette di sembrare scritto da qualcuno.
 */
export const howMany = (count, one, many) => (count === 1 ? one : `${count} ${many}`);

/** Gli stati di una conversazione, per esteso. */
export const STATE_LABEL = {
  ready: 'pronta', starting: 'si avvia', offline: 'spenta', exited: 'chiusa', busy: 'occupata',
};

/** Quanto indietro arriva «recenti»: una settimana. Oltre, è archivio. */
export const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/** Le finestre del filtro per data. `week` e `month` sono scorrevoli, `today` parte da mezzanotte. */
export const WHEN_MS = { week: 7 * 24 * 60 * 60 * 1000, month: 30 * 24 * 60 * 60 * 1000 };

/** Mezzanotte di oggi, come la intende chi guarda. */
export function startOfToday(now = Date.now()) {
  const at = new Date(now);
  at.setHours(0, 0, 0, 0);
  return at.getTime();
}
