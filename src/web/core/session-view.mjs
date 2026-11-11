// Dai dati del server a **cosa si vede**: quali conversazioni, in quali gruppi, in che ordine.
//
// Era dentro `renderProjects()`, mescolata al disegno: 75 righe in cui si filtrava, si
// raggruppava, si ordinava e si costruivano nodi DOM, tutto insieme. Qui è pura — nessun DOM,
// nessun `state` letto di nascosto — e l'orologio è un parametro. Quindi si può provare: «con il
// filtro archiviate e la parola *bug*, escono queste tre» è un'asserzione, non un'ispezione.
import { groupSessions, sortProjects } from './ordering.mjs';
import { RECENT_MS, startOfToday, WHEN_MS } from './format.mjs';
import { reachableOf } from './authorization.mjs';

/** Quando è stata usata l'ultima volta: `0` se non si sa, così l'ordinamento non impazzisce. */
export const activityAt = (session) => Date.parse(session.lastActivityAt ?? session.createdAt ?? '') || 0;

/** È «recente»? Una settimana è il tempo in cui una conversazione è ancora quella di adesso. */
export const isRecent = (session, now = Date.now()) => now - activityAt(session) < RECENT_MS;

/** La chiave del progetto di una conversazione: quella che manda il server, o la cartella. */
export const projectKeyOf = (session) => session.projectKey ?? String(session.projectPath ?? '').toLowerCase();

/** Una conversazione ha un processo vivo? */
export const isRunning = (session) => session.state === 'ready' || session.state === 'starting' || session.state === 'busy';

/**
 * «Attiva»: gira adesso, oppure è raggiungibile da un client esterno. Sono due cose diverse — un
 * processo acceso e una porta aperta — ma il filtro «attive» serve a rispondere a una domanda
 * sola: *quali di queste stanno facendo qualcosa?*
 */
export const isActive = (session) => isRunning(session) || reachableOf(session);

/** Da quando in qua: `oggi` è da mezzanotte, gli altri sono finestre scorrevoli. */
export function passesWhen(session, when = 'any', now = Date.now()) {
  if (when === 'any') return true;
  const at = activityAt(session);
  if (when === 'today') return at >= startOfToday(now);
  return now - at < (WHEN_MS[when] ?? Infinity);
}

/** Il filtro dello stato: tutte, recenti, preferite, attive, archiviate. */
export function passesFacet(session, { facet = 'all', when = 'any' } = {}, now = Date.now()) {
  if (!passesWhen(session, when, now)) return false;
  if (facet === 'archived') return Boolean(session.archived);
  if (session.archived) return false;
  if (facet === 'recent') return isRecent(session, now);
  if (facet === 'favorite') return Boolean(session.favorite);
  if (facet === 'active') return isActive(session);
  return true;
}

/**
 * Quante conversazioni prende ogni filtro, e quante ne prenderebbe il filtro per data.
 *
 * Il numero accanto a un filtro non è decorazione: un filtro senza il suo numero è un filtro di
 * cui non ci si fida, perché non si sa se è vuoto perché non c'è niente o perché è rotto.
 */
export function facetCounts(sessions, { when = 'any' } = {}, now = Date.now()) {
  const counts = { all: 0, recent: 0, favorite: 0, active: 0, archived: 0 };
  let whenTotal = 0;
  for (const session of sessions) {
    if (!passesWhen(session, when, now)) continue;
    whenTotal += 1;
    if (session.archived) {
      counts.archived += 1;
      continue;
    }
    counts.all += 1;
    if (isRecent(session, now)) counts.recent += 1;
    if (session.favorite) counts.favorite += 1;
    if (isActive(session)) counts.active += 1;
  }
  return { counts, whenTotal };
}

/** La forma che serve a `sortProjects`: l'ultima attività del gruppo. */
export function projectOrderShape({ project, sessions }) {
  const latest = sessions.reduce((best, session) => Math.max(best, activityAt(session)), 0);
  return { ...project, lastActivityAt: latest ? new Date(latest).toISOString() : null };
}

/**
 * **I progetti che si vedono**, già filtrati e ordinati.
 *
 * Le conversazioni sono la verità e i progetti del server servono solo per nome, stella e
 * «nascosto»: il raggruppamento si fa qui, così quello che si vede è sempre coerente con quello
 * che c'è. Un progetto registrato a mano ma ancora vuoto compare lo stesso — è lì che si va a
 * creare la prima.
 *
 * @returns {Array<{project: object, sessions: Array<object>}>}
 */
export function visibleProjects({
  sessions = [], projects = [], facet = 'all', when = 'any', needle = '',
  solo = false, showHidden = false, currentKey = null, sort = 'activity',
} = {}, now = Date.now()) {
  const text = String(needle).trim().toLowerCase();
  const known = new Map(projects.map((project) => [project.key, project]));

  const groups = new Map();
  for (const session of sessions) {
    const key = projectKeyOf(session);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  for (const project of projects) if (!groups.has(project.key)) groups.set(project.key, []);

  const shown = [];
  for (const [key, list] of groups) {
    const found = known.get(key);
    const project = found ?? {
      key,
      path: list[0]?.projectPath ?? key,
      name: String(list[0]?.projectPath ?? key).split(/[\\/]/).pop(),
      favorite: false,
      hidden: false,
    };
    if (project.hidden && !showHidden) continue;
    // «Solo il progetto aperto» con nessuna conversazione aperta non restringe niente: vuol dire
    // «mostrami tutto», non «non mostrarmi niente».
    if (solo && currentKey && key !== currentKey) continue;

    const projectMatched = Boolean(text)
      && (String(project.name).toLowerCase().includes(text) || String(project.path).toLowerCase().includes(text));
    const visible = list.filter((session) => passesFacet(session, { facet, when }, now)
      && (!text || projectMatched
        || String(session.name).toLowerCase().includes(text)
        || String(session.label ?? '').toLowerCase().includes(text)));
    // Un progetto con conversazioni ma nessuna che corrisponde non si mostra: l'elenco deve
    // contenere risultati, non il catalogo di dove sono andati a finire.
    if (!visible.length && !(list.length === 0 && !text && facet === 'all')) continue;
    shown.push({ project, sessions: visible });
  }

  const order = sortProjects(shown.map(projectOrderShape), sort);
  const rank = new Map(order.map((project, index) => [project.key, index]));
  return shown.sort((a, b) => rank.get(a.project.key) - rank.get(b.project.key));
}

/**
 * Le conversazioni di un progetto, raggruppate per sezione quando le sezioni esistono. Sottile
 * di proposito: la regola sta in `groupSessions`, che è provata.
 */
export const sectionsOf = (sessions, sort = 'activity') => groupSessions(sessions, sort);

/** Le etichette già in uso, per proporle invece di farle riscrivere a mano. */
export const knownLabels = (sessions) => [...new Set(sessions.map((session) => session.label).filter(Boolean))]
  .sort((a, b) => a.localeCompare(b, 'it'));

export { RECENT_MS };
