// Il pannello: stato, accesso da fuori, conversazioni, copie di sicurezza, impostazioni.
//
// Sta in un file suo perché è un'applicazione dentro l'applicazione, e perché la parte delicata —
// ripristinare, chiudere un processo, cambiare l'accesso — si legge meglio tutta insieme. Le
// primitve (nodi, icone, rete, finestre) arrivano da fuori: `app.js` le ha già, e importarle qui
// sarebbe un giro circolare fra due file che si conoscono.
//
// Regole che valgono per tutto quello che c'è sotto:
//
//  * **niente pulsanti finti**: ogni cosa che si preme chiama una rotta vera, e se la rotta dice
//    di no si vede il perché. Nessun messaggio di successo prima dell'esito;
//  * **il numero prima del pulsante**: «archivia 12» e «ripristina» dicono quante conversazioni
//    prendono **prima** di essere premuti;
//  * **niente segreti**: quello che si mostra viene dalle risposte del server, che non contengono
//    token (c'è una prova che lo verifica);
//  * **si dice cosa non si sa**: se una verifica non è stata fatta, quella riga non diventa verde.
//
// La forma, dopo l'audit di M9:
//
//  * **navigazione secondaria a sinistra**, e **una sezione per volta**: quattro sezioni impilate in
//    una colonna sola erano quattro intestazioni che scorrevano via insieme al contenuto, e per
//    cambiare sezione bisognava risalire;
//  * **una colonna di lettura sola**: prima il titolo stava a 520px, la tabella a 1060 e le schede a
//    1425 — tre misure nella stessa schermata. Adesso il contenuto sta in una misura e il testo
//    dentro quella tiene 65–75 caratteri;
//  * **una riga quando basta**: le spiegazioni che servono una volta sola stanno dietro un
//    «perché…», che si apre quando si vuole. Un paragrafo lungo davanti a chi passa è una tassa su
//    ogni visita;
//  * **la diagnostica non occupa la schermata principale**: i controlli, il log e i percorsi dei
//    file stanno dentro «Diagnostica avanzata», chiuso. C'è quando serve, non prima.
import { howMany } from '/core/format.mjs';

/**
 * @param {object} input
 * @param {HTMLElement} input.into
 */
export function createAdmin({ into, h, icon, api, ask, toast, fill, tokenOf }) {
  const SECTIONS = [
    { id: 'stato', label: 'Stato', icon: 'info' },
    { id: 'accesso', label: 'Accesso', icon: 'arrowUpRight' },
    { id: 'conversazioni', label: 'Conversazioni', icon: 'chat' },
    { id: 'copie', label: 'Copie', icon: 'archive' },
    { id: 'impostazioni', label: 'Impostazioni', icon: 'sort' },
  ];

  let section = 'stato';
  let snapshot = null;
  let deep = null;
  let processes = null;
  let backups = null;
  let access = null;
  let settings = null;
  let busy = null;
  let error = null;
  let loading = false;

  const number = (value) => (value === null || value === undefined ? '—' : String(value));

  /** Il nome del file che il server ha detto di usare, dal `content-disposition`. */
  const filenameOf = (header) => /filename="([^"]+)"/.exec(String(header ?? ''))?.[1] ?? null;

  /**
   * Scaricare un file **senza mettere il token nell'indirizzo**. Si chiede con l'intestazione,
   * come tutto il resto, e si consegna il risultato come file.
   *
   * Perché non `window.location = '…?token=…'`: quell'indirizzo finisce nei log del proxy (su un
   * tunnel ci passa tutto), nella cronologia dei download del browser e in ogni riga che lo
   * stampa. La serratura è una sola, e non va lasciata in giro per comodità.
   */
  async function download(route, fallbackName) {
    const response = await fetch(route, { headers: { 'x-cc-remote-token': tokenOf() } });
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new Error(problem?.error ?? `errore ${response.status}`);
    }
    const name = filenameOf(response.headers.get('content-disposition')) ?? fallbackName;
    const url = URL.createObjectURL(await response.blob());
    const link = h('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  }

  /** Una riga di controllo: `ok` verde, `no` rosso, e il dettaglio sempre scritto. */
  const checkRow = (check) => h('li.check', { dataset: { ok: String(Boolean(check.ok)) } },
    icon(check.ok ? 'check' : 'alert', { size: 15 }),
    h('span.what', { text: check.name }),
    h('span.detail', { text: check.detail }),
  );

  // Un **registro**, non una griglia di riquadri. Sei riquadri uguali con il numero grande e
  // l'etichetta piccola sotto non dicono cosa significano i numeri né se vanno bene — e
  // «1 processi accesi» è sgrammaticato per costruzione, perché l'etichetta non si accorda con il
  // valore. Una riga per fatto: il nome a sinistra, il valore in monospaziato, e **cosa vuol
  // dire** accanto. Si legge dall'alto in basso come si legge uno strumento.
  const ledgerRow = (label, value, hint = null) => h('div.ledger-row', {},
    h('span.what', { text: label }),
    h('span.value', { text: number(value) }),
    h('span.hint', { text: hint ?? '' }),
  );

  /** Un blocco con un titolo: è la forma di tutto il pannello. */
  const block = (title, ...children) => h('section.block', {},
    h('h3', { text: title }),
    ...children,
  );

  /**
   * Quello che serve sapere **una volta** — cosa contiene una copia, perché serve un riavvio —
   * sta chiuso dietro un «perché». Non è testo tolto: è testo spostato dove lo si va a cercare,
   * invece che davanti a ogni visita.
   */
  const perche = (summary, ...children) => h('details.perche', {},
    h('summary', {}, icon('chevronRight', { size: 14, className: 'chev' }), h('span', { text: summary })),
    h('div.spiega', {}, ...children),
  );

  /**
   * Il testo di una nota, con **due soli segni**: `` `codice` `` e `**enfasi**`.
   *
   * Non è un parser di markdown, ed è di proposito: `core/markdown.mjs` esiste per i messaggi
   * dell'agente, e usarlo qui vorrebbe dire che una nota dell'interfaccia può contenere qualunque
   * cosa sia passata di lì. Ma i due segni che servono servono davvero — senza,
   * `**non tocca il transcript**` si legge con gli asterischi in mezzo, e `` `~/.cc-remote` `` come
   * una riga di simboli.
   */
  const inlina = (text) => String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map((pezzo) => {
    if (pezzo.length > 2 && pezzo.startsWith('`') && pezzo.endsWith('`')) return h('code', { text: pezzo.slice(1, -1) });
    if (pezzo.length > 4 && pezzo.startsWith('**') && pezzo.endsWith('**')) return h('strong', { text: pezzo.slice(2, -2) });
    return pezzo;
  });

  const note = (text) => h('p.note', {}, ...inlina(text));

  /** La riga dei pulsanti: vanno a capo insieme invece di uscire dalla piega. */
  const btnRow = (...children) => h('div.btn-row', {}, ...children);

  const action = (label, run, { kind = '', title = null, iconName = null, disabled = false } = {}) => {
    const button = h(`button.btn${kind ? `.${kind}` : ''}`, {
      type: 'button',
      title: title ?? label,
      disabled: disabled || undefined,
      onclick: async () => {
        if (busy) return;
        busy = label;
        error = null;
        paint();
        try {
          await run();
        } catch (problem) {
          error = problem.message;
          toast(problem.message, 'danger');
        } finally {
          busy = null;
          paint();
        }
      },
    }, iconName ? icon(iconName, { size: 15 }) : null, h('span', { text: label }));
    return button;
  };

  // ── caricamenti ────────────────────────────────────────────────────────────────────────────
  const loadStatus = async () => {
    snapshot = await api('/local/admin/status');
    return snapshot;
  };
  const loadProcesses = async () => {
    processes = await api('/local/admin/processes');
    return processes;
  };
  const loadBackups = async () => {
    backups = await api('/local/admin/backups');
    return backups;
  };
  const loadAccess = async () => {
    access = await api('/local/admin/access');
    return access;
  };
  const loadSettings = async () => {
    settings = await api('/local/admin/settings');
    return settings;
  };

  /** Tutto quello che serve alla sezione aperta. Si ricarica dopo ogni azione. */
  async function load() {
    await loadStatus();
    if (section === 'accesso') await loadAccess();
    if (section === 'copie') await loadBackups();
    if (section === 'impostazioni') await loadSettings();
    if (section === 'stato') await loadProcesses();
    // La riconciliazione **non** si carica da sé: legge centinaia di transcript, e la si chiede
    // premendo «Analizza adesso». Aprire la sezione non deve far partire una scansione.
  }
  // ── stato ──────────────────────────────────────────────────────────────────────────────────
  function statoView() {
    const status = snapshot?.status;
    const setup = snapshot?.setup;
    const facts = snapshot?.checks ?? [];
    const box = h('div.admin-section');

    if (setup && !setup.complete) {
      box.append(block('Primo avvio',
        note('Mancano alcune cose perché WRA sia a posto. Si fanno da qui, una per volta.'),
        h('ul.steps', {}, ...setup.steps.map((step) => h('li.step', { dataset: { ok: String(step.ok) } },
          icon(step.ok ? 'checkCircle' : 'alert', { size: 16 }),
          h('div', {}, h('strong', { text: step.what }), h('span.detail', { text: step.detail })),
        ))),
      ));
    }

    box.append(block('Adesso',
      h('div.ledger', {},
        ledgerRow('conversazioni', status?.sessions.total,
          `${status?.sessions.byState.ready ?? 0} pronte · ${status?.sessions.byState.busy ?? 0} occupate · ${status?.sessions.archived ?? 0} archiviate · ${status?.sessions.imported ?? 0} importate`),
        // I due numeri che contano davvero per la sicurezza stavano in fondo a una frase di
        // contorno. Sono due righe, e stanno in mezzo alle altre: si guardano.
        ledgerRow('con i permessi saltati', status?.sessions.bypass ?? 0, 'l\'agente non chiede il permesso prima di agire'),
        ledgerRow('esposte a un client esterno', status?.sessions.exposed ?? 0, 'ChatGPT può parlarci, via MCP'),
        ledgerRow('processi accesi', status?.processes.length, 'davvero gestiti da questo server'),
        ledgerRow('progetti', status?.projects, 'cartelle registrate'),
        ledgerRow('ponte MCP', status?.mcp.enabled ? 'acceso' : 'spento', status?.mcp.host ?? 'solo questa macchina'),
      ),
      // Le tre righe che si guardano di rado — chi è collegato, che versione, da quanto è acceso —
      // stanno dietro il «perché»: sono la stessa tabella, ma non sono le prime sei che si leggono.
      perche('Dettagli del server',
        h('div.ledger', {},
          ledgerRow('collegamenti', status?.connections?.clients ?? 0, 'finestre collegate a questo server'),
          ledgerRow('versione', status?.version, `node ${status?.node ?? ''}`),
          ledgerRow('in funzione da', `${Math.round((status?.uptimeS ?? 0) / 60)} min`, 'da quando è stato acceso'),
        )),
    ));

    box.append(block('Processi',
      processes === null
        ? note('leggo…')
        : h('div', {},
          processList('accesi adesso', processes.managed, null),
          processList('rimasti dopo uno spegnimento forzato', processes.orphans, 'kill'),
          processList('aperti da un\'altra finestra', processes.windows, null),
          processList('righe da togliere', processes.gone, 'forget'),
          processes.foreign?.length
            ? note(`${processes.foreign.length} processi con una conversazione assegnata che non è di questo registro (un altro rig, una prova): non si toccano.`)
            : null,
          processes.scanned ? null : note(processes.note),
          processListVoid(processes)),
      btnRow(action('Rileggi i processi', async () => { await loadProcesses(); }, { iconName: 'refresh' })),
    ));

    // La diagnostica: quello che serve quando qualcosa non va, non quello che si guarda ogni
    // giorno. Chiusa, ma a un clic — e dice già nel titolo se c'è qualcosa che non va.
    const rotti = facts.filter((check) => !check.ok).length;
    box.append(perche(`Diagnostica avanzata — ${facts.length} controlli${rotti ? `, ${rotti} da guardare` : ', tutti a posto'}`,
      h('ul.checks', {}, ...facts.map(checkRow)),
      deep ? h('ul.checks', {}, ...deep.map(checkRow)) : null,
      btnRow(action('Ricontrolla tutto', async () => {
        const result = await api('/local/admin/check', { method: 'POST', body: { lines: 40 } });
        deep = [...result.facts, ...result.deep];
        snapshot.log = result.log;
      }, { iconName: 'shield' })),
      snapshot?.log?.lines?.length
        ? perche(`ultime ${snapshot.log.lines.length} righe di log (su ${snapshot.log.total})`,
          h('pre', { text: snapshot.log.lines.join('\n') }))
        : null,
      perche('Dove stanno le cose',
        h('ul.paths', {}, ...Object.entries(snapshot?.paths ?? {}).map(([what, where]) => h('li',
          h('span.what', { text: what }),
          h('code', { text: where }),
        )))),
    ));

    box.append(block('Il server',
      btnRow(
        action('Riavvia il server', async () => {
          const ok = await ask({
            title: 'Riavviare il server?',
            message: 'Le conversazioni restano; i loro processi si spengono e ripartono quando le riapri. Questa pagina si riconnette da sola.',
            confirmLabel: 'riavvia',
          });
          if (!ok) return;
          await api('/local/admin/restart', { method: 'POST', body: { confirm: 'riavvia' } });
          toast('il server si sta riavviando: questa pagina si riconnetterà da sola');
        }, { kind: 'btn-danger', iconName: 'power' }),
        action('Esporta la diagnosi', async () => {
          const name = await download('/local/admin/export', 'wra-diagnostics.json');
          toast(`diagnosi scaricata: ${name}`);
        }, { iconName: 'download' }),
      ),
      perche('Cosa comporta un riavvio',
        note('Il riavvio spegne i terminali delle conversazioni aperte: restano nel registro e si riprendono quando le riapri. Serve dopo un ripristino o un cambiamento di impostazioni, che si leggono all\'avvio.')),
    ));

    return box;
  }

  /** Quando il server non ha potuto guardare i processi, lo dice: una lista vuota mentirebbe. */
  function processListVoid(all) {
    if (all.managed?.length || all.orphans?.length || all.windows?.length || all.gone?.length) return null;
    return note(all.scanned ? 'Nessun processo acceso adesso.' : 'Non ho potuto leggere i processi.');
  }

  function processList(title, rows, kind) {
    if (!rows?.length) return null;
    return h('div.proc-group', {},
      h('h4', { text: `${title} (${rows.length})` }),
      h('ul.procs', {}, ...rows.map((row) => h('li.proc', {},
        h('span.pid', { text: row.pid ? String(row.pid) : '—' }),
        h('span.name', { text: row.name ?? row.sessionId?.slice(0, 8) ?? '—' }),
        h('span.why', { text: row.why }),
        kind === 'kill'
          ? action('Chiudi', async () => {
            const ok = await ask({
              title: `Chiudere il processo ${row.pid}?`,
              message: `Sta lavorando «${row.name ?? row.sessionId?.slice(0, 8)}» e il server non lo sta più seguendo. Chiuderlo non tocca la conversazione né il transcript: è il processo rimasto da uno spegnimento forzato.`,
              confirmLabel: 'chiudi',
              danger: true,
            });
            if (!ok) return;
            await api('/local/admin/processes/kill', { method: 'POST', body: { pid: row.pid, sessionId: row.sessionId, confirm: String(row.pid) } });
            await loadProcesses();
          }, { kind: 'btn-danger', iconName: 'trash', title: `chiudi il processo ${row.pid}` })
          : kind === 'forget'
            ? action('Togli la riga', async () => {
              await api('/local/admin/processes/forget', { method: 'POST', body: { pid: row.pid } });
              await loadProcesses();
            }, { kind: 'btn-quiet', iconName: 'close', title: `togli la riga del pid ${row.pid}` })
            : null,
      ))),
    );
  }

  // Quello che si sta scrivendo nei campi del pannello, per chiave. Il pannello si aggiorna da sé
  // ogni cinque secondi e ridisegna i campi dal valore salvato: senza questa memoria, un hostname
  // (o una cartella) digitato a metà spariva sotto le dita e il pulsante accanto ne salvava un
  // altro. La bozza vince sul valore salvato; chi cancella il campo scrive una bozza vuota.
  const bozze = new Map();
  const campo = (chiave, props) => h('input', {
    ...props,
    dataset: { bozza: chiave },
    value: bozze.get(chiave) ?? props.value ?? '',
    oninput: (event) => bozze.set(chiave, event.target.value),
  });

  // ── accesso da fuori ───────────────────────────────────────────────────────────────────────
  function accessoView() {
    const box = h('div.admin-section');
    const saved = access?.saved ?? {};
    const installs = access?.installs ?? {};
    const modes = [saved.tailscale && 'Tailscale', saved.cloudflare && 'Cloudflare'].filter(Boolean);

    // Il primo blocco risponde a una domanda sola — *da dove si entra adesso* — e la risponde in
    // una riga. I controlli che l'hanno stabilita e i dettagli della configurazione stanno dietro
    // il «perché», che è dove si vanno a cercare quando servono.
    box.append(block('Da dove si entra adesso',
      note(modes.length
        ? `Modalità scelta: ${modes.join(' + ')}. Si applica all'avvio: ${access?.effective?.publicOrigins?.join(' · ') || 'nessuna origine pubblica attiva'}.`
        // Il caso vero di chi ha già configurato tutto a mano: la scelta sta nelle variabili
        // d'ambiente (o negli alias), non in questo file. Dire «nessuna modalità» e basta sarebbe
        // falso — e manderebbe a cercare un guasto che non c'è.
        : (access?.effective?.publicOrigins?.length
          ? `Nessuna modalità salvata: si entra da ${access.effective.publicOrigins.join(' · ')}, che arriva dall'ambiente. Le variabili vincono sempre su questo pannello.`
          : 'Nessuna modalità scelta: si entra solo da questa macchina. È il modo più sicuro, e si cambia quando serve.')),
      // La verifica sta **visibile**: è un'azione, e un'azione dentro un cassetto chiuso non si
      // trova. Quello che dice, quando ha qualcosa da dire, compare qui sotto.
      btnRow(action('Verifica adesso', async () => {
        verification = await api('/local/admin/access/verify', { method: 'POST', body: {} });
      }, { iconName: 'shield' })),
      verification
        ? h('div', {},
          note(`${verification.verdict} (${new Date(verification.at).toLocaleString('it-IT')})`),
          ...verification.targets.map((target) => h('div.verify', {},
            h('h4', {}, h('code', { text: target.origin }), h('span.chip', { text: target.role === 'mcp' ? 'endpoint macchina' : 'dashboard' })),
            h('ul.checks', {}, ...target.checks.map((row) => checkRow({ ...row, name: row.what }))),
          )))
        : null,
      perche('Cosa è stato controllato',
        h('ul.checks', {}, ...(access?.review ?? []).map((row) => checkRow({ ...row, name: row.what }))),
        access?.installs?.tailscaleStatus?.host ? note(`Questa macchina nella tailnet è ${access.installs.tailscaleStatus.host}.`) : null,
        access?.serve ? note(`\`tailscale serve\`: ${access.serve.configured ? 'configurato' : 'non configurato'}. ${access.serve.text ?? ''}`) : null),
    ));

    // Si possono tenere insieme — la tailnet per il telefono, un dominio per il browser — e
    // vederle affiancate è quello che le rende confrontabili. Una sola azione principale per
    // scheda: «Applica la scelta».
    box.append(block('Scegli la modalità',
      h('div.mode-grid', {}, modeForm('tailscale'), modeForm('cloudflare')),
      saved.tailscale || saved.cloudflare
        ? btnRow(
          saved.tailscale ? action('Rimuovi Tailscale', () => removeMode('tailscale'), { kind: 'btn-danger' }) : null,
          saved.cloudflare ? action('Rimuovi Cloudflare', () => removeMode('cloudflare'), { kind: 'btn-danger' }) : null,
        )
        : null,
    ));

    // Dal telefono: solo se c'è un indirizzo da aprire. Un blocco che dice «niente» è un blocco
    // che si impara a saltare — e allora tanto vale non metterlo.
    const origins = access?.effective?.publicOrigins ?? [];
    if (origins.length) {
      box.append(block('Dal telefono',
        note('È lo stesso server: si vede la stessa cosa che vedi qui.'),
        h('ul.paths', {}, ...origins.map((origin) => h('li', {},
          h('code', { text: origin }),
          h('button.btn', {
            type: 'button',
            title: 'copia l\'indirizzo',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(origin);
                toast('indirizzo copiato');
              } catch {
                toast('non riesco a copiare da qui', 'danger');
              }
            },
          }, icon('copy', { size: 14 }), h('span', { text: 'copia' })),
        ))),
        perche('Il primo accesso dal telefono',
          note('Il token si chiede una volta sola: sta in ~/.cc-remote/token, e «wra start» dice dove. È l\'unico momento in cui serve scriverlo a mano.')),
      ));
    }

    box.append(perche('Sul sistema, e il connettore di ChatGPT',
      h('ul.checks', {},
        checkRow({ ok: Boolean(installs.tailscale), name: '`tailscale`', detail: installs.tailscale ? 'installato' : 'non trovato nel PATH' }),
        checkRow({ ok: Boolean(installs.cloudflared), name: '`cloudflared`', detail: installs.cloudflared ? (installs.cloudflaredVersion ?? 'installato') : 'non trovato nel PATH' }),
      ),
      note('Il tunnel Cloudflare e le regole Access si configurano dal pannello Cloudflare: questa pagina prepara i comandi e poi verifica che siano stati eseguiti, non li esegue al posto tuo.'),
      note('Per collegare ChatGPT serve l\'hostname della **macchina** (quello dell\'endpoint MCP), non quello della dashboard: lì Access deve lasciar passare la macchina e fermare le persone. I comandi e le regole esatte stanno in docs/CHATGPT.md.'),
    ));

    return box;
  }

  let verification = null;
  let plan = null;
  let onRestored = null;

  /** Un piano: cosa verrà scritto, e cosa va fatto a mano una volta. */
  function planView(result) {
    if (!result.ok) return h('p.note.danger', { text: result.reason });
    return h('div', {},
      h('p.note', { text: 'Cosa verrà scritto (in ~/.cc-remote/access.json):' }),
      h('pre', { text: Object.entries(result.env).map(([key, value]) => `${key}=${value}`).join('\n') || '(niente)' }),
      h('p.note', { text: 'E cosa va fatto a mano, una volta:' }),
      h('ol.todo', {}, ...result.needs.map((need) => h('li', {},
        h('strong', { text: need.what }),
        h('code', { text: need.command }),
        h('span.detail', { text: need.why }),
      ))),
    );
  }

  /**
   * Il modulo di una modalità: i campi, il piano (i comandi esatti) **prima** del pulsante, e
   * l'applicazione con la conferma che ripete l'oggetto.
   *
   * Compatto: i campi stanno larghi quanto un hostname, non quanto la scheda, e i tre pulsanti
   * vanno a capo invece di uscire dalla piega.
   */
  function modeForm(mode) {
    const isTailscale = mode === 'tailscale';
    const first = campo(isTailscale ? 'tailscale' : 'cloudflare-dashboard', {
      type: 'text',
      'aria-label': isTailscale ? 'hostname della tailnet' : 'dominio della dashboard',
      placeholder: isTailscale ? 'pc-mio.tail1234.ts.net' : 'cc.miodominio.com',
      // Si parte da quello che c'è: chi ha già scelto una volta ritrova il suo indirizzo qui.
      value: isTailscale
        ? (access?.installs?.tailscaleStatus?.host ?? access?.saved?.tailscale?.host ?? '')
        : (access?.saved?.cloudflare?.dashboard ?? ''),
    });
    const second = isTailscale ? null : campo('cloudflare-mcp', {
      type: 'text',
      'aria-label': 'hostname dell\'endpoint MCP',
      placeholder: 'mcp.miodominio.com',
      value: access?.saved?.cloudflare?.mcp ?? '',
    });
    // Il piano vive nello **stato** del pannello, non in un nodo qui dentro: il pannello si
    // ridisegna quando un'azione finisce, e un nodo scritto a mano in quel momento resterebbe
    // staccato dalla pagina — cioè invisibile, che è come si presenta questo difetto.
    const showPlan = async () => {
      const result = await api('/local/admin/access/plan', {
        method: 'POST',
        body: isTailscale
          ? { mode, tailscaleHost: first.value.trim() }
          : { mode, dashboardHost: first.value.trim(), mcpHost: second.value.trim() },
      });
      plan = { ...result, mode };
      paint();
      return result;
    };

    const planBox = h('div.plan', {}, plan?.mode === mode ? planView(plan) : null);

    return h('div.mode', {},
      h('h4', { text: isTailscale ? 'Tailscale' : 'Cloudflare Tunnel' }),
      note(isTailscale
        ? 'Solo dentro la tua tailnet: nessun dominio, niente aperto su internet.'
        : 'Un tuo dominio, con Cloudflare Access obbligatorio davanti alla dashboard.'),
      h('div.field-row', {}, h('div.field', {}, first), second ? h('div.field', {}, second) : null),
      btnRow(
        action('Prepara i comandi', showPlan, { kind: 'btn-quiet', iconName: 'info' }),
        action('Applica la scelta', async () => {
          const result = await showPlan();
          if (!result.ok) throw new Error(result.reason);
          const ok = await ask({
            title: isTailscale ? 'Applicare Tailscale?' : 'Applicare Cloudflare?',
            message: 'Si scrive la scelta e si applica al prossimo avvio. I comandi qui sopra restano da eseguire a mano: questa pagina non tocca tunnel, DNS né regole Access.',
            confirmLabel: 'applica',
          });
          if (!ok) return;
          await api('/local/admin/access/apply', {
            method: 'POST',
            body: {
              mode,
              ...(isTailscale ? { tailscaleHost: first.value.trim() } : { dashboardHost: first.value.trim(), mcpHost: second.value.trim() }),
              confirm: `applica ${mode}`,
            },
          });
          await loadAccess();
          toast('scelta salvata: si applica al prossimo avvio del server');
        }, { kind: 'btn-primary', iconName: 'check' }),
        isTailscale
          ? action('Esegui `tailscale serve`', async () => {
            const ok = await ask({
              title: 'Eseguire `tailscale serve`?',
              message: `Verrà eseguito: tailscale serve --bg --https=443 http://127.0.0.1:${location.port || 4310}. Espone questo server alla tua tailnet su HTTPS. Puoi toglierlo con lo stesso comando e --off.`,
              confirmLabel: 'esegui',
              danger: true,
            });
            if (!ok) return;
            const result = await api('/local/admin/access/serve', { method: 'POST', body: { confirm: 'serve' } });
            toast(result.output?.slice(0, 120) || 'fatto');
            await loadAccess();
          }, { kind: 'btn-quiet', iconName: 'arrowUpRight' })
          : null,
      ),
      planBox,
    );
  }

  async function removeMode(mode) {
    const ok = await ask({
      title: `Togliere ${mode}?`,
      message: 'Si smette di entrare da fuori da quella strada. Le conversazioni non si toccano, e i tunnel che hai configurato restano come sono.',
      confirmLabel: 'rimuovi',
      danger: true,
    });
    if (!ok) return;
    await api('/local/admin/access/remove', { method: 'POST', body: { mode, confirm: `rimuovi ${mode}` } });
    await loadAccess();
    toast('rimosso: si applica al prossimo avvio');
  }

  // ── conversazioni: i due elenchi che non coincidono ──────────────────────────────────────────
  /** Il piano della riconciliazione. Si legge **adesso**: il registro cambia sotto, e un piano di
   *  ieri importerebbe cose che oggi non ci sono più. */
  async function loadConversations() {
    planConversazioni = await api('/local/admin/conversations/plan', { method: 'POST', body: {} });
    // La scelta si riazzera a ogni analisi: tenerla fra due letture diverse vorrebbe dire importare
    // qualcosa che non si è visto.
    scelte = new Set();
    return planConversazioni;
  }

  function conversazioniView() {
    const box = h('div.admin-section');
    const piano = planConversazioni;

    box.append(block('I due elenchi',
      note('Il **registro** dice quali conversazioni WRA conosce, i **transcript** quelle che Claude Code ha scritto. Quando non coincidono, l\'interfaccia ne mostra meno di quante ce ne sono.'),
      btnRow(action('Analizza adesso', async () => { await loadConversations(); }, { kind: piano ? '' : 'btn-primary', iconName: 'search' })),
      piano
        ? h('div.ledger', {},
          ledgerRow('nel registro', piano.counts.registro, 'quante ne conosce WRA'),
          ledgerRow('transcript su disco', piano.counts.trovati, 'quante ne ha scritte Claude Code'),
          ledgerRow('da importare', piano.counts.importabili, 'autentiche, e l\'interfaccia non le mostra'),
          ledgerRow('senza transcript', piano.counts.senzaTranscript, 'usate, e il file non c\'è più: si aprono vuote'),
          ledgerRow('mai usate', piano.counts.maiAperte, 'registrate e mai aperte: il transcript lo scriveranno allora'),
          ledgerRow('non riprendibili', piano.counts.nonRiprendibili, 'il transcript c\'è, ma `--resume` non lo riprende'),
          ledgerRow('duplicati', piano.counts.duplicati, 'lo stesso id in due cartelle: si tiene il più recente'))
        : note('Premi «Analizza adesso»: legge i transcript e li confronta col registro. Non scrive niente.'),
    ));

    if (piano?.importabili.length) {
      const tutte = piano.importabili.map((entry) => entry.sessionId);
      box.append(block(`Da importare (${piano.importabili.length})`,
        note('Importarle **non tocca il transcript** e non avvia nessun processo: restano spente finché non le apri.'),
        h('div.pick-row', {},
          h('button.link-btn', {
            type: 'button',
            onclick: () => { scelte = scelte.size === tutte.length ? new Set() : new Set(tutte); paint(); },
          }, h('span', { text: scelte.size === tutte.length ? 'nessuna' : 'tutte' })),
          h('span.note', { text: `${scelte.size} di ${tutte.length} scelte` })),
        h('ul.backups', {}, ...piano.importabili.map((entry) => importRow(entry))),
        btnRow(
          action(`Importa le scelte (${scelte.size})`, async () => {
            const ids = [...scelte];
            if (!ids.length) throw new Error('non hai scelto nessuna conversazione');
            const ok = await ask({
              title: `Importare ${howMany(ids.length, 'una conversazione', 'conversazioni')}?`,
              message: 'Si scrive una voce nel registro per ognuna: nome, cartella e data vengono dal transcript. '
                + 'Il transcript non si tocca e nessun processo parte. Prima di scrivere, il server mette da parte una copia del registro com\'era.',
              confirmLabel: 'importa',
            });
            if (!ok) return;
            const esito = await api('/local/admin/conversations/import', { method: 'POST', body: { ids, confirm: 'importa' } });
            toast(`importate ${esito.imported.length}${esito.failed.length ? `, ${esito.failed.length} non riuscite` : ''} · copia ${esito.backup}`,
              esito.failed.length ? 'danger' : '');
            await loadConversations();
            if (onRestored) onRestored();
          }, { kind: 'btn-primary', iconName: 'download', disabled: !scelte.size }),
        ),
      ));
    } else if (piano) {
      box.append(block('Da importare',
        note(piano.counts.nonRiprendibili
          ? 'Niente da importare: i transcript che il registro non conosce sono tutti fuori dalle cartelle consentite, o `--resume` non li riprenderebbe. Sono elencati qui sotto con il motivo.'
          : 'Niente da importare: ogni transcript su disco è già nel registro.'),
      ));
    }

    if (piano?.nonRiprendibili.length) {
      box.append(perche(`Non riprendibili (${piano.nonRiprendibili.length})`,
        note('Il transcript c\'è, ma `--resume` non lo riprenderebbe: quasi sempre perché la cartella del progetto non esiste più, o sta fuori dalle cartelle consentite. Importarli darebbe una conversazione che non si apre — e una conversazione che non si apre è peggio di una che non c\'è. Restano dove sono.'),
        h('ul.backups', {}, ...piano.nonRiprendibili.slice(0, 20).map((entry) => h('li.backup', {},
          h('div.who', {},
            h('strong', { text: entry.title ?? '(senza titolo)' }),
            h('span.detail', { text: entry.projectPath }),
            h('span.detail', { text: entry.riprendibile?.reason ?? '' }))))),
      ));
    }

    if (piano?.senzaTranscript.length) {
      box.append(perche(`Nel registro senza il transcript (${piano.senzaTranscript.length})`,
        note('Queste WRA le conosce e sono state **usate** — importate da un transcript che c\'era, o aperte almeno una volta — ma il file non c\'è più: si aprono vuote. Non si toccano e non si cancellano — togliere una voce dal registro non fa tornare il transcript, e il registro è la sola traccia che quella conversazione è esistita.'),
        h('ul.backups', {}, ...piano.senzaTranscript.slice(0, 30).map((entry) => h('li.backup', {},
          h('div.who', {},
            h('strong', { text: entry.name ?? '(senza nome)' }),
            h('span.detail', { text: entry.projectPath ?? '' }),
            entry.transcript ? h('span.detail', { text: entry.transcript }) : null,
          ),
        )))),
      );
    }

    box.append(perche('Perché non si cancella niente',
      note('Togliere una voce dal registro non fa tornare un transcript, e non libera niente: il registro sono poche decine di byte per conversazione. Il modo di perdere il lavoro di qualcuno è decidere che quel lavoro non conta — e questa pagina non lo decide.'),
      note('La copia di sicurezza che si scrive prima di importare resta nell\'elenco della sezione «Copie»: se l\'importazione è sbagliata, si torna indietro da lì.'),
    ));

    return box;
  }

  /**
   * Una riga dell'anteprima, con la sua casella.
   *
   * La casella **non** ridisegna il pannello: ricostruirla porterebbe via il fuoco proprio mentre
   * si sta scegliendo, e il resto della riga finirebbe sul documento. Si aggiornano il numero e il
   * pulsante, che sono le due cose che cambiano.
   */
  function importRow(entry) {
    const box = h('input', {
      type: 'checkbox', 'aria-label': `importa ${entry.name}`,
      onchange: (event) => {
        if (event.target.checked) scelte.add(entry.sessionId);
        else scelte.delete(entry.sessionId);
        const conta = document.querySelector('#pane-admin .pick-row .note');
        if (conta) conta.textContent = `${scelte.size} di ${planConversazioni.importabili.length} scelte`;
        const bottone = document.querySelector('#pane-admin .pick-row ~ .btn-row .btn-primary span:last-child')
          ?? document.querySelector('#pane-admin .btn-primary span:last-child');
        if (bottone) {
          bottone.textContent = `Importa le scelte (${scelte.size})`;
          bottone.closest('button').disabled = scelte.size === 0;
        }
      },
    });
    // L'attributo si scrive dopo: è la casella **disegnata** che deve corrispondere alla scelta.
    box.checked = scelte.has(entry.sessionId);
    return h('li.backup.pick', {},
      h('label.who', {},
        h('div.pick', {}, box),
        h('div', {},
          h('strong', { text: entry.name }),
          h('span.detail', { text: `${entry.projectPath} · ${Math.round((entry.sizeBytes ?? 0) / 1024)} KB · ${new Date(entry.modifiedAt).toLocaleString('it-IT')}` }),
        ),
      ),
    );
  }

  let planConversazioni = null;
  let scelte = new Set();

  // ── copie ──────────────────────────────────────────────────────────────────────────────────
  function copieView() {
    const box = h('div.admin-section');
    const rows = backups?.backups ?? [];

    // Un blocco solo: l'azione, l'elenco, e dietro il «perché» le due cose che si leggono una
    // volta — cosa c'è dentro una copia e come si torna indietro. Era tre blocchi di cui uno
    // conteneva soltanto una spiegazione chiusa.
    box.append(block('Copie di sicurezza',
      note(rows.length
        ? `${rows.length} copie disponibili.`
        : 'Nessuna copia. La prima è quella che serve quando serve.'),
      btnRow(action('Fai una copia adesso', async () => {
        const result = await api('/local/admin/backups', { method: 'POST' });
        await loadBackups();
        toast(`copia fatta: ${result.manifest.chats ?? '?'} conversazioni`);
      }, { kind: 'btn-primary', iconName: 'archive' })),
      rows.length ? h('ul.backups', {}, ...rows.map((row) => backupRow(row))) : null,
      perche('Cosa contiene una copia',
        note('Il registro, il registro precedente, il giornale dei turni, i metadati dei progetti e la scelta dell\'accesso. Non contiene i transcript (restano in ~/.claude/projects e nessun ripristino li tocca) né il token.'),
        h('p.note', {}, h('code', { text: backups?.folder ?? '' }))),
      perche('Come funziona il ripristino',
        note('Il ripristino mette da parte lo stato attuale prima di toccare qualsiasi cosa — una copia verificabile, che resta nell\'elenco qui sopra: se il ripristino è sbagliato, si torna indietro da lì. Le conversazioni che non sono nella copia escono dall\'elenco; i loro transcript restano su disco.')),
    ));

    return box;
  }

  function backupRow(row) {
    const li = h('li.backup', {},
      h('div.who', {},
        h('strong', { text: row.createdAt ? new Date(row.createdAt).toLocaleString('it-IT') : row.name }),
        h('span.detail', { text: `${row.readable === false ? 'registro illeggibile' : `${row.chats ?? '?'} conversazioni`} · ${row.files} file · ${Math.round((row.bytes ?? 0) / 1024)} KB` }),
        row.name.startsWith('pre-restore') ? h('span.chip.accent', { text: 'messa da parte prima di un ripristino' }) : null,
      ),
      btnRow(
        action('Verifica', async () => {
          const result = await api('/local/admin/backups/verify', { method: 'POST', body: { name: row.name } });
          toast(result.ok ? 'la copia è integra' : `diversi dall'impronta: ${result.bad.join(', ')}`, result.ok ? '' : 'danger');
          integrity = { name: row.name, ok: result.ok, bad: result.bad };
        }, { kind: 'btn-quiet', iconName: 'shield' }),
        action('Anteprima ripristino', async () => {
          const result = await api('/local/admin/backups/plan', { method: 'POST', body: { name: row.name } });
          if (!result.ok) throw new Error(result.reason);
          planShown = result;
        }, { kind: 'btn-quiet', iconName: 'info' }),
        action('Ripristina', async () => {
          const result = await api('/local/admin/backups/plan', { method: 'POST', body: { name: row.name } });
          if (!result.ok) throw new Error(result.reason);
          const ok = await ask({
            title: `Ripristinare la copia del ${result.createdAt ? new Date(result.createdAt).toLocaleString('it-IT') : row.name}?`,
            message: `Ora: ${result.counts.now ?? '?'} conversazioni. Dopo: ${result.counts.after ?? '?'} (${result.counts.added} tornano, ${result.counts.removed} escono). `
              + 'Lo stato attuale viene messo da parte prima di toccare qualsiasi cosa, e il registro viene riletto subito: non serve riavviare. I transcript non si toccano.',
            confirmLabel: 'ripristina',
            danger: true,
          });
          if (!ok) return;
          const esito = await api('/local/admin/backups/restore', { method: 'POST', body: { name: row.name, confirm: row.name } });
          planShown = null;
          toast(esito.failed?.length
            ? `ripristinate ${esito.restored.join(', ')}, non riuscite: ${esito.failed.join(', ')}`
            : `ripristinate ${esito.chats ?? '?'} conversazioni`, esito.failed?.length ? 'danger' : '');
          if (onRestored) onRestored();
        }, { kind: 'btn-danger', iconName: 'refresh' }),
        action('Scarica', async () => {
          const name = await download(`/local/admin/backups/download?name=${encodeURIComponent(row.name)}`, `${row.name}.json`);
          toast(`copia scaricata: ${name}`);
        }, { kind: 'btn-quiet', iconName: 'download' }),
      ),
      integrity?.name === row.name
        ? h('p.note', { text: integrity.ok ? 'integra: ogni file corrisponde alla sua impronta' : `diversi dall'impronta: ${integrity.bad.join(', ')}` })
        : null,
      planShown?.folder?.endsWith(row.name)
        ? h('div.plan', {},
          h('p.note', { text: `Cosa cambierebbe: ${planShown.counts.now ?? '?'} → ${planShown.counts.after ?? '?'} conversazioni.` }),
          planShown.added.length ? h('p.note', { text: `Tornano: ${planShown.added.join(', ')}${planShown.counts.added > planShown.added.length ? ` e altre ${planShown.counts.added - planShown.added.length}` : ''}` }) : null,
          planShown.removed.length ? h('p.note', { text: `Escono: ${planShown.removed.join(', ')}${planShown.counts.removed > planShown.removed.length ? ` e altre ${planShown.counts.removed - planShown.removed.length}` : ''}` }) : null,
          planShown.warnings.map((warning) => h('p.note.danger', { text: warning })))
        : null,
    );
    return li;
  }

  let integrity = null;
  let planShown = null;

  // ── impostazioni ───────────────────────────────────────────────────────────────────────────
  function impostazioniView() {
    const box = h('div.admin-section');
    const effective = settings?.effective ?? {};
    const saved = settings?.saved ?? {};

    const projectField = campo('cartella-dei-progetti', {
      type: 'text', 'aria-label': 'cartella dei progetti', placeholder: 'C:\\percorso\\dei\\progetti',
      value: saved.defaultProject ?? '',
    });
    const roots = [...(saved.allowedRoots ?? [])];
    const rootList = h('div.chips');

    const paintRoots = () => fill(rootList, ...(roots.length
      ? roots.map((root) => h('span.chip', {}, h('span', { text: root }),
        h('button.icon-btn', {
          type: 'button', 'aria-label': `togli ${root}`, title: 'togli',
          onclick: () => { roots.splice(roots.indexOf(root), 1); paintRoots(); },
        }, icon('close', { size: 13 }))))
      : [h('p.note', { text: 'solo quella di partenza: ' }, h('code', { text: (effective.allowedRoots ?? []).join(' · ') }))]));
    paintRoots();

    const newRoot = campo('nuova-radice', { type: 'text', 'aria-label': 'aggiungi una radice consentita', placeholder: 'C:\\altra\\cartella' });

    // Un blocco solo con i tre campi e **una** azione principale. Prima erano tre blocchi, e in
    // mezzo c'era un'intestazione per il pulsante di salvataggio: tre titoli per due campi.
    box.append(block('Dove nascono le conversazioni',
      h('div.field-block', {},
        h('span.cap', { text: 'cartella di partenza' }),
        h('div.field-row', {}, h('div.field', {}, projectField)),
        h('span.help', { text: 'Si guarda quando un client non dice quale.' }),
      ),
      h('div.field-block', {},
        h('span.cap', { text: 'cartelle consentite' }),
        rootList,
        h('div.field-row', {}, h('div.field', {}, newRoot)),
        h('span.help', { text: 'Il confine dentro cui un agente può girare: una conversazione non ne esce.' }),
        btnRow(action('Aggiungi', async () => {
          const value = newRoot.value.trim();
          if (!value) return;
          roots.push(value);
          newRoot.value = '';
          bozze.delete('nuova-radice');
          paintRoots();
        }, { kind: 'btn-quiet', iconName: 'plus' })),
      ),
      btnRow(action('Salva le impostazioni', async () => {
        const ok = await ask({
          title: 'Salvare le impostazioni?',
          message: `Cartella dei progetti: ${projectField.value.trim() || '—'}. Radici consentite: ${roots.join(', ') || '(solo quella di partenza)'}. Si applicano al prossimo avvio del server.`,
          confirmLabel: 'salva',
        });
        if (!ok) return;
        await api('/local/admin/settings', {
          method: 'POST',
          body: { confirm: 'impostazioni', defaultProject: projectField.value.trim(), allowedRoots: roots },
        });
        await loadSettings();
        toast('impostazioni salvate: si applicano al prossimo avvio');
      }, { kind: 'btn-primary', iconName: 'check' })),
      perche('Cosa vale adesso',
        h('ul.paths', {},
          h('li', h('span.what', { text: 'cartella di default' }), h('code', { text: effective.defaultProject ?? '—' })),
          h('li', h('span.what', { text: 'radici attive' }), h('code', { text: (effective.allowedRoots ?? []).join(' · ') })),
          h('li', h('span.what', { text: 'indirizzo' }), h('code', { text: `${effective.host}:${effective.port}` })),
          h('li', h('span.what', { text: 'comando dell\'agente' }), h('code', { text: `${effective.claudeCmd ?? 'claude'}${effective.claudeArgs ? ` (+${effective.claudeArgs} argomenti)` : ''}` })),
          h('li', h('span.what', { text: 'file delle impostazioni' }), h('code', { text: effective.settingsFile ?? '' })),
        ),
        note('Le impostazioni si leggono all\'avvio, quindi si applicano al prossimo avvio del server. Le variabili d\'ambiente vincono sempre: se una di queste è fissata lì, quello che si scrive qui non la scavalca.')),
    ));

    return box;
  }

  // ── il pannello ────────────────────────────────────────────────────────────────────────────
  // Il pannello si attacca **una volta sola** al suo riquadro: `paint()` riscrive quello che c'è
  // dentro, e un nodo ricostruito a ogni giro sarebbe un nodo staccato dalla pagina.
  const body = h('div.admin-body');
  into.append(body);

  /** Cambiare sezione: una per volta, e quello che si stava leggendo nell'altra non resta appeso. */
  function goTo(id) {
    if (id === section) return;
    section = id;
    verification = null;
    integrity = null;
    planShown = null;
    plan = null;
    error = null;
    loading = true;
    paint();
    void reload();
  }

  function paint() {
    // Chi sta scrivendo non deve perdere né il testo né il cursore: `fill` ricostruisce i campi, e
    // un campo ricostruito a metà digitazione si porta via il fuoco — il resto della riga finisce
    // sul documento, dove i tasti sono scorciatoie. Il testo è al sicuro nelle `bozze`; qui si
    // rimette il cursore dov'era.
    const attivo = document.activeElement?.dataset?.bozza ? document.activeElement : null;
    const fuoco = attivo
      ? { chiave: attivo.dataset.bozza, inizio: attivo.selectionStart, fine: attivo.selectionEnd }
      : null;

    // La navigazione secondaria: a sinistra, **ferma**, una sezione per volta. Era una fila di
    // schede che scorreva via col contenuto, e per cambiare sezione bisognava risalire in cima.
    const rail = h('nav.admin-rail', { role: 'tablist', 'aria-label': 'sezioni del pannello' },
      ...SECTIONS.map((entry) => h('button.admin-tab', {
        type: 'button', role: 'tab', 'aria-selected': String(entry.id === section),
        'aria-controls': 'admin-panel',
        onclick: () => goTo(entry.id),
      }, icon(entry.icon, { size: 15 }), h('span', { text: entry.label }))));

    let view = null;
    if (snapshot === null) view = h('p.note.leggo', { text: 'leggo lo stato…' });
    else if (section === 'stato') view = statoView();
    else if (section === 'accesso') view = accessoView();
    else if (section === 'conversazioni') view = conversazioniView();
    else if (section === 'copie') view = copieView();
    else view = impostazioniView();

    fill(body,
      // La pagina ha un titolo come tutte le altre, e una riga sola di spiegazione: senza, il
      // pannello cominciava con una fila di schede e non si sapeva più dove si era.
      h('.page-head', {},
        h('.titles', {},
          h('h1', { text: 'Amministrazione' }),
          h('p.lead', { text: 'Questa macchina, chi può entrarci, le copie del registro, le preferenze.' }))),
      h('div.admin-grid', {},
        rail,
        h('div.admin-panel', {
          id: 'admin-panel', role: 'tabpanel', 'aria-busy': String(Boolean(busy || loading)),
        },
          // Un'azione in corso si vede **dove si guarda** — in cima al contenuto — non in un
          // angolo della testata dove nessuno la cerca.
          busy || error
            ? h('div.admin-state', {},
              busy ? h('span.chip.accent', { text: busy }) : null,
              error ? h('span.chip.danger', { text: error }) : null)
            : null,
          view),
      ),
    );

    if (fuoco) {
      const tornato = body.querySelector(`input[data-bozza="${CSS.escape(fuoco.chiave)}"]`);
      if (tornato) {
        tornato.focus();
        // `selectionStart` è `null` sui campi che non sono di testo: lì il cursore non c'è da rimettere.
        if (tornato.selectionStart !== null) tornato.setSelectionRange(fuoco.inizio, fuoco.fine);
      }
    }
  }

  async function reload() {
    loading = true;
    try {
      await load();
      error = null;
    } catch (problem) {
      error = problem.message;
    } finally {
      loading = false;
    }
    paint();
  }

  return {
    /** Apre il pannello: carica lo stato vero e disegna. */
    async open(where = 'stato') {
      section = SECTIONS.some((entry) => entry.id === where) ? where : 'stato';
      snapshot = null;
      loading = true;
      paint();
      await reload();
    },
    /** Rilegge **solo** lo stato (la parte economica): serve al giro automatico. */
    async refresh() {
      try {
        await loadStatus();
        if (section === 'stato') await loadProcesses();
      } catch {
        return; // il pannello non deve riempire la pagina di errori mentre il server riparte
      }
      paint();
    },
    paint,
    get section() { return section; },
    /** Chi la chiama può dire «il registro è cambiato» (dopo un ripristino). */
    set onRestored(fn) { onRestored = fn; },
  };
}
