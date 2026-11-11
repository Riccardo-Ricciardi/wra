import fs from 'node:fs';
import { writeFileAtomic } from '../core/atomic.mjs';

/**
 * The choice of outside access, written to disk: which mode, with which hostname.
 *
 * It exists because a choice must not depend on a line in a PowerShell profile. Environment
 * variables remain the way to **force** a value (and they always win); this file is what happens
 * when there is no variable — and the server needs it even when it is started from another window,
 * or from a scheduled task, where the profile is not there.
 *
 * There are no secrets in here: hostname, mode, and nothing else. The token stays where it is.
 */
export function createAccessStore({ file, now = () => Date.now() }) {
  let state = { version: 1, tailscale: null, cloudflare: null };

  const read = (filename) => {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid access config');
    return parsed;
  };

  const load = () => {
    if (!fs.existsSync(file)) return state;
    try {
      state = read(file);
    } catch (primaryError) {
      // As with the registry: a broken file is not silently reset, and the original is set aside
      // instead of thrown away — it is the only trace of which mode had been chosen.
      try {
        const recovered = read(`${file}.bak`);
        const damaged = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, damaged);
        fs.copyFileSync(`${file}.bak`, file);
        state = recovered;
        console.warn(`Access configuration recovered from backup; the broken original is in ${damaged}`);
      } catch {
        // No backup: continue with the empty configuration. Here it is the right case to do so —
        // no conversation is lost, and without outside access you still get in from this machine.
        console.warn(`Access configuration unreadable (${file}): access is limited to this machine`);
        state = { version: 1, tailscale: null, cloudflare: null };
      }
    }
    return state;
  };

  const save = () => {
    writeFileAtomic(file, `${JSON.stringify({ ...state, version: 1, updatedAt: new Date(now()).toISOString() }, null, 2)}\n`, {
      verify: (parsed) => {
        if (!parsed || typeof parsed !== 'object') throw new Error('invalid access config');
      },
    });
  };

  return {
    load,
    /** The configuration as it is on disk, with no surprises: a copy. */
    get: () => JSON.parse(JSON.stringify(state)),
    /**
     * Turns a mode on, leaving the other as it is: both can be used together, and that is
     * intended (the tailnet for the phone, the domain for the browser).
     */
    set(mode, values) {
      if (mode !== 'tailscale' && mode !== 'cloudflare') throw new Error(`unknown mode: ${mode}`);
      state[mode] = { ...values, at: new Date(now()).toISOString() };
      save();
      return state[mode];
    },
    /** Turns a mode off, or all of them if none is named. */
    clear(mode = null) {
      if (mode) state[mode] = null;
      else state.tailscale = state.cloudflare = null;
      save();
      return state;
    },
  };
}