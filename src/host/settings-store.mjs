// Settings that cannot go in an environment variable because they are chosen from the panel: the
// folder where new conversations are born and the roots where running an agent is allowed.
//
// `allowedRoots` is a **security boundary**, not a preference: widening it means allowing a
// conversation to run in a folder that was previously outside. That is why every root is really
// checked (`checkRoot`) before being written, and why environment variables always win: whoever
// has access to the machine can always have the last word from there.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic.mjs';

export const emptySettings = () => ({ version: 1, defaultProject: '', allowedRoots: [] });

/**
 * An allowed root: it exists, it is a folder, it is an absolute path, and **no component of its
 * path is a link**.
 *
 * The last rule is the one that matters, and looking at the last component is not enough:
 * `C:\j\projects`, with `C:\j` being a junction to `\\attacker\share`, presents itself as a very
 * normal folder — `sub` is a real folder, it is just somewhere else. Accepting it would mean every
 * conversation under that root runs on someone else's share, and that the root boundary no longer
 * exists without anything saying so.
 *
 * And there is one more reason to walk the path **before** anything else: `statSync` **traverses**
 * a link, so asking "does it exist?" about `\\attacker\share` makes this machine authenticate to
 * someone else's server — NTLM credential theft or relay — during the validation itself.
 * `lstatSync` does not traverse it.
 *
 * @param {string} value
 * @param {{stat?: (path: string) => object, lstat?: (path: string) => object}} [probes]
 */
export function checkRoot(value, probes = {}) {
  const stat = probes.stat ?? ((target) => fs.statSync(target));
  const lstat = probes.lstat ?? ((target) => fs.lstatSync(target));
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty path' };
  // `\\server\folder` and `//server/folder` are network paths written that way: they are refused
  // immediately, without even looking at the disk.
  if (/^[\\/]{2}/.test(raw)) return { ok: false, reason: 'no network paths (\\\\server\\folder)' };
  if (!path.isAbsolute(raw)) return { ok: false, reason: 'an absolute path is required' };

  const resolved = path.resolve(raw);
  // The path is walked **piece by piece**, with `lstat` and never `stat` first: it is the only way
  // not to traverse a link while looking for it.
  const { root } = path.parse(resolved);
  let current = root;
  for (const piece of resolved.slice(root.length).split(path.sep)) {
    if (!piece) continue;
    current = path.join(current, piece);
    let info;
    try {
      info = lstat(current);
    } catch {
      return { ok: false, reason: 'this folder does not exist' };
    }
    if (info.isSymbolicLink()) {
      return { ok: false, reason: `"${current}" is a link: choose the real folder (the root boundary does not cross it)` };
    }
  }

  // Only now: the path is made of real folders, so `stat` does not traverse anything.
  let info;
  try {
    info = stat(resolved);
  } catch {
    return { ok: false, reason: 'this folder does not exist' };
  }
  if (!info.isDirectory()) return { ok: false, reason: 'not a folder' };
  return { ok: true, path: resolved };
}

export function createSettingsStore({ file, now = () => Date.now() }) {
  let state = emptySettings();

  const load = () => {
    if (!fs.existsSync(file)) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid settings');
      // Roots are **rechecked** even when they come from the file: the file can be written by hand,
      // and a boundary that trusts what it finds written is not a boundary. One that no longer
      // passes (a vanished folder, a link that appeared later) is left out and reported: a
      // convenience is lost, not security.
      const roots = (Array.isArray(parsed.allowedRoots) ? parsed.allowedRoots : []).filter((entry) => typeof entry === 'string');
      const checked = [];
      for (const root of roots) {
        const valid = checkRoot(root);
        if (valid.ok) checked.push(valid.path);
        else console.warn(`allowed root ignored (${root}): ${valid.reason}`);
      }
      state = {
        version: 1,
        defaultProject: typeof parsed.defaultProject === 'string' ? parsed.defaultProject : '',
        allowedRoots: checked,
      };
    } catch {
      // A broken settings file must not prevent the server from starting: fall back to the default
      // values (which are the safe ones) and say so. Conversations are not involved.
      console.warn(`Settings unreadable (${file}): using the defaults`);
      state = emptySettings();
    }
    return state;
  };

  const save = () => {
    writeFileAtomic(file, `${JSON.stringify({ ...state, version: 1, updatedAt: new Date(now()).toISOString() }, null, 2)}\n`);
  };

  return {
    load,
    get: () => JSON.parse(JSON.stringify(state)),
    /**
     * Writes the settings **after checking** every root. A wrong path does not enter: everything is
     * refused and the culprit is named, instead of saving half.
     */
    set({ defaultProject, allowedRoots }, probes = {}) {
      const next = { ...state };
      if (typeof defaultProject === 'string') {
        const wanted = defaultProject.trim();
        if (wanted) {
          const checked = checkRoot(wanted, probes);
          if (!checked.ok) return { ok: false, reason: `projects folder: ${checked.reason}` };
          next.defaultProject = checked.path;
        } else {
          next.defaultProject = '';
        }
      }
      if (Array.isArray(allowedRoots)) {
        const roots = [];
        for (const entry of allowedRoots) {
          const checked = checkRoot(entry, probes);
          if (!checked.ok) return { ok: false, reason: `allowed root "${entry}": ${checked.reason}` };
          if (!roots.includes(checked.path)) roots.push(checked.path);
        }
        next.allowedRoots = roots;
      }
      state = next;
      save();
      return { ok: true, settings: JSON.parse(JSON.stringify(state)) };
    },
  };
}

/**
 * Saved settings fill **only the holes** the environment has not already filled — the same rule as
 * access: an environment variable always wins, and a test can force everything without touching the
 * file of whoever uses the machine.
 */
export function applySettings(config, saved) {
  const applied = [];
  if (saved?.defaultProject && !process.env.CR_DEFAULT_PROJECT && !process.env.CR_PROJECT_DIR) {
    config.defaultProject = saved.defaultProject;
    applied.push('defaultProject');
  }
  // Roots are **added** to the starting one (the home folder), not replaced: home must stay usable,
  // otherwise the panel itself could no longer open anything.
  if (saved?.allowedRoots?.length && !process.env.CR_ALLOWED_ROOTS) {
    config.allowedRoots = [...new Set([...config.allowedRoots, ...saved.allowedRoots])];
    applied.push('allowedRoots');
  }
  return applied;
}