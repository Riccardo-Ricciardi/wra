// Fixture per provare la UI nuova senza toccare le conversazioni vere.
// Crea uno stato isolato: registro, progetti, e un transcript sintetico.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = process.argv[2] ?? path.join(os.tmpdir(), 'ccr-ui');
const state = path.join(root, 'state');
const projectsRoot = path.join(root, 'projects');
const demo = path.join(root, 'demo-project');
const second = path.join(root, 'second-project');

for (const dir of [state, projectsRoot, demo, second]) fs.mkdirSync(dir, { recursive: true });

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const id = '11111111-2222-4333-8444-555555555555';

const sessions = [
  {
    sessionId: id,
    projectPath: demo,
    name: 'Refactor the auth flow',
    createdAt: iso(180),
    lastActivityAt: iso(4),
    permissionMode: 'default',
    mcpAllowed: true,
    favorite: true,
  },
  {
    sessionId: '22222222-3333-4444-8555-666666666666',
    projectPath: demo,
    name: 'Fix the flaky login test',
    createdAt: iso(1500),
    lastActivityAt: iso(90),
    permissionMode: 'acceptEdits',
    mcpAllowed: false,
  },
  {
    sessionId: '33333333-4444-4555-8666-777777777777',
    projectPath: second,
    name: 'Design the settings page',
    createdAt: iso(4000),
    lastActivityAt: iso(3000),
    permissionMode: 'plan',
    mcpAllowed: false,
  },
  {
    sessionId: '44444444-5555-4666-8777-888888888888',
    projectPath: second,
    name: 'Bypass experiment',
    createdAt: iso(9000),
    lastActivityAt: iso(8000),
    permissionMode: 'bypassPermissions',
    mcpAllowed: false,
  },
];

fs.writeFileSync(path.join(state, 'sessions.json'), JSON.stringify({ sessions }, null, 2));
fs.writeFileSync(
  path.join(state, 'projects.json'),
  JSON.stringify(
    {
      projects: [
        { path: demo, name: 'Demo project', favorite: true, hidden: false, autoApprove: false },
        { path: second, name: 'Second project', favorite: false, hidden: false, autoApprove: true },
      ],
    },
    null,
    2,
  ),
);

const entries = [
  {
    type: 'user',
    uuid: 'u1',
    timestamp: iso(30),
    message: { content: 'Can you refactor the auth flow so the token check is in one place?' },
  },
  {
    type: 'assistant',
    uuid: 'a1',
    timestamp: iso(29),
    message: {
      model: 'claude-sonnet-5-5',
      content: [
        { type: 'thinking', thinking: 'The token check is duplicated in three routes. I should extract it into a single middleware.' },
        { type: 'text', text: "I'll start by finding every place that checks the token." },
        { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'sameToken\\(', path: 'src' } },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u2',
    timestamp: iso(28),
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'src/net/server.mjs:3\nsrc/net/ws.mjs:2\nsrc/net/ui-auth.mjs:1' }] },
    toolUseResult: { stdout: 'src/net/server.mjs:3\nsrc/net/ws.mjs:2\nsrc/net/ui-auth.mjs:1' },
  },
  {
    type: 'assistant',
    uuid: 'a2',
    timestamp: iso(27),
    message: {
      content: [
        { type: 'text', text: 'Three call sites. I will extract the comparison into `core/token.mjs` and import it everywhere.' },
        {
          type: 'tool_use',
          id: 't2',
          name: 'Edit',
          input: { file_path: 'src/net/server.mjs', old_string: 'const sameToken = ...', new_string: "import { sameToken } from '../core/token.mjs';" },
        },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u3',
    timestamp: iso(26),
    message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
    toolUseResult: {
      filePath: 'src/net/server.mjs',
      type: 'update',
      structuredPatch: [
        {
          oldStart: 12,
          newStart: 12,
          lines: [
            '-const sameToken = (a, b) => {',
            '-  if (!b) return false;',
            '-  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));',
            '-};',
            "+import { sameToken } from '../core/token.mjs';",
          ],
        },
      ],
    },
  },
  {
    type: 'assistant',
    uuid: 'a3',
    timestamp: iso(25),
    message: {
      content: [
        { type: 'text', text: 'Done. The check now lives in one module, and all three routes import it.\n\n- `server.mjs`\n- `ws.mjs`\n- `ui-auth.mjs`' },
      ],
    },
  },
];

const mangled = demo.replace(/[^A-Za-z0-9]/g, '-');
const transcriptDir = path.join(projectsRoot, mangled);
fs.mkdirSync(transcriptDir, { recursive: true });
fs.writeFileSync(
  path.join(transcriptDir, `${id}.jsonl`),
  entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
);

console.log(JSON.stringify({ root, state, projectsRoot, demo, second, sessionId: id }, null, 2));
