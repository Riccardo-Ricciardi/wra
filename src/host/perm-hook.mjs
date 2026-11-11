#!/usr/bin/env node
// Claude Code's `PermissionRequest` hook: the bridge between the TUI and the browser.
//
// Claude Code runs this file when a tool asks for a permission and **waits for the answer on
// stdout**. We fetch that answer from the WRA server, which in turn asks the person (browser or
// phone).
//
// The rule: if anything goes wrong — server down, time expired, unreadable answer — nothing is
// written. Not writing means "I am not deciding", and Claude Code shows its dialog in the terminal.
// The only outcome that must never happen by accident is an "allow": that is why every error path
// ends in silence, and the only allow is the one that comes from the server.
const url = process.env.CR_APPROVE_URL;
const token = process.env.CR_APPROVE_TOKEN;
const sessionId = process.env.CR_APPROVE_SESSION;
const ttlMs = Number(process.env.CR_APPROVE_TTL_MS) || 120_000;

async function main() {
  const raw = await new Promise((resolve) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buffer += chunk; });
    process.stdin.on('end', () => resolve(buffer));
  });

  let hook;
  try {
    hook = JSON.parse(raw);
  } catch {
    return;
  }
  if (!url || !token || !sessionId) return;
  if (hook?.hook_event_name !== 'PermissionRequest') return;

  let answer;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cc-remote-token': token },
      // a little more than the time the server grants the person: if it expires first, the answer
      // still arrives; if this expires first, we exit in silence.
      signal: AbortSignal.timeout(ttlMs + 10_000),
      body: JSON.stringify({
        sessionId,
        toolName: hook.tool_name,
        input: hook.tool_input ?? {},
        suggestions: hook.permission_suggestions ?? [],
      }),
    });
    if (!response.ok) return;
    answer = await response.json();
  } catch {
    return;
  }

  const decision = answer?.decision;
  if (decision?.behavior !== 'allow' && decision?.behavior !== 'deny') return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: decision.behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: decision.message || 'Rejected by WRA' },
    },
  }));
}

main().catch(() => {});