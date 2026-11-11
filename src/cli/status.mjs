#!/usr/bin/env node
// `wra status` — does the server answer? which chats are there, and who is talking to what.
import { call, baseUrl, token } from './api.mjs';

if (!token()) {
  console.error('no token: start the server with `wra start` (it writes it to ~/.cc-remote/token)');
  process.exit(1);
}

try {
  const health = await call('/healthz');
  const busy = health.sessions.filter((session) => session.busy).length;
  console.log(`server: ${baseUrl()} — up`);
  console.log(`MCP bridge: ${health.mcp ? 'up' : 'down'}`);
  console.log(`chats: ${health.sessions.length} (${busy} busy) · allowed to MCP: ${health.sessions.filter((s) => s.mcpReachable).length}`);
  for (const session of health.sessions) {
    const badge = session.mcpReachable ? 'MCP' : '   ';
    const queue = health.turns?.sessions?.find((turn) => turn.sessionId === session.sessionId)?.waiting ?? 0;
    console.log(`  ${badge}  ${session.sessionId.slice(0, 8)}  ${session.name.padEnd(18)} ${session.state.padEnd(9)} ${queue ? `queue:${queue}` : ''}  ${session.projectPath}`);
  }
  for (const choice of health.mcpSelections) {
    const name = health.sessions.find((session) => session.sessionId === choice.sessionId)?.name ?? choice.sessionId;
    console.log(`  MCP ${choice.clientId.slice(0, 8)} is talking to: ${name}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
