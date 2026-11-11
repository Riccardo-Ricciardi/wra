#!/usr/bin/env node
// `wra detach [id|name]` — detaches the attached windows, without touching the conversations.
//
// Why it exists, given that Ctrl+Q does: because detaching must not depend on a key. A terminal
// can swallow a combination (it happens on Windows: some sequences never reach the application),
// so there needs to be a way that does not go through the keyboard. This is that way — and since
// the server releases the attachment, it also works from another window.
//
// The chat process stays up: it closes the client, not the conversation.
import { call, findSession } from './api.mjs';

const needle = process.argv.slice(2).filter((arg) => !arg.startsWith('--')).join(' ').trim();

try {
  let sessionId = null;
  if (needle) {
    const { sessions } = await call('/local/sessions');
    const target = findSession(sessions, needle);
    if (!target) {
      console.error(`no chat matches "${needle}"`);
      process.exit(1);
    }
    sessionId = target.sessionId;
  }
  const { detached } = await call('/local/detach', { method: 'POST', body: { sessionId } });
  if (detached === 0) {
    console.log(sessionId
      ? 'no windows attached to that chat (the browser does not detach: it would reconnect)'
      : 'no windows attached (the browser does not detach: it would reconnect)');
  } else {
    console.log(`detached ${detached} windows: the conversations stay alive in the server`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
