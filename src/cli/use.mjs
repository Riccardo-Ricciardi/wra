#!/usr/bin/env node
// `wra use <id|name>` — chooses the chat for THIS machine (CLI and local talk). It does not touch
// ChatGPT's choice: that belongs to each MCP client, and is done with select_chat.
import { call, findSession, writeSelection } from './api.mjs';

const needle = process.argv.slice(2).join(' ').trim();
if (!needle) {
  const { sessions } = await call('/local/sessions');
  console.log('usage: wra use <id|name>. Available chats:');
  for (const session of sessions) console.log(`  ${session.sessionId.slice(0, 8)}  ${session.name}`);
  process.exit(0);
}

const { sessions } = await call('/local/sessions');
const found = findSession(sessions, needle);
if (!found) {
  console.error(`no chat matches "${needle}"`);
  process.exit(1);
}
writeSelection(found.sessionId);
console.log(`selected: ${found.name} (${found.sessionId.slice(0, 8)})`);
