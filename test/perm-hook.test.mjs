import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

// L'hook è il pezzo che il `claude` vero esegue: qui lo si esegue davvero, come farebbe lui
// (processo a parte, JSON su stdin, risposta su stdout), contro un server finto.
//
// La regola in prova: tutto quello che non è una decisione esplicita deve finire in silenzio.
// Silenzio vuol dire «mostra il dialog nel terminale»; un `allow` scritto per sbaglio sarebbe
// un permesso regalato.

const HOOK = path.join(import.meta.dirname, '..', 'src', 'host', 'perm-hook.mjs');
const TOKEN = 'token-di-prova';

function stubServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runHook({ url, sessionId = 's1', env = {}, payload }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        CR_APPROVE_URL: url,
        CR_APPROVE_TOKEN: TOKEN,
        CR_APPROVE_SESSION: sessionId,
        CR_APPROVE_TTL_MS: '2000',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
    child.on('close', () => resolve(out));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

const permissionRequest = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf /tmp/x' },
  permission_suggestions: [{ type: 'addRules' }],
};

test('la decisione della persona torna al TUI nella forma che si aspetta', async () => {
  let received = null;
  const { server, port } = await stubServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received = { body: JSON.parse(body), token: request.headers['x-cc-remote-token'] };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ decision: { behavior: 'allow' } }));
    });
  });
  try {
    const out = await runHook({ url: `http://127.0.0.1:${port}/local/approve`, payload: permissionRequest });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.equal(parsed.hookSpecificOutput.decision.behavior, 'allow');
    assert.equal(received.token, TOKEN);
    assert.equal(received.body.sessionId, 's1', 'la sessione è quella che il server ci ha dato, non quella del TUI');
    assert.equal(received.body.toolName, 'Bash');
    assert.equal(received.body.input.command, 'rm -rf /tmp/x');
    assert.equal(received.body.suggestions.length, 1);
  } finally {
    server.close();
  }
});

test('un rifiuto porta con sé il motivo', async () => {
  const { server, port } = await stubServer((_request, response) => {
    response.end(JSON.stringify({ decision: { behavior: 'deny', message: 'non stanotte' } }));
  });
  try {
    const out = await runHook({ url: `http://127.0.0.1:${port}/local/approve`, payload: permissionRequest });
    const decision = JSON.parse(out).hookSpecificOutput.decision;
    assert.equal(decision.behavior, 'deny');
    assert.equal(decision.message, 'non stanotte');
  } finally {
    server.close();
  }
});

test('«non decido io» non scrive niente: il dialog del terminale resta', async () => {
  const { server, port } = await stubServer((_request, response) => {
    response.end(JSON.stringify({ decision: null }));
  });
  try {
    assert.equal(await runHook({ url: `http://127.0.0.1:${port}/local/approve`, payload: permissionRequest }), '');
  } finally {
    server.close();
  }
});

test('server irraggiungibile, errore HTTP o risposta storta: sempre silenzio', async () => {
  const broken = await stubServer((_request, response) => {
    response.statusCode = 500;
    response.end('no');
  });
  const garbage = await stubServer((_request, response) => response.end(JSON.stringify({ decision: { behavior: 'forse' } })));
  try {
    assert.equal(await runHook({ url: 'http://127.0.0.1:1/local/approve', payload: permissionRequest }), '');
    assert.equal(await runHook({ url: `http://127.0.0.1:${broken.port}/local/approve`, payload: permissionRequest }), '');
    assert.equal(await runHook({ url: `http://127.0.0.1:${garbage.port}/local/approve`, payload: permissionRequest }), '');
  } finally {
    broken.server.close();
    garbage.server.close();
  }
});

test('un evento che non è PermissionRequest non tocca il server', async () => {
  let touched = false;
  const { server, port } = await stubServer((_request, response) => { touched = true; response.end('{}'); });
  try {
    const out = await runHook({
      url: `http://127.0.0.1:${port}/local/approve`,
      payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
    });
    assert.equal(out, '');
    assert.equal(touched, false);
  } finally {
    server.close();
  }
});

test('senza configurazione (nessun server da chiamare) esce subito e in silenzio', async () => {
  const out = await runHook({ url: '', payload: permissionRequest });
  assert.equal(out, '');
});
