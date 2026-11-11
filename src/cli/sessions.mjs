#!/usr/bin/env node
// `wra sessions` — list of conversations, with state and whether they are allowed to MCP.
import { call, readSelection } from './api.mjs';

const { sessions, selections } = await call('/local/sessions');
const selected = readSelection();

if (!sessions.length) {
  console.log('no chats: `wra new` to open one here, or from the browser');
  process.exit(0);
}

for (const session of sessions) {
  const mark = session.sessionId === selected ? '*' : ' ';
  const mcp = session.mcpReachable ? 'MCP' : '   ';
  console.log(`${mark} ${session.sessionId.slice(0, 8)}  ${session.name.padEnd(20)} ${session.state.padEnd(9)} ${mcp}  ${session.projectPath}`);
}
if (selections.length) {
  console.log('');
  for (const choice of selections) console.log(`  MCP ${choice.clientId.slice(0, 8)} → ${choice.sessionId.slice(0, 8)}`);
}
