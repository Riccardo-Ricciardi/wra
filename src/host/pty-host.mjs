import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';

// On Windows node-pty calls CreateProcess, which does not apply PATHEXT: 'claude' is not enough,
// the real file is needed ('claude.exe'). Elsewhere the name is enough and the system resolves it.
export function resolveExecutable(command, env = process.env) {
  if (process.platform !== 'win32' || command.includes(path.sep)) return command;
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      for (const candidate of [path.join(dir, command + ext.toLowerCase()), path.join(dir, command + ext.toUpperCase())]) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return command;
}

// Inherited session markers would make the child believe it is our session: with
// CLAUDE_CODE_CHILD_SESSION the transcript is not written, and without a transcript the chat view
// and turn confirmation have nothing to read. They are removed from the child's environment.
const SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
];

export function childEnv(base = process.env) {
  const env = { ...base };
  for (const name of SESSION_MARKERS) delete env[name];
  return env;
}

/**
 * A PTY for a project folder, with the interactive `claude` inside — the real TUI, which is the
 * only way to have it in the browser. The user's environment passes through intact, so
 * `apiKeyHelper` and `ANTHROPIC_BASE_URL` keep working: that is the reason for the project.
 */
export function spawnClaude({
  projectDir,
  command = 'claude',
  cols = 120,
  rows = 40,
  args = [],
  env = process.env,
  onData,
  onExit,
}) {
  const file = resolveExecutable(command, env);
  const child = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: projectDir,
    env: childEnv(env),
  });

  const dataListeners = new Set();
  const exitListeners = new Set();
  if (onData) dataListeners.add(onData);
  if (onExit) exitListeners.add(onExit);

  let exited = false;
  child.onData((data) => {
    for (const listener of dataListeners) listener(data);
  });
  child.onExit((event) => {
    exited = true;
    for (const listener of exitListeners) listener(event);
  });

  return {
    projectDir,
    file,
    pid: child.pid,
    get exited() {
      return exited;
    },
    write: (data) => {
      if (!exited) child.write(data);
    },
    resize: (nextCols, nextRows) => {
      if (!exited && nextCols > 0 && nextRows > 0) child.resize(nextCols, nextRows);
    },
    kill: () => {
      if (exited) return;
      // `child.kill()` closes the direct child, but not the tree: node-pty, when the process that
      // closes does not have a console (a server, a test), cannot enumerate the console's processes
      // and falls back to the child alone. `claude`, however, launches its own — the MCP servers —
      // and those would remain hanging. On Windows the tree is closed explicitly.
      const pid = child.pid;
      // First we ask politely: a Node process killed by force while closing its handles prints a
      // libuv assertion, which looks like a failure rather than a shutdown.
      child.kill();
      if (process.platform === 'win32' && pid) {
        const force = setTimeout(() => {
          try {
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          } catch {
            // already dead, or nothing to close
          }
        }, 400);
        force.unref?.();
      }
    },
    onData: (listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
}

/** where Claude Code keeps the transcripts of a project */
export function transcriptDirFor(projectDir, projectsRoot = path.join(os.homedir(), '.claude', 'projects')) {
  return path.join(projectsRoot, projectDir.replace(/[^A-Za-z0-9]/g, '-'));
}