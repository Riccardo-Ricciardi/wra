import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function targetFile(home = os.homedir()) {
  return path.join(home, '.cc-remote', 'target.json');
}

// Precedenza: file del target (scritto da `rc target`) > CR_PROJECT_DIR > auto-discovery.
export function readTarget(config, home = os.homedir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(targetFile(home), 'utf8'));
    if (parsed?.projectDir) {
      return { projectDir: parsed.projectDir, sessionId: parsed.sessionId ?? '', source: 'file', updatedAt: parsed.updatedAt ?? null };
    }
  } catch {
    // nessun file, o illeggibile: si ricade sulla configurazione
  }
  if (config?.projectDir) return { projectDir: config.projectDir, sessionId: '', source: 'env', updatedAt: null };
  return { projectDir: '', sessionId: '', source: 'auto', updatedAt: null };
}

export function writeTarget({ projectDir, sessionId = '', updatedAt = new Date().toISOString() }, home = os.homedir()) {
  const file = targetFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ projectDir, sessionId, updatedAt }, null, 2)}\n`);
  return file;
}

export function clearTarget(home = os.homedir()) {
  try {
    fs.unlinkSync(targetFile(home));
    return true;
  } catch {
    return false;
  }
}
