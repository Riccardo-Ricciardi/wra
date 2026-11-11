import assert from 'node:assert/strict';
import test from 'node:test';
import { elapsed, howMany, shortWhen, startOfToday, STATE_LABEL } from '../src/web/core/format.mjs';
import {
  activityAt, facetCounts, isActive, isRecent, isRunning, knownLabels,
  passesFacet, passesWhen, projectKeyOf, sectionsOf, visibleProjects,
} from '../src/web/core/session-view.mjs';

// Cosa si vede, dato quello che c'è. Era dentro `renderProjects()`, mescolata al disegno; adesso è
// pura e l'orologio è un parametro, quindi si prova — e si prova il **comportamento**: «con il
// filtro archiviate escono queste tre», non «la funzione chiama `filter` due volte».

const ADESSO = Date.parse('2026-11-04T12:00:00.000Z');
const giorniFa = (n) => new Date(ADESSO - n * 24 * 60 * 60 * 1000).toISOString();

const chat = (name, over = {}) => ({
  sessionId: name, name, projectPath: 'C:\\p\\uno', projectKey: 'c:\\p\\uno',
  state: 'offline', lastActivityAt: giorniFa(1), ...over,
});
const progetto = (key, over = {}) => ({ key, name: key.split('\\').pop(), path: key, favorite: false, hidden: false, ...over });

// ── il tempo ────────────────────────────────────────────────────────────────

test('il tempo passato si scrive in breve, e con l\'orologio si può fissare', () => {
  assert.equal(shortWhen(giorniFa(0), ADESSO), 'ora');
  assert.equal(shortWhen(new Date(ADESSO - 12 * 60_000).toISOString(), ADESSO), '12 min');
  assert.equal(shortWhen(new Date(ADESSO - 5 * 3_600_000).toISOString(), ADESSO), '5 h');
  // Oltre il giorno si passa alla data: «72 h» non lo legge nessuno.
  assert.match(shortWhen(new Date(ADESSO - 4 * 86_400_000).toISOString(), ADESSO), /\d{2}\/\d{2}/);
});

test('un tempo che non si sa leggere non diventa una data inventata', () => {
  assert.equal(shortWhen(null, ADESSO), '');
  assert.equal(shortWhen('', ADESSO), '');
  assert.equal(shortWhen('non-una-data', ADESSO), '');
});

test('la durata di ciò che sta succedendo adesso', () => {
  assert.equal(elapsed(ADESSO - 45_000, ADESSO), '45s');
  assert.equal(elapsed(ADESSO - 180_000, ADESSO), '3 min');
  // Un orologio che va all'indietro non deve produrre un tempo negativo.
  assert.equal(elapsed(ADESSO + 5_000, ADESSO), '0s');
});

test('i conteggi si accordano col numero: è il difetto che il pannello aveva', () => {
  assert.equal(howMany(1, 'conversazione', 'conversazioni'), 'conversazione');
  assert.equal(howMany(0, 'conversazione', 'conversazioni'), '0 conversazioni');
  assert.equal(howMany(4, 'conversazione', 'conversazioni'), '4 conversazioni');
});

test('mezzanotte è quella di chi guarda, non un istante fisso', () => {
  const mezzanotte = new Date(startOfToday(ADESSO));
  assert.equal(mezzanotte.getHours(), 0);
  assert.equal(mezzanotte.getMinutes(), 0);
});

test('gli stati hanno un nome, e sono tutti quelli che il server può mandare', () => {
  assert.deepEqual(Object.keys(STATE_LABEL).sort(), ['busy', 'exited', 'offline', 'ready', 'starting']);
});

// ── le conversazioni ────────────────────────────────────────────────────────

test('una conversazione senza data non finisce in cima all\'elenco per uno zero', () => {
  assert.equal(activityAt(chat('a', { lastActivityAt: null, createdAt: null })), 0);
  assert.equal(activityAt(chat('a', { lastActivityAt: giorniFa(2) })), ADESSO - 2 * 86_400_000);
  // Se manca l'ultima attività vale la creazione: una conversazione mai usata è vecchia quanto è.
  assert.equal(activityAt(chat('a', { lastActivityAt: null, createdAt: giorniFa(3) })), ADESSO - 3 * 86_400_000);
});

test('«recenti» è una settimana, e il confine è dalla parte giusta', () => {
  assert.equal(isRecent(chat('a', { lastActivityAt: giorniFa(6) }), ADESSO), true);
  assert.equal(isRecent(chat('a', { lastActivityAt: giorniFa(8) }), ADESSO), false);
});

test('acceso e raggiungibile sono due cose diverse, e «attive» prende tutte e due', () => {
  assert.equal(isRunning(chat('a', { state: 'ready' })), true);
  assert.equal(isRunning(chat('a', { state: 'offline' })), false);
  // Un processo spento ma esposto a un client esterno sta facendo qualcosa lo stesso.
  assert.equal(isActive(chat('a', { state: 'offline', mcpAllowed: true })), true);
  assert.equal(isActive(chat('a', { state: 'offline' })), false);
});

test('la chiave del progetto è quella del server, o la cartella', () => {
  assert.equal(projectKeyOf(chat('a', { projectKey: 'scelta' })), 'scelta');
  assert.equal(projectKeyOf({ projectPath: 'C:\\P\\Uno' }), 'c:\\p\\uno');
  assert.equal(projectKeyOf({}), '');
});

// ── i filtri ────────────────────────────────────────────────────────────────

test('le archiviate si vedono **solo** nel filtro archiviate', () => {
  const archiviata = chat('a', { archived: true });
  assert.equal(passesFacet(archiviata, { facet: 'all' }, ADESSO), false);
  assert.equal(passesFacet(archiviata, { facet: 'archived' }, ADESSO), true);
  assert.equal(passesFacet(chat('b'), { facet: 'archived' }, ADESSO), false);
});

test('il filtro per data e il filtro per stato si **combinano**, non si sostituiscono', () => {
  const ieri = chat('a', { lastActivityAt: giorniFa(1) });
  const vecchia = chat('b', { lastActivityAt: giorniFa(20), favorite: true });
  assert.equal(passesFacet(ieri, { facet: 'favorite', when: 'any' }, ADESSO), false);
  assert.equal(passesFacet(vecchia, { facet: 'favorite', when: 'any' }, ADESSO), true);
  // Preferita **e** degli ultimi 7 giorni: la vecchia esce, perché il filtro per data stringe.
  assert.equal(passesFacet(vecchia, { facet: 'favorite', when: 'week' }, ADESSO), false);
});

test('«oggi» parte da mezzanotte, gli altri sono finestre scorrevoli', () => {
  const stamattina = chat('a', { lastActivityAt: new Date(startOfToday(ADESSO) + 3_600_000).toISOString() });
  const ieriSera = chat('b', { lastActivityAt: new Date(startOfToday(ADESSO) - 3_600_000).toISOString() });
  assert.equal(passesWhen(stamattina, 'today', ADESSO), true);
  assert.equal(passesWhen(ieriSera, 'today', ADESSO), false);
  // …ma ieri sera è dentro «ultimi 7 giorni».
  assert.equal(passesWhen(ieriSera, 'week', ADESSO), true);
});

test('il numero accanto a un filtro è quello che il filtro prende davvero', () => {
  const elenco = [
    chat('a'),
    chat('b', { favorite: true }),
    chat('c', { state: 'ready' }),
    chat('d', { archived: true }),
    chat('e', { lastActivityAt: giorniFa(30) }),
  ];
  const { counts, whenTotal } = facetCounts(elenco, { when: 'any' }, ADESSO);
  assert.equal(counts.all, 4, 'le archiviate non contano in «tutte»');
  assert.equal(counts.archived, 1);
  assert.equal(counts.recent, 3, 'quella di 30 giorni fa non è recente, e l\'archiviata non conta');
  assert.equal(counts.favorite, 1);
  assert.equal(counts.active, 1);
  assert.equal(whenTotal, 5);
});

// ── cosa si vede ────────────────────────────────────────────────────────────

test('i progetti si raggruppano dalle conversazioni, e uno vuoto compare lo stesso', () => {
  const sessions = [chat('a'), chat('b', { projectPath: 'C:\\p\\due', projectKey: 'c:\\p\\due' })];
  const projects = [progetto('c:\\p\\uno'), progetto('c:\\p\\due'), progetto('c:\\p\\tre')];
  const visti = visibleProjects({ sessions, projects }, ADESSO);
  assert.deepEqual(visti.map((e) => e.project.key).sort(), ['c:\\p\\due', 'c:\\p\\tre', 'c:\\p\\uno']);
  // Quello senza conversazioni c'è: è lì che si va a creare la prima.
  assert.deepEqual(visti.find((e) => e.project.key === 'c:\\p\\tre').sessions, []);
});

test('un progetto con conversazioni ma nessuna che corrisponde non si mostra', () => {
  const sessions = [chat('bug del login'), chat('fatture', { projectPath: 'C:\\p\\due', projectKey: 'c:\\p\\due' })];
  const visti = visibleProjects({ sessions, needle: 'bug' }, ADESSO);
  assert.deepEqual(visti.map((e) => e.project.key), ['c:\\p\\uno']);
  assert.deepEqual(visti[0].sessions.map((s) => s.name), ['bug del login']);
});

test('la parola cerca nel nome, nell\'etichetta e nel progetto', () => {
  const sessions = [
    chat('alfa', { label: 'cliente' }),
    chat('beta'),
    chat('gamma', { projectPath: 'C:\\p\\cantiere', projectKey: 'c:\\p\\cantiere' }),
  ];
  assert.deepEqual(visibleProjects({ sessions, needle: 'cliente' }, ADESSO)[0].sessions.map((s) => s.name), ['alfa']);
  // Il nome del progetto che corrisponde prende **tutte** le sue conversazioni.
  assert.deepEqual(visibleProjects({ sessions, needle: 'uno' }, ADESSO)[0].sessions.map((s) => s.name), ['alfa', 'beta']);
  assert.deepEqual(visibleProjects({ sessions, needle: 'cantiere' }, ADESSO)[0].sessions.map((s) => s.name), ['gamma']);
});

test('i progetti nascosti si vedono solo se lo si chiede', () => {
  const sessions = [chat('a')];
  const projects = [progetto('c:\\p\\uno', { hidden: true })];
  assert.equal(visibleProjects({ sessions, projects }, ADESSO).length, 0);
  assert.equal(visibleProjects({ sessions, projects, showHidden: true }, ADESSO).length, 1);
});

test('«solo il progetto aperto» con nessuna conversazione aperta non restringe niente', () => {
  const sessions = [chat('a'), chat('b', { projectPath: 'C:\\p\\due', projectKey: 'c:\\p\\due' })];
  // Senza `currentKey` la scelta vuol dire «mostrami tutto», non «non mostrarmi niente»: sarebbe
  // un vicolo cieco, e per giunta ricordato fra le preferenze.
  assert.equal(visibleProjects({ sessions, solo: true, currentKey: null }, ADESSO).length, 2);
  assert.equal(visibleProjects({ sessions, solo: true, currentKey: 'c:\\p\\due' }, ADESSO).length, 1);
});

test('l\'ordine dei progetti è per attività, e i preferiti vanno in cima', () => {
  const sessions = [
    chat('a', { projectPath: 'C:\\p\\vecchio', projectKey: 'c:\\p\\vecchio', lastActivityAt: giorniFa(30) }),
    chat('b', { projectPath: 'C:\\p\\nuovo', projectKey: 'c:\\p\\nuovo', lastActivityAt: giorniFa(1) }),
  ];
  const perAttivita = visibleProjects({ sessions, sort: 'activity' }, ADESSO).map((e) => e.project.name);
  assert.deepEqual(perAttivita, ['nuovo', 'vecchio']);
  const conStella = visibleProjects({
    sessions,
    sort: 'favorite',
    projects: [progetto('c:\\p\\vecchio', { favorite: true })],
  }, ADESSO).map((e) => e.project.name);
  assert.deepEqual(conStella, ['vecchio', 'nuovo']);
});

test('le sezioni raggruppano solo quando un\'etichetta c\'è', () => {
  const senza = sectionsOf([chat('a'), chat('b')]);
  assert.equal(senza.length, 1);
  assert.equal(senza[0].title, null);

  const con = sectionsOf([chat('a', { label: 'casa' }), chat('b')]);
  assert.deepEqual(con.map((g) => g.title), ['casa', 'senza sezione']);
});

test('le etichette in uso si propongono una volta sola, in ordine', () => {
  assert.deepEqual(knownLabels([chat('a', { label: 'zeta' }), chat('b', { label: 'casa' }), chat('c', { label: 'zeta' })]),
    ['casa', 'zeta']);
});
