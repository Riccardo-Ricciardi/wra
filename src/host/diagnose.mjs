// Diagnostics, as a **function**. It used to live inside `rc doctor`, that is, inside a command:
// the panel would have had to rewrite it, and two implementations of the same question always
// diverge — the one you read is the one that lies. Here there is a single answer, and both the
// command (`src/cli/doctor.mjs`, which merely prints it) and the server (`/local/admin/*`) use it.
//
// Side effects are **injectable** (`probes`): the real diagnostics reads files, asks for the
// `claude` version and looks at processes; a test makes the same function run on a fake filesystem
// and an invented process list.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { accessDefaults, reviewAccess } from '../core/access.mjs';

/** The format of a JSON file read in pieces: `{entries}` if it reads, `{why}` if not. */
function readJsonList(file, key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.[key]) ? { entries: parsed[key] } : { why: `valid JSON but without "${key}"` };
  } catch (error) {
    if (error.code === 'ENOENT') return { why: 'missing' };
    // "unreadable" and "corrupt" are two different things, and the first is not fixed by rewriting
    // the file. On 02/11 a registry with broken permissions (EPERM) was believed corrupt for an
    // entire afternoon: that afternoon cost this line.
    return {
      why: error instanceof SyntaxError
        ? `broken JSON: ${error.message}`
        : `cannot open it: ${error.code || error.message}`,
      unreadable: true,
    };
  }
}

/**
 * The real probes. Everything that leaves the process passes through here, so a test can replace it.
 */
export function defaultProbes(env = process.env) {
  return {
    exists: (file) => fs.existsSync(file),
    readJsonList,
    readDir: (folder) => {
      try {
        return fs.readdirSync(folder);
      } catch {
        return [];
      }
    },
    stat: (file) => {
      try {
        return fs.statSync(file);
      } catch {
        return null;
      }
    },
    which: (command) => {
      try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore', windowsHide: true });
        return true;
      } catch {
        return false;
      }
    },
    run: (command, args, { timeoutMs = 20_000 } = {}) => {
      try {
        return execFileSync(command, args, {
          encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        }).trim();
      } catch {
        return null;
      }
    },
    // `claude --version` is slow (a whole node process): ask once per minute, not on every panel
    // refresh.
    claudeVersion: () => null,
    platform: process.platform,
    node: process.version,
    now: () => Date.now(),
    env,
  };
}

const VERSION_TTL_MS = 60_000;

/** The real probes, with a cache for the `claude` version. */
export function liveProbes(env = process.env) {
  const base = defaultProbes(env);
  let cached = { at: 0, value: null };
  base.claudeVersion = () => {
    const now = base.now();
    if (now - cached.at < VERSION_TTL_MS) return cached.value;
    const value = base.run(env.CR_CLAUDE_CMD || 'claude', ['--version']);
    cached = { at: now, value };
    return value;
  };
  return base;
}

/**
 * The quick facts: what the files say and what the server says. No process launched, no network —
 * it can be called on every panel refresh.
 *
 * @param {object} input
 * @param {object} input.config
 * @param {object|null} [input.health]  what `/healthz` returns (or the live equivalent)
 * @param {object} [input.probes]
 * @param {object} [input.summary]  the numbers already computed by the server (sessions, projects, clients)
 */
export function diagnoseFacts({ config, health = null, probes = defaultProbes(), summary = null } = {}) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  add('server', Boolean(health), health ? `running on ${config.host}:${config.port}` : 'not responding: start it with `wra start`');
  // The token is **never** shown: we say it exists and how long it is, which is what is needed to
  // tell whether it is too short.
  const token = config.token ?? '';
  add('token', token.length >= 16, token ? `${token.length} characters` : 'missing: `wra serve` generates one');

  // The registry and its backup: the file that, if it disappears, takes the conversations with it.
  const registry = probes.readJsonList(config.stateFile, 'sessions');
  const backup = probes.readJsonList(`${config.stateFile}.bak`, 'sessions');
  const registryEntries = registry.entries ?? null;
  add('registry', registryEntries !== null || !probes.exists(config.stateFile),
    registryEntries !== null
      ? `${registryEntries.length} conversations — ${config.stateFile}`
      : `UNREADABLE (${registry.why}) — ${config.stateFile}: the server starts from the .bak, and saves stay refused until that file is fixed`);
  const backupEntries = backup.entries ?? null;
  add('registry backup', backupEntries !== null,
    backupEntries !== null
      ? `${backupEntries.length} conversations — previous version, the latest change is lost`
      : `unusable (${backup.why})`);

  const quarantined = probes.readDir(path.dirname(config.stateFile)).filter((name) => name.includes('.corrupt-'));
  if (quarantined.length) add('recoveries performed', true, `${quarantined.length}: ${quarantined.join(', ')}`);

  const journal = probes.readJsonList(config.turnJournalFile, 'turns');
  add('turn journal', true, journal.entries
    ? `${journal.entries.length} requests remembered`
    : `empty (${journal.why}): requests already executed are recognized only from here on`);

  const projects = probes.readJsonList(config.projectsFile, 'projects');
  const projectEntries = projects.entries ?? null;
  add('project metadata', projectEntries !== null || !probes.exists(config.projectsFile),
    projectEntries !== null
      ? `${projectEntries.length} projects with a name, star or "hidden"`
      : (probes.exists(config.projectsFile) ? `unreadable (${projects.why})` : 'none: projects are named after their folders'));

  add('transcript', probes.exists(config.projectsRoot), config.projectsRoot);

  if (summary) {
    add('conversations', true,
      `${summary.sessions.total} in the registry · ${summary.processes.length} with a running process · ${summary.projects} projects`);
  }

  if (health) {
    add('MCP bridge', true, health.mcp
      ? `on${config.resourceUrl ? `, resources at ${config.resourceUrl}` : ''}`
      : 'off: CR_ISSUER_URL and CR_RESOURCE_URL are required (the terminal still works)');
    add('chats in registry', true, `${health.sessions?.length ?? 0}`);
    const busy = (health.turns?.sessions ?? []).filter((entry) => entry.running || entry.waiting);
    const stuck = health.turns?.stuck ?? [];
    add('turns', stuck.length === 0, stuck.length === 0
      ? (busy.length ? busy.map((entry) => `${entry.sessionId.slice(0, 8)}: 1 running, ${entry.waiting} queued`).join(' · ') : 'none running')
      : `SUSPECT (running but with no progress for a while): ${stuck.map((turn) => `${turn.sessionId.slice(0, 8)} stalled for ${Math.round((turn.idleMs ?? turn.elapsedMs) / 1000)}s`).join(', ')}`);
    add('pending permissions', true, health.approvals ? `${health.approvals} requests waiting for an answer` : 'none');
    if (health.mcp) {
      const host = health.oauth?.host;
      // The sentence must say **what is true now**, not how it was before `CR_SINGLE_HOST`: it was
      // written by hand and claimed that on that host the site answers 404, which in single-host is
      // false — and diagnostics that reassures about the opposite of what is there is worse than
      // diagnostics that is missing.
      add('public host', true, !host
        ? 'none (CR_MCP_HOST not set): the bridge answers on any host that arrives'
        : config.singleHost
          ? `${host} — a single hostname: dashboard, PWA and /mcp split by path`
            + `${config.remotePermissions ? ' · conversation permissions can be managed from outside' : ''}`
            + `${config.singleHostAdmin ? ' · and the panel is open there too' : ' · the panel stays closed from outside'}`
          : `${host} — only OAuth and /mcp there: the site, local APIs and websocket answer 404`);
    }
    if (health.oauth) {
      const o = health.oauth;
      add('OAuth consents', true,
        `${o.clients} clients registered · ${o.access} live access · ${o.refresh} live refresh · ${o.usedRefresh} spent refresh`);
    }
    if (health.clients) {
      add('connections', true, `${health.clients.clients} windows connected, ${health.clients.sessions} conversations watched`);
    }
  } else {
    add('MCP bridge', false, 'not verifiable without a server');
  }

  const backups = listBackups({ config, probes });
  add('backups', backups.length > 0, backups.length
    ? `${backups.length} backups, the latest ${backups[0].createdAt ?? 'undated'} (${backups[0].chats ?? '?'} conversations)`
    : `no backups in ${backups.folder}: create one from the panel (or with "wra backup")`);

  const saved = loadSavedAccess({ config, probes });
  const modes = [saved?.tailscale && 'tailscale', saved?.cloudflare && 'cloudflare'].filter(Boolean);
  add('outside access', true, modes.length ? `${modes.join(' + ')}` : 'no mode chosen: access is limited to this machine');

  return { checks, paths: pathsOf({ config, probes }), access: saved };
}

/**
 * The slow probes: requested when someone presses "check again". Each launches a process — or a
 * handful — so they are not part of the panel's automatic refresh.
 */
export function diagnoseDeep({ config, probes = defaultProbes() } = {}) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  const version = probes.claudeVersion();
  add('claude', Boolean(version), version ?? 'not found in PATH (or `--version` does not respond)');

  // The permissions of the state folder, tested **by doing**: create, read back, rename, delete.
  // It is the exact test of the 02/11 incident — a file created in there that existed and could
  // not be opened — and no read-only check would have seen it.
  add('state folder permissions', ...writeCheck({ config }));

  // And the two outside access modes: what is there, what is missing. `reviewAccess` is the same
  // function the guided procedure uses, so what is read here is what is seen there.
  for (const row of reviewAccess({
    config,
    tailscaleInstalled: probes.which('tailscale'),
    cloudflaredInstalled: probes.which('cloudflared'),
  })) {
    if (row.what === 'server') continue; // already said above, with the real port
    add(row.what, row.ok, row.detail);
  }

  return checks;
}

function writeCheck({ config }) {
  const folder = path.dirname(config.stateFile);
  const probe = path.join(folder, `.cc-remote-permcheck-${process.pid}`);
  try {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.readFileSync(probe, 'utf8');
    fs.renameSync(probe, `${probe}.moved`);
    fs.rmSync(`${probe}.moved`, { force: true });
    return [true, `writes, reads back and renames in ${folder}`];
  } catch (error) {
    fs.rmSync(probe, { force: true });
    fs.rmSync(`${probe}.moved`, { force: true });
    return [false,
      `in ${folder} a file created here cannot be ${error.code === 'EPERM' ? 'opened (EPERM)' : `used (${error.code || error.message})`}. `
      + 'On Windows this is almost always broken permission inheritance: `icacls "<folder>" /reset /t`.'];
  }
}

/** The backup folder: next to the registry, like all the rest of the state. */
export const backupsFolder = (config) => path.join(path.dirname(config.stateFile), 'backups');

/**
 * The backups present, from the most recent. **Only** the manifest is read: the fingerprint is
 * recomputed when asked (`verifyBackup`), because reading ten whole backups on every panel refresh
 * would be wasted work.
 */
export function listBackups({ config, probes = defaultProbes() } = {}) {
  const folder = backupsFolder(config);
  const names = probes.readDir(folder)
    .filter((name) => probes.exists(path.join(folder, name, 'MANIFEST.json')))
    .sort()
    .reverse();
  const rows = [];
  for (const name of names) {
    const stat = probes.stat?.(path.join(folder, name)) ?? null;
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(folder, name, 'MANIFEST.json'), 'utf8'));
    } catch {
      manifest = null;
    }
    rows.push({
      name,
      folder: path.join(folder, name),
      createdAt: manifest?.createdAt ?? null,
      chats: manifest?.chats ?? null,
      readable: manifest?.readable !== false,
      files: manifest?.files?.length ?? 0,
      bytes: manifest?.files?.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) ?? null,
      // A backup without a manifest is not a backup: say so, instead of showing it like the others.
      broken: manifest === null,
      mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
    });
  }
  rows.folder = folder;
  return rows;
}

function loadSavedAccess({ config, probes }) {
  try {
    return JSON.parse(fs.readFileSync(config.accessFile, 'utf8'));
  } catch {
    return probes.exists(config.accessFile) ? {} : null;
  }
}

/** Where things are: the panel shows them, and they are needed by whoever has to go look. */
export function pathsOf({ config }) {
  return {
    stateFile: config.stateFile,
    registryBackup: `${config.stateFile}.bak`,
    projectsFile: config.projectsFile,
    journalFile: config.turnJournalFile,
    accessFile: config.accessFile,
    logFile: config.logFile,
    projectsRoot: config.projectsRoot,
    backups: backupsFolder(config),
    // Always said, because it is the first question asked: "if I restore, do I lose the
    // conversations?". The transcripts are elsewhere and nobody touches them.
    transcripts: 'Claude Code transcripts stay in ~/.claude/projects: no backup, no restore touches them',
  };
}

/**
 * What the panel shows at the top: the real numbers, from the real sources. `sessions` is the list
 * the server already exposes (`registry.list()`), so nothing is invented here.
 */
export function systemStatus({ config, sessions = [], projects = [], health = null, clients = null, version = '' } = {}) {
  const byState = { ready: 0, starting: 0, busy: 0, offline: 0, exited: 0 };
  const processes = [];
  for (const session of sessions) {
    byState[session.state] = (byState[session.state] ?? 0) + 1;
    if (session.pid) {
      processes.push({
        sessionId: session.sessionId,
        name: session.name,
        projectPath: session.projectPath,
        pid: session.pid,
        state: session.state,
        busy: Boolean(session.busy),
        cols: session.cols,
        rows: session.rows,
        lastActivityAt: session.lastActivityAt ?? null,
      });
    }
  }
  return {
    version,
    node: process.version,
    platform: process.platform,
    host: `${config.host}:${config.port}`,
    uptimeS: Math.round(process.uptime()),
    sessions: {
      total: sessions.length,
      archived: sessions.filter((session) => session.archived).length,
      imported: sessions.filter((session) => session.imported).length,
      favorites: sessions.filter((session) => session.favorite).length,
      exposed: sessions.filter((session) => session.mcpReachable).length,
      bypass: sessions.filter((session) => session.permissionMode === 'bypassPermissions').length,
      byState,
    },
    projects: projects.length,
    processes,
    mcp: health?.mcp
      ? { enabled: true, host: health.oauth?.host ?? null, ...(health.oauth ?? {}) }
      : { enabled: false },
    connections: clients,
    turns: health?.turns ?? null,
    approvals: health?.approvals ?? 0,
  };
}

export { accessDefaults, reviewAccess };