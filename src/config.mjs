import os from 'node:os';
import path from 'node:path';
import { normalizeHost, parseOrigins } from './core/access.mjs';

const parseArgs = (value) => {
  if (!value) return [];
  // Un errore qui NON deve diventare "nessun argomento": con CR_CLAUDE_CMD=node e una lista
  // sbagliata partirebbe un REPL al posto dell'agente, e sembrerebbe un guasto misterioso.
  // (Successo davvero: un percorso Windows in JSON ha gli escape invalidi.)
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`CR_CLAUDE_ARGS non è JSON valido (${error.message}). Usa le barre in avanti nei percorsi: ["C:/percorso/script.mjs"]`);
  }
  if (!Array.isArray(parsed)) throw new Error('CR_CLAUDE_ARGS deve essere una lista JSON, es. ["--flag","valore"]');
  return parsed.map(String);
};

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Un interruttore: `1`, `true`, `si`/`sì`, `on`, `yes` accendono; tutto il resto spegne. */
const flag = (value) => /^(1|true|si|sì|on|yes)$/i.test(String(value ?? '').trim());

/**
 * Tutta la configurazione passa da qui, e solo da variabili d'ambiente: niente file di
 * configurazione da custodire, e un test può costruirsi un ambiente finto.
 */
export function loadConfig(env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  // Dove stanno i file di **questo** server: accanto al registro, non accanto all'utente.
  //
  // Erano due regole diverse — `access.json` e `settings.json` seguivano il registro, gli altri no
  // — e la differenza era un difetto vero: un test che isola il registro in una cartella temporanea
  // scriveva lo stesso i progetti in `~/.cc-remote/projects.json`. Il file vero ne aveva accumulati
  // **64, tutti di prova e nessuno reale**. Isolare il registro deve isolare tutto quello che gli
  // sta accanto; quello che sta altrove (i transcript di Claude Code) si isola a parte, dichiarato.
  const stateDir = path.dirname(env.CR_STATE_FILE || path.join(home, '.cc-remote', 'sessions.json'));
  return {
    home,
    projectsRoot: env.CR_PROJECTS_ROOT || path.join(home, '.claude', 'projects'),
    logFile: env.CR_LOG_FILE || path.join(os.tmpdir(), 'cc-remote.log'),
    // Le cartelle in cui è permesso far girare una sessione. Un percorso che arriva da fuori
    // (un link `?dir=`, un client MCP) non deve poter puntare dove vuole: niente UNC, niente
    // cartelle altrui. `CR_ALLOWED_ROOTS` le cambia (separate da `;`).
    allowedRoots: (env.CR_ALLOWED_ROOTS || home).split(';').map((entry) => entry.trim()).filter(Boolean),
    maxSessions: num(env.CR_MAX_SESSIONS, 64),
    // Tetto per singolo progetto (0 = nessun tetto oltre a quello globale).
    maxSessionsPerProject: num(env.CR_MAX_SESSIONS_PER_PROJECT, 0),
    stateFile: env.CR_STATE_FILE || path.join(home, '.cc-remote', 'sessions.json'),
    // I metadati organizzativi dei progetti (nome mostrato, stella, nascosto). Stanno **fuori**
    // dal registro di proposito: rinominare un progetto non deve poter toccare le conversazioni.
    projectsFile: env.CR_PROJECTS_FILE || path.join(stateDir, 'projects.json'),
    // Il giornale dei turni: quali `requestId` sono già stati eseguiti, e com'è finita. Serve
    // perché l'idempotenza non si perda quando il server si riavvia — altrimenti un client che
    // riprova dopo un riavvio fa partire la stessa richiesta una seconda volta.
    turnJournalFile: env.CR_TURN_JOURNAL_FILE || path.join(stateDir, 'turns.json'),
    turnJournalSize: num(env.CR_TURN_JOURNAL_SIZE, 200),

    // rete: loopback per default, un token, e l'origine pubblica se c'è un tunnel davanti
    host: env.CR_HOST || '127.0.0.1',
    port: num(env.CR_PORT, 4310),
    token: env.CR_TOKEN || '',
    // Le origini da cui il browser può arrivare: **più di una**, perché Tailscale e Cloudflare
    // possono essere accesi insieme e il browser arriva da due indirizzi diversi. Separate da
    // `;` o da spazi; una sola, come prima, continua a funzionare.
    publicOrigin: env.CR_PUBLIC_ORIGIN || '',
    publicOrigins: parseOrigins(env.CR_PUBLIC_ORIGIN),
    // ── un solo hostname pubblico ─────────────────────────────────────────────────────────────
    // Un solo dominio che serve **tutto**: dashboard e PWA su `/`, ChatGPT su `/mcp`, OAuth
    // sulle sue rotte. È una scelta del proprietario, e va chiesta per nome: senza questa riga il
    // comportamento resta quello di prima, con le due superfici chiuse una fuori dall'altra.
    //
    // `singleHostAdmin` è il **consenso esplicito** che serve per far funzionare da fuori le
    // operazioni che agiscono sulla macchina (aprire una cartella, ripristinare una copia,
    // chiudere un processo). Senza, quelle rotte rispondono 404 sull'host pubblico e restano
    // raggiungibili solo da questa macchina: la scelta prudente è quella che vale di default.
    singleHost: flag(env.CR_SINGLE_HOST),
    singleHostAdmin: flag(env.CR_SINGLE_HOST_ADMIN),
    // La scelta **stretta**, alternativa a quella larga sopra: da fuori si gestiscono i permessi
    // delle proprie conversazioni (il modo, e l'esposizione a ChatGPT) e nient'altro. Non apre il
    // pannello, non apre i ripristini, non apre le impostazioni — e non tocca `auto`.
    remotePermissions: flag(env.CR_REMOTE_PERMISSIONS),

    // La scelta dell'accesso da fuori sta **accanto al registro**: se il registro è in un posto
    // suo (una prova, un secondo rig), anche questa lo è, e nessuna prova tocca la
    // configurazione di chi usa la macchina.
    accessFile: env.CR_ACCESS_FILE || path.join(stateDir, 'access.json'),
    // Le impostazioni che si scelgono dal pannello (cartella dei progetti, radici consentite):
    // accanto al registro, come l'accesso, così una prova non tocca quelle di chi usa la macchina.
    settingsFile: env.CR_SETTINGS_FILE || path.join(stateDir, 'settings.json'),
    // I client OAuth registrati da sé (RFC 7591). Stanno **su disco** perché un `client_id` è
    // un'identità che il client si tiene: se il server la dimentica a ogni riavvio, il client
    // continua a presentare quella vecchia e prende `invalid_client` per sempre. Accanto al
    // registro, come gli altri file di stato. Solo i client: codici e token restano in memoria.
    oauthClientsFile: env.CR_OAUTH_CLIENTS_FILE || path.join(stateDir, 'oauth-clients.json'),
    dashboardHost: (env.CR_DASHBOARD_HOST || '').trim().toLowerCase(),

    // la cartella che si guarda quando un client non dice quale (il terminale di lavoro)
    defaultProject: env.CR_DEFAULT_PROJECT || env.CR_PROJECT_DIR || process.cwd(),
    // il target fissato a mano (CR_PROJECT_DIR), come nel rig vecchio
    projectDir: env.CR_PROJECT_DIR || '',

    // terminale
    claudeCmd: env.CR_CLAUDE_CMD || 'claude',
    // La modalita' dei permessi e' **per conversazione** (sta nel registro), e questa e' solo
    // quella di partenza per chi non la dice: la modalita' normale. Il bypass si chiede chat
    // per chat — `cc` lo chiede per te, il sito e i client remoti no.
    permissionMode: env.CR_PERMISSION_MODE || 'default',
    // Le modalita' che accettiamo di passare a `claude`. Sono le sue, piu' `default` (che non
    // compare nell'elenco di `--help` ma e' quella normale, ed e' verificata funzionante).
    // Una lista chiusa perche' un valore che arriva da fuori non deve poter diventare un
    // argomento arbitrario sulla riga di comando di `claude`.
    permissionModes: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'],
    // argomenti extra per il comando (JSON: serve ai test, con una TUI finta)
    claudeArgs: parseArgs(env.CR_CLAUDE_ARGS),
    cols: num(env.CR_COLS, 120),
    rows: num(env.CR_ROWS, 40),
    replayBytes: num(env.CR_REPLAY_BYTES, 512 * 1024),

    // turni: stessi valori con cui il rig attuale funziona
    discoveryRecentMs: num(env.CR_RECENT_MS, 5 * 60_000),
    promptMatchMs: num(env.CR_PROMPT_MATCH_MS, 120_000),
    pollMs: num(env.CR_POLL_MS, 400),
    settleMs: num(env.CR_SETTLE_MS, 1_500),
    // Quanto dura **una finestra di ascolto** di un turno. Alla scadenza il turno non finisce:
    // il coordinatore ricomincia a guardare dallo stesso punto, senza rimandare il messaggio.
    // Quindi questo valore non è più «quanto può durare un turno» — quello è `turnHardMs`.
    turnMaxMs: num(env.CR_MAX_WAIT_MS, 600_000),
    // Il tetto vero di un turno: oltre, l'agente si considera fermo e il turno si chiude con il
    // parziale. Generoso perché un lavoro lungo deve poter finire.
    turnHardMs: num(env.CR_TURN_HARD_MS, 4 * 3_600_000),
    // Da quanto un turno può non produrre **niente** prima di essere un sospetto nella diagnosi.
    // Non è un limite: è solo la differenza fra «sta lavorando» e «si è fermato».
    turnStallMs: num(env.CR_TURN_STALL_MS, 15 * 60_000),
    maxMessageChars: num(env.CR_MAX_MESSAGE_CHARS, 20_000),
    // Quanto un client MCP può tenere **appesa** una chiamata a `talk`. Deve restare sotto il
    // minuto e mezzo: davanti a questo server c'è Cloudflare, che taglia le risposte oltre i
    // ~100 secondi con un 524 — e un 524 non è un errore nostro, è una risposta che non arriva.
    // Il turno non ne soffre: continua a girare, e si recupera con `get_turn_status`.
    maxWaitSeconds: num(env.CR_MAX_WAIT_S, 90),
    defaultWaitSeconds: num(env.CR_DEFAULT_WAIT_S, 25),
    // Quanti turni si possono mettere in coda per una sessione. Senza tetto, un client che
    // riprova in un ciclo riempie la memoria e intasa la conversazione per ore.
    maxQueue: num(env.CR_MAX_QUEUE, 16),

    // gli hook sono un extra: senza, tutto funziona e la chat è solo più lenta
    hooks: env.CR_HOOKS !== '0',

    // Il relay delle approvazioni: quanto si aspetta una decisione dal browser (o dal telefono)
    // prima di lasciar comparire il dialog nel terminale. `0` spegne il relay: ogni richiesta
    // va subito al terminale, come se non ci fosse.
    approvalTtlMs: num(env.CR_APPROVAL_TTL_S, 120) * 1000,

    /**
     * I limiti del percorso pubblico (MCP e OAuth). Larghi di proposito: un client MCP vero fa
     * raffiche legittime, e un limite stretto romperebbe l'uso normale per fermare un abuso che
     * non c'è. Si alzano o si abbassano da ambiente, per prova.
     */
    rateLimits: Object.fromEntries(Object.entries({
      login: [10, 300], register: [20, 600], token: [60, 300], authorize: [60, 300], mcp: [300, 300],
    }).map(([name, [max, windowS]]) => [name, {
      max: num(env[`CR_RATE_${name.toUpperCase()}_MAX`], max),
      windowMs: num(env[`CR_RATE_${name.toUpperCase()}_WINDOW_S`], windowS) * 1000,
    }])),

    // bridge MCP: è un extra, e senza issuer/resource resta spento senza fermare il resto
    issuerUrl: env.CR_ISSUER_URL || '',
    resourceUrl: env.CR_RESOURCE_URL || '',
    // L'hostname pubblico su cui parla ChatGPT. Lì si serve **solo** la superficie OAuth: il
    // sito, le API locali e il websocket restano sull'indirizzo di casa. Se Cloudflare Access
    // venisse riconfigurato per sbaglio, l'interfaccia amministrativa non finisce comunque
    // su internet — è una garanzia del codice, non una promessa nel pannello.
    mcpHost: normalizeHost(env.CR_MCP_HOST),
    redirectUriHosts: (env.CR_REDIRECT_URI_HOSTS || 'chatgpt.com,openai.com,platform.openai.com')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
    // Quanto vale il consenso a esporre a MCP una chat che salta i permessi. **Scade**: un
    // consenso dato una volta e dimenticato non deve valere per sempre, perché autentica il
    // momento in cui è stato dato, non il traffico che viene dopo. `0` = nessuna scadenza.
    // `num` da solo non basta: `Number('')` è `0`, e `0` qui vuol dire «nessuna scadenza». Una
    // variabile lasciata **vuota** — che è come si scrive «non l'ho deciso» — spegnerebbe la
    // scadenza invece di lasciare il default. Vuoto = come non scritta; `0` scritto apposta
    // continua a voler dire «non scade».
    mcpBypassTtlSeconds: String(env.CR_MCP_BYPASS_TTL_S ?? '').trim() === ''
      ? 12 * 3_600
      : num(env.CR_MCP_BYPASS_TTL_S, 12 * 3_600),
    codeTtlMs: num(env.CR_CODE_TTL_MS, 10 * 60_000),
    accessTokenTtlS: num(env.CR_ACCESS_TOKEN_TTL_S, 3_600),
    refreshTokenTtlS: num(env.CR_REFRESH_TOKEN_TTL_S, 30 * 24 * 3_600),
  };
}

/**
 * Le combinazioni che non possono funzionare si dicono **all'avvio**, non si ignorano.
 *
 * `CR_SINGLE_HOST` senza `CR_MCP_HOST` è la peggiore delle due: il modo non si accende (non c'è
 * un hostname su cui accenderlo) e il server parte lo stesso, identico a prima. Chi l'ha scritto
 * crede di aver acceso una cosa che non è accesa — ed è il tipo di silenzio che si scopre tardi,
 * quando si va a controllare perché la dashboard non risponde da fuori.
 */
function assertCoerente(configurazione) {
  if (configurazione.singleHost && !configurazione.mcpHost) {
    throw new Error('CR_SINGLE_HOST è acceso ma manca CR_MCP_HOST: senza l\'hostname pubblico non c\'è un solo host da servire');
  }
  if (configurazione.singleHostAdmin && !configurazione.singleHost) {
    throw new Error('CR_SINGLE_HOST_ADMIN è acceso ma CR_SINGLE_HOST no: il consenso vale solo dentro la modalità a un hostname solo');
  }
  return configurazione;
}

export const config = assertCoerente(loadConfig());
