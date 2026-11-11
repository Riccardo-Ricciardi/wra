// The process ledger: which `claude` processes **this** server started, with which pid and for
// which conversation. It serves one case only, and it is the one the HANDOFF calls "the known
// limitation": if the server is killed by force (`taskkill /F`, Task Manager, a crash), its PTYs are
// left orphaned — the `claude` of every open conversation survives its parent — and on restart the
// registry does not know that process is alive, starts another, and there are **two** agents on the
// same conversation.
//
// A Windows *job object* would be the real solution (children die with the parent) and cannot be
// done from Node without native code: a process can only be *assigned* to a job, and the process is
// already inside the Windows Terminal one. So we do the second best thing, which is also the only
// verifiable one: we write down what we started, and on restart we look at what is left.
//
// Writing here must **never** be able to break a session: every error is swallowed, and the file is
// just one more clue for diagnostics.
import fs from 'node:fs';
import path from 'node:path';

/** Next to the registry, like all the rest of the state: a test rig does not touch the real one. */
export const ledgerFile = (config) => path.join(path.dirname(config.stateFile), 'processes.json');

export function createProcessLedger({ file, now = () => Date.now() }) {
  const read = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed?.processes) ? parsed.processes : [];
    } catch {
      return [];
    }
  };

  const write = (processes) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ savedAt: new Date(now()).toISOString(), processes }, null, 2)}\n`);
    } catch {
      // the process ledger is an extra: if it cannot be written, a clue is lost, not a chat
    }
  };

  return {
    file,
    all: () => read(),
    /** A process started now. `sessionId` is the conversation, `at` when it started. */
    note({ pid, sessionId, name = null, startedAt = null }) {
      if (!Number.isInteger(pid) || pid <= 0) return;
      write([...read().filter((entry) => entry.pid !== pid), {
        pid, sessionId, name, startedAt, at: new Date(now()).toISOString(),
      }]);
    },
    /** Exited: no longer a clue about anything. */
    forget(pid) {
      const entries = read();
      const next = entries.filter((entry) => entry.pid !== pid);
      if (next.length !== entries.length) write(next);
    },
    /** The server shut down **cleanly**: there is nothing residual to look for. */
    clear() {
      write([]);
    },
    /**
     * Who is left: the pids written here that are still alive. `alive` is injectable because the
     * question "is this pid alive?" belongs to the environment, not to this file.
     *
     * @param {(pid: number) => boolean} alive
     */
    leftovers(alive) {
      return read().filter((entry) => alive(entry.pid));
    },
  };
}