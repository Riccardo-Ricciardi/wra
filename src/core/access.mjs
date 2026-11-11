// Le due modalità ufficiali per raggiungere la dashboard da fuori, e cosa serve a ciascuna.
//
// Logica pura: nessun filesystem, nessun processo. Le decisioni — che cosa è un hostname valido,
// che variabili produce una modalità, cosa manca perché funzioni — si provano in Node, e la CLI
// e il server si limitano a eseguirle.
//
// Il confine che non va confuso, e che questo file tiene separato per costruzione:
//
//   DASHBOARD AMMINISTRATIVA  → il sito, le API `/local/*`, il websocket. È la persona.
//   ENDPOINT MCP / OAUTH      → `/mcp`, `/register`, `/token`, `/revoke`. È la macchina (ChatGPT).
//
// Sono due hostname diversi, con due protezioni diverse (Cloudflare Access contro OAuth+PKCE),
// e non si sostituiscono l'uno con l'altro: un errore sulla dashboard non deve poter aprire la
// porta della macchina, e viceversa.

export const MODES = ['tailscale', 'cloudflare'];

/**
 * Un hostname, non un indirizzo: niente schema, niente percorso, niente porta.
 * `https://cc.esempio.com/` è un errore da correggere, non qualcosa da normalizzare in silenzio —
 * chi lo scrive deve sapere cosa va in quel campo.
 */
export function checkHostname(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, reason: 'the address is missing' };
  if (/[/\s]/.test(raw)) return { ok: false, reason: 'write the hostname only, without https:// and without paths' };
  if (raw.includes(':')) return { ok: false, reason: 'no port: the tunnel decides the port (443)' };
  if (raw.startsWith('.') || raw.endsWith('.') || raw.includes('..')) return { ok: false, reason: 'invalid hostname' };
  // Un'etichetta per pezzo, almeno due pezzi: `cc.esempio.com` sì, `localhost` no (per quello non
  // serve un tunnel), e niente underscore, che nei certificati non è ammesso.
  const labels = raw.split('.');
  if (labels.length < 2) return { ok: false, reason: 'a full domain is required, for example cc.yourdomain.com' };
  const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (!labels.every((part) => label.test(part))) return { ok: false, reason: 'invalid hostname' };
  return { ok: true, host: raw.toLowerCase() };
}

/** Un'origine `https://host`, per il controllo che il websocket fa sulle connessioni da fuori. */
export const originFor = (host) => `https://${host}`;

/**
 * Un hostname ridotto alla forma con cui si confronta: minuscolo, senza porta, senza il punto
 * finale.
 *
 * Il punto finale conta più di quanto sembri: `mcp.esempio.com.` è lo **stesso** nome di
 * `mcp.esempio.com` — il DNS lo accetta, e un tunnel può inoltrarlo così — ma il confronto fra
 * stringhe no. Se le due parti non normalizzano allo stesso modo, il guard sull'host non
 * scatta, e non scatta **in silenzio**: il difetto si presenta come «la funzione non è attiva»,
 * che è il modo peggiore di non funzionare.
 *
 * Per questo la normalizzazione sta qui e non in tre posti: `config.mcpHost`, il guard sulle
 * richieste e quello sul websocket devono ridurre allo stesso modo, o il confronto è una
 * scommessa. (Trovato da una revisione di sicurezza: `config` toglieva gli spazi e le maiuscole,
 * gli altri due anche il punto e la porta.)
 */
export function normalizeHost(value) {
  return String(value ?? '').trim().toLowerCase().split(':')[0].replace(/\.$/, '');
}

/**
 * Un'origine dichiarata a mano (`CR_PUBLIC_ORIGIN`) può contenere **più** indirizzi, separati da
 * `;` o da spazi: con Tailscale *e* Cloudflare accesi insieme, il browser arriva da due origini
 * diverse, e accettarne una sola vorrebbe dire che dall'altra la pagina si apre ma resta muta.
 *
 * @returns {string[]} origini valide, normalizzate (senza barra finale)
 */
export function parseOrigins(value) {
  return String(value ?? '')
    .split(/[;\s]+/)
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .filter((entry) => {
      try {
        const parsed = new URL(entry);
        return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && Boolean(parsed.hostname);
      } catch {
        return false;
      }
    })
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

/**
 * Le origini che il websocket accetta davvero.
 *
 * In **single-host** ci si aggiunge l'hostname pubblico da sé, e non per comodità: quell'hostname
 * lo serve questo server, e il guard sull'`Host` lo tiene — quindi è nostro quanto lo è
 * `127.0.0.1`. Senza questa riga la pagina si aprirebbe e resterebbe **muta** (403 sull'upgrade),
 * che è il modo di sbagliare che `docs/PHONE.md` chiama «sembra rotto mentre è solo zittito».
 *
 * Non è una concessione: l'elenco resta chiuso, e fuori da queste origini il websocket rifiuta
 * come prima. È la stessa regola, con dentro anche la porta da cui adesso si entra davvero.
 *
 * @param {{publicOrigins?: string[], mcpHost?: string, singleHost?: boolean}} config
 * @returns {string[]}
 */
export function acceptedOrigins({ publicOrigins = [], mcpHost = '', singleHost = false } = {}) {
  const origini = [...publicOrigins];
  if (singleHost && mcpHost) {
    const suo = originFor(mcpHost);
    if (!origini.some((voce) => voce.toLowerCase() === suo.toLowerCase())) origini.push(suo);
  }
  return origini;
}

/**
 * Che cosa vuol dire, in variabili d'ambiente, avere scelto una modalità.
 *
 * @param {object} input
 * @param {'tailscale'|'cloudflare'} input.mode
 * @param {string} [input.tailscaleHost]   l'hostname della tailnet (es. `pc-xxx.tailYYY.ts.net`)
 * @param {string} [input.dashboardHost]   il dominio della dashboard, per Cloudflare
 * @param {string} [input.mcpHost]         l'hostname dell'endpoint MCP (può essere un altro)
 * @param {number} [input.port]
 * @returns {{ok: boolean, reason?: string, env: object, needs: Array<object>}}
 */
export function planAccess({ mode, tailscaleHost = '', dashboardHost = '', mcpHost = '', port = 4310 } = {}) {
  const env = {};
  const needs = [];

  if (mode === 'tailscale') {
    const checked = checkHostname(tailscaleHost);
    if (!checked.ok) return { ok: false, reason: `Tailscale: ${checked.reason}`, env, needs };
    env.CR_PUBLIC_ORIGIN = originFor(checked.host);
    needs.push({
      what: 'Tailscale Serve',
      command: `tailscale serve --bg --https=443 http://127.0.0.1:${port}`,
      why: 'exposes the server inside your tailnet only: no domain, no open internet',
    });
    needs.push({
      what: 'the `tailscale` command',
      command: 'tailscale status',
      why: 'it must answer: otherwise Serve does not start',
    });
    return { ok: true, env, needs };
  }

  if (mode === 'cloudflare') {
    const dashboard = checkHostname(dashboardHost);
    if (!dashboard.ok) return { ok: false, reason: `Cloudflare: ${dashboard.reason}`, env, needs };
    const machine = mcpHost ? checkHostname(mcpHost) : { ok: true, host: '' };
    if (!machine.ok) return { ok: false, reason: `Cloudflare: endpoint MCP: ${machine.reason}`, env, needs };
    if (machine.host && machine.host === dashboard.host) {
      return { ok: false, reason: 'the dashboard and the MCP endpoint must be on two different hostnames: they are two surfaces with two different protections', env, needs };
    }

    env.CR_PUBLIC_ORIGIN = originFor(dashboard.host);
    env.CR_DASHBOARD_HOST = dashboard.host;
    needs.push({
      what: 'the tunnel',
      command: `cloudflared tunnel --url http://127.0.0.1:${port}`,
      why: 'carries traffic from your domain to this server, without opening ports at home',
    });
    needs.push({
      what: 'Cloudflare Access in front of the dashboard',
      command: `(Cloudflare dashboard) Access → Applications → Self-hosted → ${dashboard.host}`,
      why: '**mandatory**: it is the only thing standing in front of the dashboard. Policy: Allow only your identity; no Bypass on this hostname.',
    });
    needs.push({
      what: 'a DNS record pointing at the tunnel',
      command: `cloudflared tunnel route dns <tunnel-name> ${dashboard.host}`,
      why: 'without it the domain goes nowhere',
    });

    if (machine.host) {
      env.CR_MCP_HOST = machine.host;
      env.CR_ISSUER_URL = originFor(machine.host);
      env.CR_RESOURCE_URL = `${originFor(machine.host)}/mcp`;
      needs.push({
        what: 'Access: Bypass on the machine routes',
        command: `(Cloudflare dashboard) Access → Applications → ${machine.host}: Bypass on /.well-known/* /mcp /register /token /revoke, Allow on the rest`,
        why: 'a machine cannot log in: without the Bypass, ChatGPT gets the Access page and the connection never starts',
      });
    } else {
      needs.push({
        what: 'the MCP endpoint (only if you want to connect ChatGPT)',
        command: 'wra access cloudflare ... --mcp mcp.yourdomain.com',
        why: 'without it the MCP bridge stays off and everything else still works',
      });
    }
    return { ok: true, env, needs };
  }

  return { ok: false, reason: `unknown mode: ${mode} (allowed: ${MODES.join(', ')})`, env, needs };
}

/**
 * Cosa c'è e cosa manca, per `rc doctor` e per `rc access`. Non tocca niente: guarda.
 *
 * @param {object} input
 * @param {object} input.config  la configurazione caricata
 * @param {boolean} [input.tailscaleInstalled]
 * @param {boolean} [input.cloudflaredInstalled]
 */
export function reviewAccess({ config, tailscaleInstalled = false, cloudflaredInstalled = false } = {}) {
  const rows = [];
  const origins = config.publicOrigins ?? parseOrigins(config.publicOrigin);
  const add = (ok, what, detail) => rows.push({ ok, what, detail });

  add(true, 'server', `listening on ${config.host}:${config.port} (loopback)`);
  add(origins.length > 0, 'dashboard from outside',
    origins.length ? `accepted from: ${origins.join(' · ')}` : 'off: reachable from this machine only');
  if (config.dashboardHost) {
    add(true, 'dashboard hostname', `${config.dashboardHost} (the machine routes do not exist there)`);
  }

  const mcpOn = Boolean(config.issuerUrl && config.resourceUrl);
  add(true, 'MCP bridge', mcpOn ? `up, resources at ${config.resourceUrl}` : 'down (CR_ISSUER_URL/CR_RESOURCE_URL missing)');
  if (mcpOn) {
    add(Boolean(config.mcpHost), 'MCP endpoint on its own hostname',
      config.mcpHost ? `${config.mcpHost}: only OAuth and /mcp exist there` : 'no CR_MCP_HOST: the surface lock is not active');
    // Il confronto è fra **hostname**: le origini sono indirizzi interi (`https://x`), l'endpoint
    // è un nome. Confrontarli direttamente non segnalerebbe mai niente — cioè la sovrapposizione
    // passerebbe in silenzio, ed è esattamente il caso che questo controllo esiste per vedere.
    const hosts = origins.map((origin) => {
      try {
        return new URL(origin).hostname;
      } catch {
        return '';
      }
    });
    if (config.mcpHost && hosts.includes(config.mcpHost)) {
      add(false, 'surface separation', `the dashboard and the MCP endpoint are on the same hostname (${config.mcpHost}): the endpoint would lose the extra protection it has`);
    }
  }

  add(tailscaleInstalled, '`tailscale`', tailscaleInstalled ? 'installed' : 'not found on the PATH (only needed for Tailscale mode)');
  add(cloudflaredInstalled, '`cloudflared`', cloudflaredInstalled ? 'installed' : 'not found on the PATH (only needed for Cloudflare mode)');
  return rows;
}

/**
 * Dallo stato salvato (`~/.cc-remote/access.json`) alle variabili che il server capisce.
 *
 * Le due modalità possono essere accese insieme: la tailnet per il telefono e il dominio per il
 * browser sono due strade, non due alternative. Quindi le origini ammesse sono l'**unione** di
 * quelle accese — accettarne una sola vorrebbe dire che dall'altra parte la pagina si apre e
 * resta muta, che è il modo peggiore di rompersi.
 *
 * I campi vuoti non sono errori: vogliono dire «non ho niente da dire», e chi chiama li usa solo
 * per riempire i buchi che l'ambiente non ha già riempito.
 */
export function accessDefaults(state) {
  const origins = [];
  const defaults = { publicOrigin: '', dashboardHost: '', mcpHost: '', issuerUrl: '', resourceUrl: '' };

  if (state?.tailscale?.origin) origins.push(state.tailscale.origin);
  if (state?.cloudflare?.dashboard) origins.push(originFor(state.cloudflare.dashboard));
  defaults.publicOrigin = origins.join(';');

  if (state?.cloudflare?.dashboard) defaults.dashboardHost = state.cloudflare.dashboard;
  if (state?.cloudflare?.mcp) {
    defaults.mcpHost = state.cloudflare.mcp;
    defaults.issuerUrl = originFor(state.cloudflare.mcp);
    defaults.resourceUrl = `${originFor(state.cloudflare.mcp)}/mcp`;
  }
  return defaults;
}
