import fs from 'node:fs';
import { writeFileAtomic } from '../core/atomic.mjs';
import { pathKey } from '../core/workspace.mjs';

/**
 * The **organizational** metadata of projects: the displayed name, the star, whether it is hidden.
 *
 * They live in their own file, separate from the conversation registry, for a precise reason:
 * renaming a project in the interface must not be able to touch either the real folder path or the
 * conversations living inside it. They are two different things and live in two different places —
 * so an error here cannot cost a conversation.
 *
 * The key is the normalized path: the folder is the identity, the name is a label.
 */
export function createProjectStore({ file, now = () => Date.now() }) {
  let projects = [];

  const read = (filename) => {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(parsed?.projects)) throw new Error('invalid project metadata');
    return parsed.projects.filter((entry) => entry && typeof entry.path === 'string' && entry.path);
  };

  const load = () => {
    if (!fs.existsSync(file)) {
      projects = [];
      return projects;
    }
    try {
      projects = read(file);
    } catch (primaryError) {
      // As with the registry: nothing is silently reset. If the file is broken, the backup is
      // tried, and the original is set aside instead of thrown away.
      try {
        const recovered = read(`${file}.bak`);
        const damaged = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, damaged);
        fs.copyFileSync(`${file}.bak`, file);
        projects = recovered;
        console.warn(`Project metadata recovered from backup; the broken original is in ${damaged}`);
      } catch (backupError) {
        throw new Error(`Project metadata unreadable (${file}); primary and backup are broken.`, { cause: new AggregateError([primaryError, backupError]) });
      }
    }
    return projects;
  };

  const save = () => {
    writeFileAtomic(
      file,
      `${JSON.stringify({ version: 1, savedAt: new Date(now()).toISOString(), projects }, null, 2)}\n`,
      { verify: (parsed) => { if (!Array.isArray(parsed?.projects)) throw new Error('invalid project metadata'); } },
    );
  };

  return {
    load,
    all: () => projects.map((entry) => ({ ...entry })),

    /** The metadata of a folder, if any: `null` means "nobody has ever touched it". */
    get(rawPath) {
      const key = pathKey(rawPath);
      const found = projects.find((entry) => entry.key === key);
      return found ? { ...found } : null;
    },

    /**
     * Writes the metadata of a folder. Absent fields stay as they were: the star and the name are
     * changed one at a time, without rewriting the other.
     */
    set(rawPath, fields = {}) {
      const key = pathKey(rawPath);
      if (!key) throw new Error('missing project path');
      let entry = projects.find((item) => item.key === key);
      if (!entry) {
        entry = {
          key, path: rawPath, name: null, favorite: false, hidden: false,
          // "Controlled automatic MCP" at the project level: off until someone explicitly turns it
          // on for this folder.
          autoApprove: false,
          createdAt: new Date(now()).toISOString(),
        };
        projects.push(entry);
      }
      if (typeof fields.name === 'string') {
        const clean = fields.name.trim().slice(0, 60);
        entry.name = clean || null;
      }
      if (typeof fields.favorite === 'boolean') entry.favorite = fields.favorite;
      if (typeof fields.hidden === 'boolean') entry.hidden = fields.hidden;
      if (typeof fields.autoApprove === 'boolean') entry.autoApprove = fields.autoApprove;
      // The path is realigned to the real one: if the same folder arrives written in a slightly
      // different way, the entry is the same but the displayed path must be the right one.
      entry.path = rawPath;
      entry.updatedAt = new Date(now()).toISOString();
      save();
      return { ...entry };
    },

    /**
     * Forgets several entries at once.
     *
     * `remove` one by one would work just as well, but every call writes — and `save()` keeps a copy
     * of what was there **before**, so at the end of the queue the copy would be the state before
     * the last removal, not before the operation. A single write makes the backup be the one that
     * matters: how the registry was before touching it.
     *
     * @param {string[]} rawPaths
     * @returns {number} how many entries really disappeared
     */
    forget(rawPaths) {
      const keys = new Set(rawPaths.map((raw) => pathKey(raw)));
      const before = projects.length;
      projects = projects.filter((entry) => !keys.has(entry.key));
      if (projects.length !== before) save();
      return before - projects.length;
    },

    /** Removes the metadata: the folder on disk is not touched, nor are its conversations. */
    remove(rawPath) {
      const key = pathKey(rawPath);
      const before = projects.length;
      projects = projects.filter((entry) => entry.key !== key);
      if (projects.length !== before) save();
      return projects.length !== before;
    },
  };
}