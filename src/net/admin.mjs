// The administrative routes: `/local/admin/*`. They live in their own file because — as
// `docs/SECURITY.md` says — the barrier is the code, not the screen: whoever reviews them must be
// able to read them all together.
//
// Four rules, applied by hand on every route and not "in general":
//
//  1. **token**: everything goes through `owner.gate`, the same as every other route of the person;
//  2. **origin**: actions that change something on the machine are accepted only from this
//     machine's browser (`isLocalRequest`). It is a rail against another site's browser, not a
//     network boundary — whoever has the token is the owner, and this is written in SECURITY.md;
//  3. **confirmation**: irreversible actions require a `confirm` that **repeats the object** ("the
//     backup name", "the pid"), and the server does the comparison. A confirmation window is not a
//     protection: it is a courtesy. This is a protection, because without the right field the
//     request does not pass — not even if it comes from a page opened yesterday;
//  4. **no commands from the browser**: the only things executed are `tailscale serve` (with this
//     server's loopback address, not a received value) and `taskkill` on a **recognized** pid.
//     There is no route that executes a received string.
//
// CSRF: the routes that write are POSTs with `content-type: application/json`, and the gate accepts
// the cookie only with `SameSite=Lax` — which does not travel on a cross-site POST. On top of that,
// a foreign origin is refused. GETs change nothing.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accessDefaults, checkHostname, planAccess, reviewAccess } from '../core/access.mjs';
import { createBackupStore, stateFiles } from '../host/backup-store.mjs';
import { diagnoseDeep, diagnoseFacts, listBackups, liveProbes, pathsOf, systemStatus } from '../host/diagnose.mjs';
import { classify, killVerified, listProcesses, processAlive, sessionIdOf } from '../host/processes.mjs';
import { ledgerFile, createProcessLedger } from '../host/process-ledger.mjs';
import { createSettingsStore } from '../host/settings-store.mjs';
import { createAccessStore } from '../host/access-store.mjs';
import { resumable, scanHistory } from '../core/history.mjs';
import { capienza, choose, reconcile } from '../core/reconcile.mjs';
import { resolveProjectDir } from '../host/session-registry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')).version ?? '';
  } catch {
    return '';
  }
})();

/** The last lines of the log, with a cap: a log file grows without end. */
function logTail(file, lines = 60) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const rows = text.trimEnd().split('\n');
    return { lines: rows.slice(-lines), total: rows.length };
  } catch {
    return { lines: [], total: 0 };
  }
}

export function mountAdmin({ app, config, registry, mcp, approvals, journal, web, owner, isLocalRequest, onShutdown = () => process.exit(0), logger = console }) {
  const probes = liveProbes();
  const backups = createBackupStore({ config });
  const settings = createSettingsStore({ file: config.settingsFile });
  settings.load();
  const access = createAccessStore({ file: config.accessFile });
  access.load();
  const ledger = createProcessLedger({ file: ledgerFile(config) });

  // A cap on administrative actions: it is not against whoever works, it is against a crazed loop
  // in a page left open (which would create a thousand backups, or a hundred scans).
  let budget = { at: Date.now(), count: 0 };
  const budgetOk = () => {
    const now = Date.now();
    if (now - budget.at > 60_000) budget = { at: now, count: 0 };
    budget.count += 1;
    return budget.count <= 120;
  };

  const gate = [owner.gate];
  const local = (request, response, next) => {
    if (!isLocalRequest(request)) {
      response.status(403).json({ error: 'this action is done from this machine\'s browser: from the phone you look and organize' });
      return;
    }
    next();
  };
  /** The confirmation repeats the object: the server compares it, it does not trust the window. */
  const confirmed = (expected) => (request, response, next) => {
    const wanted = expected(request);
    if (String(request.body?.confirm ?? '') !== wanted) {
      response.status(400).json({ error: `explicit confirmation required: confirm = "${wanted}"` });
      return;
    }
    next();
  };

  // ── status and diagnostics ───────────────────────────────────────────────────────────────
  /** What the server knows about itself right now, in the shape `/healthz` exposes to others. */
  const liveHealth = () => ({
    ok: true,
    proto: 2,
    mcp: mcp.enabled,
    sessions: registry.list(),
    mcpSelections: null,
    turns: null,
    approvals: approvals.list().length,
    journal: journal.size(),
    clients: web.stats(),
    oauth: mcp.enabled
      ? { ...mcp.store.count, authorizationEndpoint: '/authorize', resource: config.resourceUrl, host: config.mcpHost || null }
      : null,
  });

  const setupState = () => {
    const facts = diagnoseFacts({ config, health: liveHealth(), probes });
    const byName = new Map(facts.checks.map((check) => [check.name, check]));
    const version = probes.claudeVersion();
    const steps = [
      { id: 'server', what: 'The server responds', ok: true, detail: `${config.host}:${config.port}` },
      // Not "Claude Code": the command can be changed (`CR_CLAUDE_CMD`), and what is verified is
      // that **that** command responds. Written this way, a wrong `CR_CLAUDE_CMD` shows up at once.
      { id: 'claude', what: 'The agent command responds', ok: Boolean(version), detail: version ?? 'not found: `claude` must be in PATH' },
      { id: 'registry', what: 'The registry is readable', ok: Boolean(byName.get('registry')?.ok), detail: byName.get('registry')?.detail ?? '' },
      { id: 'projects', what: 'The projects folder is chosen', ok: Boolean(config.defaultProject) && probes.exists(config.defaultProject), detail: config.defaultProject || 'none' },
      { id: 'backups', what: 'At least one backup exists', ok: listBackups({ config, probes }).length > 0, detail: backups.folder },
      { id: 'access', what: 'Outside access is decided', ok: Boolean(facts.access?.tailscale || facts.access?.cloudflare), detail: 'optional: you can stay on this machine only' },
    ];
    return {
      complete: steps.filter((step) => step.id !== 'access').every((step) => step.ok),
      steps,
    };
  };

  app.get('/local/admin/status', ...gate, (request, response) => {
    const health = liveHealth();
    const sessions = registry.list();
    const facts = diagnoseFacts({ config, health, probes, summary: null });
    response.json({
      version: VERSION,
      status: systemStatus({
        config,
        sessions,
        projects: [...new Set(sessions.map((session) => session.projectKey))],
        health,
        clients: web.stats(),
        version: VERSION,
      }),
      checks: facts.checks,
      paths: pathsOf({ config }),
      backups: listBackups({ config, probes }).slice(0, 5),
      settings: settings.get(),
      effective: {
        host: config.host,
        port: config.port,
        defaultProject: config.defaultProject,
        allowedRoots: config.allowedRoots,
        publicOrigins: config.publicOrigins,
        dashboardHost: config.dashboardHost,
        mcpHost: config.mcpHost,
        settingsFile: config.settingsFile,
      },
      access: facts.access,
      setup: request.query.setup === '0' ? null : setupState(),
    });
  });

  // The slow diagnostics: it launches processes (the `claude` version, a scan, a write test), which
  // is why it is a POST and is requested when someone presses "check again".
  app.post('/local/admin/check', ...gate, (request, response) => {
    if (!budgetOk()) {
      response.status(429).json({ error: 'too many requests in a minute' });
      return;
    }
    const health = liveHealth();
    response.json({
      facts: diagnoseFacts({ config, health, probes }).checks,
      deep: diagnoseDeep({ config, probes }),
      log: logTail(config.logFile, Number(request.body?.lines) || 40),
    });
  });

  // ── processes ──────────────────────────────────────────────────────────────────────────────
  const scanAndClassify = () => {
    const sessions = registry.list();
    const managed = sessions.filter((session) => session.pid).map((session) => ({
      pid: session.pid, sessionId: session.sessionId, name: session.name, state: session.state,
    }));
    const processes = listProcesses({ probes: { run: probes.run, platform: probes.platform } });
    const known = sessions.map((session) => session.sessionId);
    return {
      scanned: processes !== null,
      ...classify({ processes: processes ?? [], managed, leftovers: ledger.leftovers(processAlive), known }),
    };
  };

  app.get('/local/admin/processes', ...gate, (_request, response) => {
    const result = scanAndClassify();
    response.json({
      scanned: result.scanned,
      managed: result.managed,
      orphans: result.orphans,
      windows: result.windows,
      gone: result.gone,
      foreign: result.foreign.map((row) => ({ pid: row.pid, startedAt: row.startedAt, line: row.commandLine.slice(0, 160) })),
      note: result.scanned ? null : 'cannot read the process list on this system: the list below covers only what the server knows about itself',
    });
  });

  app.post('/local/admin/processes/kill', ...gate, local, confirmed((request) => String(request.body?.pid ?? '')), (request, response) => {
    const pid = Number(request.body?.pid);
    const sessionId = String(request.body?.sessionId ?? '');
    // The id **must** be a conversation of this registry, and it must exist: without this, a request
    // with `sessionId: ''` bypassed the comparison and could close any `claude` carrying an id —
    // that is, also the conversation open in another window, which the panel itself classifies as
    // "work in progress, do not touch". The rule cannot apply only in the button that hides it.
    if (!sessionId || !registry.exists(sessionId)) {
      response.status(400).json({ error: 'the id of a conversation in this registry is required' });
      return;
    }
    // Who that pid is is re-read **now**: what the page saw is not trusted.
    const processes = listProcesses({ probes: { run: probes.run, platform: probes.platform } }) ?? [];
    const seen = processes.find((row) => row.pid === pid) ?? null;
    const result = killVerified({
      pid,
      sessionId,
      verify: () => ({ alive: processAlive(pid) || Boolean(seen), sessionId: seen ? sessionIdOf(seen.commandLine) : null }),
    });
    if (!result.ok) {
      response.status(400).json({ error: result.reason });
      return;
    }
    ledger.forget(pid);
    logger.warn?.(`process ${pid} closed from the panel (conversation ${sessionId.slice(0, 8)})`);
    response.json({ killed: pid });
  });

  // A process ledger line that no longer corresponds to anything: just remove it.
  app.post('/local/admin/processes/forget', ...gate, local, confirmed((request) => String(request.body?.pid ?? '')), (request, response) => {
    const pid = Number(request.body?.pid);
    if (!Number.isInteger(pid)) {
      response.status(400).json({ error: 'invalid pid' });
      return;
    }
    ledger.forget(pid);
    response.json({ forgotten: pid });
  });

  // ── backups ────────────────────────────────────────────────────────────────────────────────
  app.get('/local/admin/backups', ...gate, (_request, response) => {
    response.json({ folder: backups.folder, backups: backups.list() });
  });

  // From this machine's browser: writes a folder inside the state. It destroys nothing, but it
  // belongs with the other actions that touch the disk, not with reads.
  app.post('/local/admin/backups', ...gate, local, (_request, response) => {
    if (!budgetOk()) {
      response.status(429).json({ error: 'too many requests in a minute' });
      return;
    }
    try {
      const { folder, manifest } = backups.create();
      response.json({ folder, manifest, backups: backups.list() });
    } catch (error) {
      response.status(400).json({ error: `cannot create the backup: ${error.message}` });
    }
  });

  /** A backup name is a folder inside `backups`: no paths, no `..`. */
  const backupFolder = (name) => {
    const raw = String(name ?? '');
    if (!raw || raw !== path.basename(raw) || raw.includes('..')) return null;
    const full = path.join(backups.folder, raw);
    if (!full.startsWith(backups.folder)) return null;
    return fs.existsSync(path.join(full, 'MANIFEST.json')) ? full : null;
  };

  app.post('/local/admin/backups/verify', ...gate, (request, response) => {
    const folder = backupFolder(request.body?.name);
    if (!folder) {
      response.status(404).json({ error: 'unknown backup' });
      return;
    }
    const result = backups.verify(folder);
    response.json({ ok: result.ok, bad: result.bad, manifest: result.manifest });
  });

  app.post('/local/admin/backups/plan', ...gate, (request, response) => {
    const folder = backupFolder(request.body?.name);
    if (!folder) {
      response.status(404).json({ error: 'unknown backup' });
      return;
    }
    response.json(backups.plan(folder));
  });

  app.post('/local/admin/backups/restore', ...gate, local, confirmed((request) => String(request.body?.name ?? '')), (request, response) => {
    const folder = backupFolder(request.body?.name);
    if (!folder) {
      response.status(404).json({ error: 'unknown backup' });
      return;
    }
    const result = backups.restore(folder);
    if (!result.ok) {
      response.status(400).json({ error: result.reason });
      return;
    }
    // The conversations are other ones: the in-memory registry must be re-read, and the previous
    // processes (which belong to conversations that may no longer exist) are shut down in order.
    let sessions = null;
    let reloadError = null;
    try {
      sessions = registry.reload();
    } catch (error) {
      reloadError = error.message;
    }
    // A restore puts the registry back as it was, and consent to bypass exposure is a
    // **privilege**: it does not come back from a backup without someone granting it again. A
    // backup made before a revocation would bring the revocation back, and that would be the
    // opposite of "revocable".
    let droppedConsents = [];
    // Consents are removed **only when the in-memory store is the restored one** (`sessions` is the
    // result of the re-read). This is not excessive caution: `clearBypassConsents` writes through
    // the store, and with the re-read failed the store is still the previous one — writing to it
    // would put the old registry in place of the freshly restored one, that is, the restore would be
    // lost in order to remove a consent. Worse than the disease.
    if (sessions) {
      try {
        droppedConsents = registry.clearBypassConsents();
        for (const entry of droppedConsents) {
          logger.warn?.(`the restore had brought back the high-privilege consent of "${entry.name}" (${entry.sessionId}, given ${entry.at}): removed, it must be given again by hand`);
        }
        if (droppedConsents.length) sessions = registry.list();
      } catch (error) {
        reloadError = reloadError ?? error.message;
      }
    } else if (result.ok) {
      // The restore succeeded but the re-read did not: the registry from the backup is on disk, and
      // the consent that was inside it was **not** removed. It is not removed from here for the
      // reason written above, but it is not kept quiet either: it is a high-privilege consent that
      // came back, and it must be looked at now, not at the next start.
      logger.warn?.('the restore succeeded but the registry could not be re-read: the high-privilege consents from the backup were NOT removed — check the chats exposed to MCP before restarting');
      reloadError = reloadError ?? 'registry restored but not re-read: the high-privilege consents from the backup are still on disk';
    }
    logger.warn?.(`restore from ${path.basename(folder)}: ${result.restored.join(', ')}`);
    response.json({
      ...result,
      sessions,
      reloadError,
      droppedConsents,
      // Said in the response too, not only in the log: whoever pressed "restore" must know it
      // without going to read the log file.
      consentsKept: Boolean(result.ok) && !sessions,
      backups: backups.list(),
    });
  });

  /**
   * Downloading a backup. Two ways: a single file (which is what is almost always needed: the
   * registry), or everything together in a JSON. No compressed archives: no dependency is added to
   * package five text files.
   */
  app.get('/local/admin/backups/download', ...gate, (request, response) => {
    const folder = backupFolder(request.query?.name);
    if (!folder) {
      response.status(404).json({ error: 'unknown backup' });
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'MANIFEST.json'), 'utf8'));
    // A file name must be **both** in the manifest **and** in the closed list of those we know.
    // The manifest can be written by anyone with access to that folder, and a
    // `"name": "..\\..\\token"` in there would turn this route into a secret reader. The restore
    // already filtered like this; the download did not, and it is the same rule.
    const known = new Set(stateFiles(config).map((row) => path.basename(row.file)));
    const listed = (manifest.files ?? []).filter((entry) => known.has(entry.name) && path.basename(entry.name) === entry.name);
    const wanted = String(request.query?.file ?? '');
    if (wanted) {
      if (!listed.some((entry) => entry.name === wanted)) {
        response.status(404).json({ error: 'this file is not in the backup' });
        return;
      }
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('content-disposition', `attachment; filename="${wanted}"`);
      response.send(fs.readFileSync(path.join(folder, wanted)));
      return;
    }
    const bundle = { manifest, files: {} };
    for (const entry of listed) {
      try {
        bundle.files[entry.name] = fs.readFileSync(path.join(folder, entry.name), 'utf8');
      } catch {
        bundle.files[entry.name] = null; // unreadable: say so, do not invent
      }
    }
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-disposition', `attachment; filename="wra-${path.basename(folder)}.json"`);
    response.send(`${JSON.stringify(bundle, null, 2)}\n`);
  });

  // ── conversations: the two lists that do not match ────────────────────────────────────────
  /**
   * Reconciliation, computed **now**: the in-memory registry and the transcripts on disk.
   *
   * It is recomputed on every call on purpose. The client does not send a list to import that the
   * server trusts: it sends **which** ones it wants among those the server has just found, and
   * `choose` does the intersection. An id that is not in the list — because it does not exist,
   * because it is already in the registry, or because `--resume` would not resume it — does not
   * enter.
   */
  function reconcilePlan() {
    const resolve = (dir) => resolveProjectDir(dir, { allowedRoots: config.allowedRoots, home: config.home });
    const found = scanHistory({ projectsRoot: config.projectsRoot, limit: 2_000 })
      // Folders outside the allowed roots cannot be resumed: a process does not start there, and an
      // imported conversation that does not open is worse than one that is not there.
      .filter((entry) => resolve(entry.projectPath).ok)
      .map((entry) => ({ ...entry, riprendibile: resumable(entry, { resolve }) }));
    const sessions = registry.list();
    const plan = reconcile({
      sessions,
      found,
      exists: (file) => Boolean(file) && fs.existsSync(file),
    });
    // How many fit: the preview says it **before**, and the import checks the same answer. See
    // `capienza` in `core/reconcile.mjs` for the defect this closes.
    return {
      ...plan,
      capienza: {
        ...capienza({ inRegistro: sessions.length, daImportare: plan.importabili.length, max: config.maxSessions }),
        // The cap is sent along with the counts: without it, "172 fit" is a number that can neither
        // be checked nor explained to the reader.
        max: config.maxSessions,
      },
    };
  }

  /** Preview only: reads, does not write. It is a POST because the scan reads hundreds of files. */
  app.post('/local/admin/conversations/plan', ...gate, (_request, response) => {
    if (!budgetOk()) {
      response.status(429).json({ error: 'too many requests in a minute' });
      return;
    }
    const plan = reconcilePlan();
    response.json({
      ...plan,
      // The preview is read: for each importable entry, the name, where it is, how big it is and
      // when it was last touched. A list of ids is not a preview.
      importabili: plan.importabili.map((entry) => ({
        sessionId: entry.sessionId,
        name: entry.title ?? '(untitled)',
        projectPath: entry.projectPath,
        transcript: entry.transcript,
        sizeBytes: entry.sizeBytes,
        modifiedAt: entry.modifiedAt,
      })),
      senzaTranscript: plan.senzaTranscript.map((session) => ({
        sessionId: session.sessionId,
        name: session.name,
        projectPath: session.projectPath,
        transcript: session.transcript,
        lastActivityAt: session.lastActivityAt ?? null,
      })),
    });
  });

  /**
   * Importing. It **deletes nothing** and **starts nothing**: it writes one registry entry for each
   * chosen transcript, and the conversation stays off until it is opened.
   *
   * Three things before writing, and none can be skipped: a backup of the current state (which stays
   * next to the file), the confirmation that repeats the object, and the recomputation of the valid
   * list.
   */
  app.post('/local/admin/conversations/import', ...gate, local, confirmed(() => 'importa'), (request, response) => {
    if (!budgetOk()) {
      response.status(429).json({ error: 'too many requests in a minute' });
      return;
    }
    const plan = reconcilePlan();
    const { scelti, rifiutati } = choose(plan, Array.isArray(request.body?.ids) ? request.body.ids : []);
    if (!scelti.length) {
      response.status(400).json({ error: 'none of the requested conversations can be imported right now', rifiutati });
      return;
    }
    // The cap is checked **before** writing. An import that fills the registry to the limit and then
    // stops leaves a registry that is neither the previous one nor the intended one, and whoever
    // looks at it reads "too many saved sessions" without knowing that the number was decided by
    // `CR_MAX_SESSIONS`.
    const spazio = capienza({ inRegistro: plan.counts.registro, daImportare: scelti.length, max: config.maxSessions });
    if (!spazio.ok) {
      response.status(400).json({
        error: `the registry has ${plan.counts.registro} conversations and the cap is ${config.maxSessions}: `
          + `${spazio.posti} fit, you asked for ${scelti.length}. `
          + `Raise the cap (\`CR_MAX_SESSIONS\` at least ${plan.counts.registro + scelti.length}) or import ${spazio.posti} at a time.`,
        capienza: spazio,
      });
      return;
    }
    const copia = backups.create();
    const imported = [];
    const failed = [];
    for (const entry of scelti) {
      try {
        const created = registry.create({
          projectPath: entry.projectPath,
          name: entry.title ?? null,
          sessionId: entry.sessionId,
          imported: true,
          start: false,
        });
        imported.push({ sessionId: created.sessionId, name: created.name });
      } catch (error) {
        failed.push({ sessionId: entry.sessionId, reason: error.message });
      }
    }
    logger.warn?.(`conversations imported from the panel: ${imported.length} (backup ${path.basename(copia.folder)})`);
    response.json({ imported, failed, rifiutati, backup: path.basename(copia.folder) });
  });

  // ── outside access ────────────────────────────────────────────────────────────────────────
  const installs = () => ({
    tailscale: probes.which('tailscale'),
    cloudflared: probes.which('cloudflared'),
    tailscaleStatus: probes.which('tailscale') ? tailscaleSelf() : null,
    cloudflaredVersion: probes.which('cloudflared') ? probes.run('cloudflared', ['--version'], { timeoutMs: 10_000 }) : null,
  });

  /** Who we are in the tailnet, without inventing anything if `tailscale` does not respond. */
  function tailscaleSelf() {
    const raw = probes.run('tailscale', ['status', '--json'], { timeoutMs: 15_000 });
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const dns = String(parsed?.Self?.DNSName ?? '').replace(/\.$/, '');
      return {
        online: parsed?.Self?.Online !== false,
        host: dns || null,
        tailnet: parsed?.['CurrentTailnet']?.Name ?? null,
        backend: parsed?.BackendState ?? null,
      };
    } catch {
      return null;
    }
  }

  const accessSnapshot = () => {
    const saved = access.get();
    const merged = { ...config };
    const defaults = accessDefaults(saved);
    for (const [key, value] of Object.entries(defaults)) if (value && !merged[key]) merged[key] = value;
    const found = installs();
    return {
      saved,
      installs: found,
      review: reviewAccess({ config: merged, tailscaleInstalled: found.tailscale, cloudflaredInstalled: found.cloudflared }),
      plan: {
        tailscale: found.tailscaleStatus?.host ? planAccess({ mode: 'tailscale', tailscaleHost: found.tailscaleStatus.host, port: config.port }) : null,
        cloudflare: null,
      },
      effective: {
        publicOrigins: config.publicOrigins,
        dashboardHost: config.dashboardHost,
        mcpHost: config.mcpHost,
        issuerUrl: config.issuerUrl,
        resourceUrl: config.resourceUrl,
      },
      serve: tailscaleServe(),
    };
  };

  /** What `tailscale serve` is serving now: the **real** configuration, not the written one. */
  function tailscaleServe() {
    if (!probes.which('tailscale')) return null;
    try {
      const out = probes.run('tailscale', ['serve', 'status'], { timeoutMs: 15_000 });
      if (!out) return { configured: false, text: 'no serve configured' };
      return { configured: !/no serve config|not configured/i.test(out), text: out.slice(0, 2_000) };
    } catch {
      return null;
    }
  }

  app.get('/local/admin/access', ...gate, (_request, response) => {
    response.json(accessSnapshot());
  });

  // The plan of a configuration: no side effects, it can be asked as many times as desired. It is
  // what is shown **before** the button.
  app.post('/local/admin/access/plan', ...gate, (request, response) => {
    const mode = String(request.body?.mode ?? '');
    const plan = planAccess({
      mode,
      tailscaleHost: String(request.body?.tailscaleHost ?? ''),
      dashboardHost: String(request.body?.dashboardHost ?? ''),
      mcpHost: String(request.body?.mcpHost ?? ''),
      port: config.port,
    });
    response.json(plan);
  });

  app.post('/local/admin/access/apply', ...gate, local, confirmed((request) => `applica ${request.body?.mode ?? ''}`.trim()), (request, response) => {
    const mode = String(request.body?.mode ?? '');
    const host = String(request.body?.tailscaleHost ?? '');
    const dashboard = String(request.body?.dashboardHost ?? '');
    const mcpHost = String(request.body?.mcpHost ?? '');
    const plan = planAccess({ mode, tailscaleHost: host, dashboardHost: dashboard, mcpHost, port: config.port });
    if (!plan.ok) {
      response.status(400).json({ error: plan.reason });
      return;
    }
    if (mode === 'tailscale') {
      const checked = checkHostname(host);
      access.set('tailscale', { host: checked.host, origin: `https://${checked.host}` });
    } else {
      const checked = checkHostname(dashboard);
      const machine = mcpHost ? checkHostname(mcpHost) : null;
      access.set('cloudflare', { dashboard: checked.host, mcp: machine?.host ?? null });
    }
    logger.warn?.(`outside access: mode ${mode} saved from the panel`);
    response.json({
      saved: access.get(),
      env: plan.env,
      needs: plan.needs,
      // The choice applies at the next start: the server reads this file when it starts. Saying so
      // is the only honest thing — and the panel offers the restart right next to it.
      restartNeeded: true,
    });
  });

  app.post('/local/admin/access/remove', ...gate, local, confirmed((request) => `rimuovi ${request.body?.mode ?? 'tutto'}`), (request, response) => {
    const mode = String(request.body?.mode ?? '');
    const saved = mode === 'tailscale' || mode === 'cloudflare' ? access.clear(mode) : access.clear();
    logger.warn?.(`outside access: ${mode || 'all modes'} removed from the panel`);
    response.json({ saved, restartNeeded: true, note: 'the conversations were not touched' });
  });

  /**
   * `tailscale serve`: the only thing this panel executes on the system. The address is **this**
   * server's (loopback and port), not a value arriving from the request: there is nothing in here
   * that could become someone else's command.
   */
  app.post('/local/admin/access/serve', ...gate, local, confirmed((request) => (request.body?.off ? 'serve off' : 'serve')), (request, response) => {
    if (!probes.which('tailscale')) {
      response.status(400).json({ error: '`tailscale` is not in PATH: install it, or choose another way to get in from outside' });
      return;
    }
    const args = request.body?.off
      ? ['serve', '--https=443', 'off']
      : ['serve', '--bg', '--https=443', `http://127.0.0.1:${config.port}`];
    const out = probes.run('tailscale', args, { timeoutMs: 30_000 });
    const shown = out === null ? 'no response' : out.slice(0, 2_000);
    logger.warn?.(`tailscale ${args.join(' ')} → ${shown.slice(0, 200)}`);
    if (out === null) {
      response.status(400).json({ error: `"tailscale ${args.join(' ')}" did not respond: check "tailscale status" and retry` });
      return;
    }
    response.json({ command: `tailscale ${args.join(' ')}`, output: shown, serve: tailscaleServe() });
  });

  /**
   * Reachability verification. The rule this route exists to respect: **nothing is declared
   * "protected" that has not been verified**. Each row says what was asked and what came back; if
   * the answer is a Cloudflare Access login page, it says that; if it is our gate, it says that; if
   * it is a 200 on the dashboard with neither, it says it is **open** — and that is the case in
   * which you must stop exposing it.
   */
  app.post('/local/admin/access/verify', ...gate, async (request, response) => {
    if (!budgetOk()) {
      response.status(429).json({ error: 'too many requests in a minute' });
      return;
    }
    const snapshot = accessSnapshot();
    const targets = [];
    for (const origin of config.publicOrigins) targets.push({ origin, role: 'dashboard' });
    if (config.issuerUrl && config.mcpHost) targets.push({ origin: new URL(config.issuerUrl).origin, role: 'mcp' });
    if (snapshot.saved?.tailscale?.origin && !config.publicOrigins.includes(snapshot.saved.tailscale.origin)) {
      targets.push({ origin: snapshot.saved.tailscale.origin, role: 'dashboard' });
    }
    response.json(await verifyTargets(targets, request.body?.timeoutMs));
  });

  /** The individual verifications. Exported because it is the part worth testing. */
  async function verifyTargets(targets, timeoutMs = 8_000) {
    const results = [];
    for (const target of targets) {
      const checks = [];
      const ask = async (route, options = {}) => {
        try {
          const answer = await fetch(`${target.origin}${route}`, {
            ...options,
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
            headers: { ...(options.headers ?? {}) },
          });
          return { status: answer.status, location: answer.headers.get('location') ?? '', body: (await answer.text()).slice(0, 2_000) };
        } catch (error) {
          return { error: error.message };
        }
      };

      if (target.role === 'dashboard') {
        const root = await ask('/');
        const protectedByCf = /cloudflareaccess\.com|Cloudflare Access/i.test(`${root.location} ${root.body}`);
        const ourGate = /WRA/.test(root.body) && /token/i.test(root.body);
        checks.push({
          what: 'the dashboard responds',
          ok: root.status === 200 || root.status === 302 || root.status === 403,
          detail: root.error ?? `${root.status}${root.location ? ` → ${redactHost(root.location)}` : ''}`,
        });
        checks.push({
          what: 'there is something in front of the dashboard',
          // Here "protected" is distinguished from "open": Access (or our gate) is a protection, a
          // page served to anyone is not. Nothing else is declared protected.
          ok: protectedByCf || ourGate,
          detail: protectedByCf
            ? 'Cloudflare Access asks for access before the page'
            : ourGate
              ? 'the page asks for the WRA token (no Access in front: only OK on a tailnet)'
              : `warning: the response asks for neither Access nor a token (${root.status}) — do not consider it protected`,
        });
        const mine = await ask('/local/sessions');
        checks.push({
          what: 'the person APIs require the token',
          ok: mine.status === 401 || /cloudflareaccess/.test(mine.location ?? ''),
          detail: mine.error ?? `${mine.status}${mine.status === 401 ? ' (without token: correct)' : ' (WARNING: it should be 401)'}`,
        });
        const machine = await ask('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        checks.push({
          what: 'the machine path does not exist here',
          ok: machine.status === 404 || machine.status === 401 || protectedByCf,
          detail: machine.error ?? `${machine.status}${machine.status === 404 ? ' (correct: the machine has its own address)' : ''}`,
        });
      } else {
        const machine = await ask('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const reachedUs = machine.status === 401 && /"error"/.test(machine.body ?? '');
        checks.push({
          what: 'the MCP endpoint answers ChatGPT, not Access',
          ok: reachedUs,
          detail: machine.error ?? (reachedUs
            ? '401 from the bridge without a bearer: the machine talks to us, not to a login page'
            : `response ${machine.status}${machine.location ? ` → ${redactHost(machine.location)}` : ''}: if it is Access, a Bypass is needed on /.well-known/* /mcp /register /token /revoke`),
        });
        const wellKnown = await ask('/.well-known/oauth-protected-resource/mcp');
        checks.push({
          what: 'the OAuth metadata is reachable',
          ok: wellKnown.status === 200,
          detail: wellKnown.error ?? `${wellKnown.status}`,
        });
      }

      results.push({
        origin: target.origin,
        role: target.role,
        checks,
        ok: checks.every((check) => check.ok),
      });
    }
    return {
      at: new Date().toISOString(),
      targets: results,
      // The verdict in one line, and only about what was seen.
      verdict: results.length === 0
        ? 'no outside access configured: access is limited to this machine'
        : results.every((result) => result.ok) ? 'everything asked responded as it should' : 'something is off: look at the red rows',
    };
  }

  // ── settings ──────────────────────────────────────────────────────────────────────────────
  app.get('/local/admin/settings', ...gate, (_request, response) => {
    response.json({
      saved: settings.get(),
      effective: {
        defaultProject: config.defaultProject,
        allowedRoots: config.allowedRoots,
        port: config.port,
        host: config.host,
        home: config.home,
        projectsRoot: config.projectsRoot,
        claudeCmd: config.claudeCmd,
        claudeArgs: config.claudeArgs.length,
        platform: probes.platform,
        node: probes.node,
      },
      restartNeeded: false,
    });
  });

  app.post('/local/admin/settings', ...gate, local, confirmed(() => 'impostazioni'), (request, response) => {
    const result = settings.set(
      {
        defaultProject: request.body?.defaultProject,
        allowedRoots: Array.isArray(request.body?.allowedRoots) ? request.body.allowedRoots : undefined,
      },
      { stat: (target) => fs.statSync(target), lstat: (target) => fs.lstatSync(target) },
    );
    if (!result.ok) {
      response.status(400).json({ error: result.reason });
      return;
    }
    response.json({
      saved: result.settings,
      // Settings are read at startup, like the access choice. Saying so, and offering the restart
      // next to it, is better than letting people believe they are already active.
      restartNeeded: true,
      note: 'they apply on the next server start',
    });
  });

  // ── the server: restart ───────────────────────────────────────────────────────────────────
  app.post('/local/admin/restart', ...gate, local, confirmed(() => 'riavvia'), (_request, response) => {
    // The restart is done by a **detached** process, because this one is about to exit: `rc restart`
    // waits for the port to be free and then starts it again, with the same logic as `rc start` (one
    // server only, never two).
    const script = fileURLToPath(new URL('../cli/restart.mjs', import.meta.url));
    try {
      const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
      child.unref();
    } catch (error) {
      response.status(500).json({ error: `cannot start the restart: ${error.message}. On its own: rc restart` });
      return;
    }
    response.json({ restarting: true, note: 'the page reconnects by itself when the server is back' });
    setTimeout(() => onShutdown(), 200).unref();
  });

  // ── diagnostics export ────────────────────────────────────────────────────────────────────
  app.get('/local/admin/export', ...gate, (_request, response) => {
    const health = liveHealth();
    const sessions = registry.list();
    const bundle = {
      at: new Date().toISOString(),
      version: VERSION,
      status: systemStatus({ config, sessions, projects: [...new Set(sessions.map((session) => session.projectKey))], health, clients: web.stats(), version: VERSION }),
      checks: [...diagnoseFacts({ config, health, probes }).checks, ...diagnoseDeep({ config, probes })],
      paths: pathsOf({ config }),
      settings: settings.get(),
      access: access.get(),
      backups: listBackups({ config, probes }),
      processes: (() => {
        const result = scanAndClassify();
        return { scanned: result.scanned, managed: result.managed, orphans: result.orphans, windows: result.windows.length, foreign: result.foreign.length };
      })(),
      // No token, no secrets: this file is made to be attached to a report.
      note: 'this export contains no tokens or credentials',
    };
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-disposition', `attachment; filename="wra-diagnosis-${Date.now()}.json"`);
    response.send(`${JSON.stringify(bundle, null, 2)}\n`);
  });

  return { verifyTargets, setupState, backupFolder };
}

/** A redirect's `location` can carry parameters: show the host, not the query. */
function redactHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url).slice(0, 80);
  }
}