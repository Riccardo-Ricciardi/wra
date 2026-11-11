import { z } from 'zod';
import { info } from '../log.mjs';

/**
 * The four tools an MCP client can call. They are bound to a **client** (its OAuth `clientId`):
 * the chat selected with `select_chat` belongs to that client, and is not shared with other clients.
 *
 * A rule that applies to all of them: you can see and touch **only** what has been authorized by
 * hand. An explicit `session_id` is not a shortcut around the permission.
 *
 * Authorization is read from `mcpReachable`, not from `mcpAllowed`: on a chat that skips permissions
 * the switch alone is not enough — the owner's recorded consent to *that exposure* is required
 * (`mcpBypassAt`). `mcpAllowed` is the raw choice that draws the switch in the browser, and reading
 * it here would mean that a chat in bypass is reachable just because someone left the switch on.
 */
export function createMcpTools({ config, registry, coordinator, selections, clientId = 'anonymous' }) {
  const allowed = () => registry.mcpAllowed();

  const describe = (session) => ({
    session_id: session.sessionId,
    name: session.name,
    project: session.projectPath,
    state: session.state,
    busy: session.busy,
    // Read-only: an MCP client cannot change it (none of the tools touches permissions). It is
    // there to know **from outside** whether the chat being used is one of those with permissions
    // skipped — something worth seeing, not discovering later.
    permission_mode: session.permissionMode,
  });

  const notAllowed = () => ({
    content: [{
      type: 'text',
      text: 'No chat is allowed for MCP. Open one in the browser and turn on "Allow ChatGPT".',
    }],
    structuredContent: { status: 'error', error: 'no authorized chat', chats: [] },
  });

  const listChats = async () => {
    const chats = allowed().map(describe);
    const selected = selections.get(clientId);
    return {
      content: [{
        type: 'text',
        text: chats.length
          ? chats.map((chat) => `${chat.session_id} — ${chat.name} (${chat.state}${chat.busy ? ', busy' : ''}) — ${chat.project}${chat.permission_mode === 'bypassPermissions' ? ' — PERMISSIONS SKIPPED' : ''}`).join('\n')
          : 'No chats are allowed for MCP.',
      }],
      structuredContent: { chats, selected_session_id: selected },
    };
  };

  const selectChat = async ({ session_id: sessionId }) => {
    const session = registry.get(sessionId);
    if (!session || !session.mcpReachable) {
      return {
        content: [{ type: 'text', text: `Chat ${sessionId} is not authorized. Use list_chats to see the allowed ones.` }],
        structuredContent: { status: 'error', error: 'chat not authorized' },
      };
    }
    selections.set(clientId, sessionId);
    return {
      content: [{ type: 'text', text: `From now on I'll talk to "${session.name}" (${sessionId}).` }],
      structuredContent: { status: 'ok', session_id: sessionId, name: session.name },
    };
  };

  const talk = async ({ message, session_id: explicitId, request_id: requestId, wait_seconds: waitSeconds }) => {
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) {
      return {
        content: [{ type: 'text', text: 'A message is required.' }],
        structuredContent: { status: 'error', error: 'missing message' },
      };
    }

    const target = explicitId || selections.get(clientId) || null;
    if (!target) {
      const chats = allowed().map(describe);
      if (!chats.length) return notAllowed();
      return {
        content: [{
          type: 'text',
          text: `No chat is selected. Call select_chat with one of these ids:\n${chats.map((chat) => `${chat.session_id} — ${chat.name}`).join('\n')}`,
        }],
        structuredContent: { status: 'error', error: 'no chat selected', chats },
      };
    }

    const session = registry.get(target);
    if (!session) {
      return {
        content: [{ type: 'text', text: `Unknown chat: ${target}` }],
        structuredContent: { status: 'error', error: 'unknown chat' },
      };
    }
    if (!session.mcpReachable) {
      return {
        content: [{ type: 'text', text: `The chat "${session.name}" is not authorized for MCP.` }],
        structuredContent: { status: 'error', error: 'chat not authorized', session_id: target },
      };
    }

    // The operations log: a turn that a remote client sends to a chat **that skips permissions**
    // is always recorded, with the chat and who requested it. It is the line that, reading the
    // log afterwards, says what went through without anyone approving anything — and from which client.
    if (session.permissionMode === 'bypassPermissions') {
      info('MCP turn on a chat that skips permissions', { sessionId: target, name: session.name, client: clientId, chars: text.length });
    }

    let submitted;
    try {
      submitted = coordinator.submit({
        sessionId: target,
        message: text,
        source: 'mcp',
        requestId: typeof requestId === 'string' && requestId.trim() ? requestId.trim() : null,
      });
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Cannot start the turn: ${error.message}` }],
        structuredContent: { status: 'error', error: error.message, session_id: target },
      };
    }

    // The `request_id` is chosen by the client. If one already spent by **another** chat is
    // reused, the coordinator returns that turn — that is, the reply of a conversation this client
    // has no right to read. It is not served: the id is reported as already taken.
    if (submitted.turn.sessionId !== target) {
      return {
        content: [{ type: 'text', text: `request_id ${requestId} has already been used for another conversation: use a new one.` }],
        structuredContent: { status: 'error', error: 'request_id already used for another conversation', session_id: target },
      };
    }

    const seconds = Math.min(Math.max(Number(waitSeconds) || config.defaultWaitSeconds, 5), config.maxWaitSeconds);
    const waited = await coordinator.settle(submitted.turn, seconds * 1000);
    return render(waited, submitted.reused, text);
  };

  const getTurnStatus = async ({ request_id: requestId, turn_id: turnId }) => {
    let turn = turnId ? coordinator.get(turnId) : requestId ? coordinator.byRequest(requestId) : null;
    // Without an id: the latest turn of the selected chat. That is the case of someone who lost
    // the `turnId` — a new connection, a client that does not carry it over. Without this, the
    // only recoverable reply would be the one whose name you remember, and a long turn would be
    // lost just because the call that started it expired.
    if (!turn) {
      const selected = selections.get(clientId);
      if (selected) turn = coordinator.latest(selected);
    }
    // And the turn must belong to a chat this client can **still** reach. Without this, revocation
    // would only apply to new requests: whoever already has the `turnId` — or the selection, or a
    // `request_id` they know — would keep reading the replies of a conversation the owner just
    // removed from MCP. "Revocable" means this too. The answer is "not found", not "not
    // authorized": a turn that cannot be read must not even confirm it exists.
    const owner = turn ? registry.get(turn.sessionId) : null;
    if (!turn || !owner?.mcpReachable) {
      return {
        content: [{ type: 'text', text: 'Turn not found (wrong id, or too old).' }],
        structuredContent: { status: 'error', error: 'turn not found' },
      };
    }
    return render(turn, true, null);
  };

  function render(turn, reused, sentText) {
    if (!turn) {
      return {
        content: [{ type: 'text', text: 'Turn lost.' }],
        structuredContent: { status: 'error', error: 'turn not found' },
      };
    }

    const how = `Call get_turn_status with request_id ${turn.requestId ?? turn.turnId}.`;
    const data = {
      status: turn.state,
      turnId: turn.turnId,
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      elapsedMs: turn.elapsedMs,
      reused,
      // How many listening windows have followed one another: 1 means the turn finished within
      // the first. It distinguishes "long work" from "something is off" without guessing.
      ...(turn.watches ? { watches: turn.watches } : {}),
      ...(turn.reply ? { reply: turn.reply } : {}),
      ...(turn.state === 'queued' ? { position: turn.position } : {}),
      ...(turn.state !== 'done' && turn.partial ? { partial: turn.partial } : {}),
      ...(turn.error ? { error: turn.error } : {}),
    };

    if (turn.state === 'done') {
      return { content: [{ type: 'text', text: turn.reply || '(no text)' }], structuredContent: data };
    }
    if (turn.state === 'queued') {
      return {
        content: [{ type: 'text', text: `Turn queued (${turn.position} ahead). ${how}` }],
        structuredContent: data,
      };
    }
    if (turn.state === 'running') {
      return {
        content: [{
          type: 'text',
          text: `The turn is still running (${Math.round(turn.elapsedMs / 1000)}s). ${how}${turn.partial ? `\n\nPartial:\n${turn.partial}` : ''}`,
        }],
        structuredContent: data,
      };
    }
    if (turn.state === 'timeout') {
      // This is not an "error": it is a turn that did not finish within the limit. The partial is
      // the useful thing to return, and it must be said that the turn was **not** cancelled — if
      // the agent finishes, the reply arrives in the transcript.
      const reason = turn.error ? `: ${turn.error}` : '.';
      return {
        content: [{
          type: 'text',
          text: `The turn did not finish within the limit (${Math.round(turn.elapsedMs / 1000)}s)${reason}${turn.partial ? `\n\nPartial:\n${turn.partial}` : ''}`,
        }],
        structuredContent: data,
      };
    }
    // The reason is almost always there; when it is not, say so instead of printing `null` — which
    // is what the client read, and it told it nothing.
    return {
      content: [{ type: 'text', text: `Error: ${turn.error ?? 'reason not recorded (see the server log)'}` }],
      structuredContent: data,
    };
  }

  return {
    list_chats: { run: listChats, inputSchema: {} },
    select_chat: {
      run: selectChat,
      inputSchema: { session_id: z.string().describe('Id of an allowed chat, from list_chats.') },
    },
    talk: {
      run: talk,
      inputSchema: {
        message: z.string().max(config.maxMessageChars).describe('The message to send to the agent.'),
        session_id: z.string().optional().describe('Destination chat. If missing, the one selected with select_chat is used.'),
        request_id: z.string().optional().describe('Id of your request: resending it does not execute twice.'),
        // The real limit is `config.maxWaitSeconds`, and it is applied by **clamping**, not by
        // rejecting: a client asking for 300 seconds receives the longest allowed reply, not a
        // validation error. Rejecting would leave it with nothing to read.
        wait_seconds: z.number().int().min(5).max(600).optional()
          .describe(`How long to wait for the reply before returning with the status (default ${config.defaultWaitSeconds}, `
            + `maximum ${config.maxWaitSeconds}). A long turn is not lost: resume it with get_turn_status.`),
      },
    },
    get_turn_status: {
      run: getTurnStatus,
      inputSchema: {
        request_id: z.string().optional().describe('The request_id given to talk.'),
        turn_id: z.string().optional().describe('Alternatively, the turnId returned by talk.'),
      },
    },
  };
}