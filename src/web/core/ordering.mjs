// Gli ordini dell'elenco. Funzioni pure — niente DOM, niente filesystem — perché una regola di
// ordinamento si prova meglio di quanto si guardi: «i preferiti in cima» è una promessa, e una
// promessa si verifica. Infatti è provata in Node (`test/ordering.test.mjs`), come `markdown.mjs`.

const asTime = (iso) => {
  const at = Date.parse(iso ?? '');
  return Number.isFinite(at) ? at : 0;
};

const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'it');

/**
 * L'ordine dei progetti.
 *
 * `favorite` non è un ordine a sé: è «i preferiti in cima, e sotto gli altri come sempre» — che
 * è quello che serve davvero quando si è messa una stella su due o tre cartelle di lavoro.
 *
 * @param {Array<{key: string, name: string, favorite?: boolean, lastActivityAt?: string, createdAt?: string}>} projects
 * @param {'activity'|'name'|'favorite'} order
 */
export function sortProjects(projects, order = 'activity') {
  const activity = (project) => asTime(project.lastActivityAt) || asTime(project.createdAt);
  const sorted = [...projects];
  sorted.sort((a, b) => {
    if (order === 'name') return byName(a, b);
    // Un progetto registrato a mano ma ancora vuoto non ha attività: va in fondo, non fra i
    // primi per via dello zero — e nemmeno sparire in mezzo a chi lavora.
    return activity(b) - activity(a) || byName(a, b);
  });
  if (order === 'favorite') {
    // Un `sort` stabile su una lista già ordinata: si porta in cima solo quello che cambia.
    sorted.sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)));
  }
  return sorted;
}

/**
 * L'ordine delle conversazioni dentro un progetto: le fissate in alto, sempre — è il senso della
 * stella, e un preferito che resta in mezzo agli altri non è fissato.
 *
 * @param {Array<{name: string, favorite?: boolean, lastActivityAt?: string, createdAt?: string}>} sessions
 * @param {'activity'|'name'|'created'} order
 */
export function sortSessions(sessions, order = 'activity') {
  const when = (session) => asTime(session.lastActivityAt) || asTime(session.createdAt);
  const created = (session) => asTime(session.createdAt) || when(session);
  const sorted = [...sessions];
  sorted.sort((a, b) => {
    if (order === 'name') return byName(a, b);
    if (order === 'created') return created(b) - created(a) || byName(a, b);
    return when(b) - when(a) || byName(a, b);
  });
  sorted.sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)));
  return sorted;
}

/**
 * Le sezioni di un progetto.
 *
 * Le etichette raggruppano solo se ce n'è almeno una: un gruppo solo, senza nome, non è
 * un'organizzazione — è una riga in più da leggere. E se c'è un preferito, quello sta in cima
 * comunque: la stella promette «fissata in alto», e mantenere la promessa vale più che dire in
 * che sezione si trova (l'etichetta resta scritta sulla riga).
 *
 * @returns {Array<{title: string|null, sessions: Array<object>}>}
 */
export function groupSessions(sessions, order = 'activity') {
  const ordered = sortSessions(sessions, order);
  const labels = [...new Set(ordered.map((session) => session.label).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'it'));
  if (!labels.length) return [{ title: null, sessions: ordered }];

  const pinned = ordered.filter((session) => session.favorite);
  const rest = ordered.filter((session) => !session.favorite);
  const groups = [];
  if (pinned.length) groups.push({ title: 'fissate', sessions: pinned });
  for (const label of labels) {
    const inLabel = rest.filter((session) => session.label === label);
    if (inLabel.length) groups.push({ title: label, sessions: inLabel });
  }
  const loose = rest.filter((session) => !session.label);
  if (loose.length) groups.push({ title: 'senza sezione', sessions: loose });
  return groups;
}
