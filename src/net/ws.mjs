import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { TailingReader, readRecentEntries } from '../core/transcript.mjs';
import { ConversationLog } from '../core/conversation.mjs';
import { acceptedOrigins, normalizeHost, parseOrigins } from '../core/access.mjs';
import { createRateLimiter } from './rate-limit.mjs';

export const PROTO = 2;

const MAX_INPUT_BYTES = 256 * 1024;

const clampInt = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const sameToken = (given, expected) => {
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

// The token travels as a websocket subprotocol (`bearer.<token>`) because it is the only place a
// browser knows how to put it without ending up in URLs and logs; `?token=` remains for scripts.
export function tokenFrom(request, url) {
  const protocols = String(request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const protocol of protocols) {
    if (protocol.startsWith('bearer.')) return protocol.slice('bearer.'.length);
  }
  return url.searchParams.get('token') ?? null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// A server on loopback is reachable from anyone's browser on the machine through a domain that
// points to 127.0.0.1 (DNS rebinding). Only local origins are accepted, or the declared ones.
// Without Origin (scripts, `wra attach`) it is accepted: there is no browser to fool.
//
// The declared origins can be **more than one**: with Tailscale and Cloudflare on together the
// browser arrives from two addresses, and accepting only one would mean that from the other the
// page opens and stays mute — a failure that looks like a broken server.
export function originAllowed(origin, config = {}) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (LOOPBACK_HOSTS.has(parsed.hostname)) return true;
    // `acceptedOrigins` is the rule, in one place: the declared origins, plus the public hostname
    // when in single-host (see `core/access.mjs`).
    const declared = acceptedOrigins({
      publicOrigins: config.publicOrigins?.length ? config.publicOrigins : parseOrigins(config.publicOrigin),
      mcpHost: config.mcpHost,
      singleHost: config.singleHost,
    });
    return declared.some((entry) => {
      try {
        return parsed.origin === new URL(entry).origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// How many messages are sent to whoever opens a chat. The whole transcript would be heavy and
// useless: the conversation is watched from the tail.
const HISTORY_MESSAGES = 150;
// How far back it reads. The transcript does not contain only the conversation: the
// `api-request-blob` lines carry the entire request, and by themselves make a few hundred KB per
// turn. With a small window the user's question stayed out and the chat opened on an answer without
// a question. Better to read a few MB more from a local file.
const HISTORY_BYTES = 4 * 1024 * 1024;

/**
 * The contract between server and client (proto 2).
 *
 * Every client says who it is: `terminal` writes (keys and width), `viewer` and `chat` only watch —
 * whoever watches must not be able to resize the terminal of whoever writes. Clients attach to
 * **one session** (one chat), and the chat choice does not touch the others'.
 * The width rule remains: a `resize` is only an intention and is applied when that client writes.
 */
export function attachWeb({ server, registry, approvals = null, config }) {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      for (const protocol of protocols) if (String(protocol).startsWith('bearer.')) return protocol;
      return false;
    },
    maxPayload: 4 * 1024 * 1024,
  });

  const clients = new Set();
  const subscribers = new Map(); // sessionId -> Set<client>
  const chatTails = new Map(); // sessionId -> { reader, log, timer }

  const send = (client, message) => {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
  };

  const sessionsPayload = () => registry.list();

  const broadcast = (sessionId, message, filter = null) => {
    for (const client of subscribers.get(sessionId) ?? []) {
      if (filter && !filter(client)) continue;
      send(client, message);
    }
  };

  const notifySessions = () => {
    const sessions = sessionsPayload();
    for (const client of clients) send(client, { t: 'sessions', sessions });
  };

  // Approvals reach whoever is watching *that* chat, and nobody else: they are the request to decide
  // on something happening in there.
  approvals?.onEvent((event) => {
    if (event.type === 'asked') {
      broadcast(event.approval.sessionId, { t: 'approval', sessionId: event.approval.sessionId, approval: event.approval });
      return;
    }
    if (event.type === 'gone') {
      broadcast(event.sessionId, { t: 'approval_gone', sessionId: event.sessionId, id: event.id, reason: event.reason });
      return;
    }
    // A permission granted by the automatic policy: there is nothing to decide, but whoever is
    // watching that chat must see it go by — otherwise "the agent went ahead on its own" remains a
    // mystery to reconstruct by reading the transcript.
    if (event.type === 'auto') {
      broadcast(event.approval.sessionId, { t: 'approval_auto', sessionId: event.approval.sessionId, approval: event.approval });
    }
  });

  registry.onEvent((event) => {
    if (event.type === 'output') {
      broadcast(event.session.sessionId, { t: 'output', sessionId: event.session.sessionId, data: event.data });
      notifySessions(); // the state (busy/idle) may have changed
      return;
    }
    if (event.type === 'state' || event.type === 'reload') {
      // `reload` is a restore: the conversations are different ones, and whoever is watching must
      // see them all again.
      notifySessions();
    }
  });

  // --- chat: history from the transcript, then updates ---------------------
  // A message can be *updated* (a tool result arrives after the call), so the client replaces them
  // by id instead of queuing them.
  // The transcript of a newly created chat does not exist yet: it is born with the first message.
  // Asking for it too early is normal, not a failure.
  const readTranscript = (file) => {
    try {
      return readRecentEntries(file, HISTORY_BYTES);
    } catch {
      return [];
    }
  };

  function history(sessionId) {
    const tail = chatTails.get(sessionId);
    if (tail) return tail.log.messages.slice(-HISTORY_MESSAGES);
    const session = registry.get(sessionId);
    if (!session) return [];
    return ConversationLog.fromEntries(readTranscript(session.transcript)).messages.slice(-HISTORY_MESSAGES);
  }

  function startChatTail(sessionId) {
    if (chatTails.has(sessionId)) return;
    const session = registry.get(sessionId);
    if (!session) return;

    // It starts from the history already written, not from zero: without this, the result of a tool
    // called before opening the page would no longer find its card and would disappear.
    const log = ConversationLog.fromEntries(readTranscript(session.transcript));
    const reader = new TailingReader(session.transcript);
    reader.sync();

    const tail = { reader, log, timer: null };
    tail.timer = setInterval(() => {
      const changed = new Map();
      for (const entry of reader.readNew()) {
        const message = log.push(entry);
        if (message) changed.set(message.id, message);
      }
      if (changed.size) broadcast(sessionId, { t: 'chat', sessionId, messages: [...changed.values()] });
    }, 700);
    tail.timer.unref?.();
    chatTails.set(sessionId, tail);
  }

  function stopChatTailIfUnused(sessionId) {
    const set = subscribers.get(sessionId);
    const tail = chatTails.get(sessionId);
    if (!tail) return;
    const watchers = [...(set ?? [])].filter((client) => client.role === 'chat' || client.role === 'viewer' || client.role === 'terminal');
    if (watchers.length === 0) {
      clearInterval(tail.timer);
      chatTails.delete(sessionId);
    }
  }

  // --- clients ------------------------------------------------------------
  const subscribe = (client, sessionId) => {
    if (client.sessionId && client.sessionId !== sessionId) unsubscribe(client);
    client.sessionId = sessionId;
    if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
    subscribers.get(sessionId).add(client);
    startChatTail(sessionId);
  };

  const unsubscribe = (client) => {
    const set = client.sessionId && subscribers.get(client.sessionId);
    if (set) set.delete(client);
    const sessionId = client.sessionId;
    client.sessionId = null;
    if (sessionId) stopChatTailIfUnused(sessionId);
  };

  /** Whoever opens a chat must immediately see what is already waiting for an answer. */
  const sendPendingApprovals = (client, sessionId) => {
    for (const approval of approvals?.forSession(sessionId) ?? []) {
      send(client, { t: 'approval', sessionId, approval });
    }
  };

  const applyWriterSize = (client) => {
    if (!client.sessionId || client.role !== 'terminal') return;
    const cols = client.pendingSize?.cols ?? client.cols;
    const rows = client.pendingSize?.rows ?? client.rows;
    if (cols && rows) registry.setSize(client.sessionId, cols, rows);
  };

  const handlers = {
    hello(client, message) {
      client.role = message.role === 'viewer' || message.role === 'chat' ? message.role : 'terminal';
      client.cols = clampInt(message.cols, 20, 500, config.cols);
      client.rows = clampInt(message.rows, 5, 200, config.rows);
      // A `wra attach` window says so itself. It is not a detail: it is the only thing that can be
      // detached on request — the browser, if closed, reconnects by itself.
      client.attach = message.attach === true;

      send(client, { t: 'welcome', proto: PROTO, sessions: sessionsPayload() });

      if (message.sessionId) handlers.open(client, { sessionId: message.sessionId });
      else if (message.projectPath) handlers.open(client, { projectPath: message.projectPath, create: true });
    },

    sessions(client) {
      send(client, { t: 'sessions', sessions: sessionsPayload() });
    },

    create(client, message) {
      const session = registry.create({ projectPath: message.projectPath, name: message.name });
      subscribe(client, session.sessionId);
      send(client, { t: 'opened', session });
      notifySessions();
    },

    open(client, message) {
      if (message.sessionId) {
        const session = registry.get(message.sessionId);
        if (!session) {
          send(client, { t: 'error', message: `unknown session: ${message.sessionId}` });
          return;
        }
        // The process may fail to start: the folder is gone, the command is wrong, the machine is
        // full. The conversation **still exists** — that is the registry rule — and its history is
        // read from the transcript. Without this `try`, a failed start also took the history away:
        // the chat opened empty, and the only trace was a warning that scrolls by. Better: the
        // history, plus the reason there is no process.
        try {
          if (!registry.runtime(session.sessionId)) registry.start(session.sessionId);
        } catch (error) {
          send(client, { t: 'error', message: `the conversation opens, but the process does not start: ${error.message}` });
        }
        subscribe(client, session.sessionId);
        send(client, { t: 'opened', session: registry.get(session.sessionId), replay: registry.replay(session.sessionId) });
        // `history: true` tells the client "this is the whole conversation, replace what you have":
        // updates arriving later are instead merged by id.
        send(client, { t: 'chat', sessionId: session.sessionId, history: true, messages: history(session.sessionId) });
        sendPendingApprovals(client, session.sessionId);
        return;
      }
      if (message.projectPath) {
        const created = registry.create({ projectPath: message.projectPath, name: message.name });
        subscribe(client, created.sessionId);
        send(client, { t: 'opened', session: created, replay: registry.replay(created.sessionId) });
        send(client, { t: 'chat', sessionId: created.sessionId, messages: [] });
        notifySessions();
        return;
      }
      send(client, { t: 'error', message: 'sessionId or projectPath required' });
    },

    rename(client, message) {
      try {
        const session = registry.rename(message.sessionId, message.name);
        send(client, { t: 'opened', session });
        notifySessions();
      } catch (error) {
        send(client, { t: 'error', message: error.message });
      }
    },

    mcp_allowed(client, message) {
      try {
        const session = registry.setMcpAllowed(message.sessionId, message.allowed);
        send(client, { t: 'opened', session });
        notifySessions();
      } catch (error) {
        send(client, { t: 'error', message: error.message });
      }
    },

    approve(client, message) {
      // Whoever only watches does not grant permissions: read-only applies here too.
      if (client.role === 'viewer') {
        send(client, { t: 'error', message: 'read-only: you cannot approve' });
        return;
      }
      try {
        const decided = approvals?.decide(message.id, { behavior: message.behavior, message: message.reason });
        if (!decided) send(client, { t: 'error', message: 'request no longer pending' });
      } catch (error) {
        send(client, { t: 'error', message: error.message });
      }
    },

    stop(client, message) {
      try {
        registry.stop(message.sessionId);
        notifySessions();
      } catch (error) {
        send(client, { t: 'error', message: error.message });
      }
    },

    forget(client, message) {
      try {
        registry.forget(message.sessionId);
        notifySessions();
      } catch (error) {
        send(client, { t: 'error', message: error.message });
      }
    },

    input(client, message) {
      if (client.role !== 'terminal') {
        send(client, { t: 'error', message: 'read-only: use a terminal window to write' });
        return;
      }
      if (!client.sessionId) {
        send(client, { t: 'error', message: 'open a chat first' });
        return;
      }
      if (typeof message.data !== 'string') return;
      if (Buffer.byteLength(message.data) > MAX_INPUT_BYTES) {
        send(client, { t: 'error', message: 'input too large' });
        return;
      }
      applyWriterSize(client);
      const running = registry.runtime(client.sessionId);
      if (!running) {
        // It used to be discarded silently: whoever typed saw the keys vanish into nothing, without
        // a message and without understanding that the conversation no longer had a process.
        send(client, { t: 'error', message: 'this conversation has no running process: restart it (⋯ menu, or `wra attach`)' });
        return;
      }
      running.shell.write(message.data);
    },

    resize(client, message) {
      // Only an intention: it does not touch the PTY until you write. Applying it immediately is the
      // reflow that ruins the layout for others (a mobile browser's resize on every viewport change
      // is enough).
      client.pendingSize = {
        cols: clampInt(message.cols, 20, 500, client.cols),
        rows: clampInt(message.rows, 5, 200, client.rows),
      };
    },

    status(client) {
      send(client, {
        t: 'status',
        sessions: sessionsPayload(),
        chats: chatTails.size,
        clients: clients.size,
      });
    },
  };

  function handle(client, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(client, { t: 'error', message: 'message is not JSON' });
      return;
    }
    const handler = handlers[message.t];
    if (!handler) {
      if (message.t === 'ping') send(client, { t: 'pong' });
      else send(client, { t: 'error', message: `unknown command: ${message.t}` });
      return;
    }
    handler(client, message);
  }

  wss.on('connection', (ws) => {
    const client = { ws, role: 'terminal', cols: config.cols, rows: config.rows, pendingSize: null, sessionId: null, attach: false };
    clients.add(client);

    ws.on('message', (raw) => {
      // A bad message must not be able to take down the process: answer and move on.
      try {
        handle(client, raw);
      } catch (error) {
        console.error('[ws] message rejected:', error?.message ?? error);
        send(client, { t: 'error', message: error.message ?? 'message rejected' });
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      unsubscribe(client);
    });

    /**
     * An error on **this** connection concerns this connection.
     *
     * Without this handler, a frame over the limit (`maxPayload`, 4 MB) makes the socket emit
     * `error`: in Node an `error` event without a listener is an unhandled exception, and the
     * process dies. That is: a single client — with the token, or a crazed browser tab — took down
     * the server, and with it **all** conversations of everyone. Whoever errs pays alone: their
     * connection is closed and we move on.
     */
    ws.on('error', (error) => {
      console.error('[ws] connection closed due to an error:', error?.message ?? error);
      clients.delete(client);
      try {
        unsubscribe(client);
      } catch {
        // nothing to do: it is closing
      }
      try {
        ws.terminate();
      } catch {
        // already closed
      }
    });
  });

  // Whoever knocks repeatedly without the right token must not be able to try forever: the token
  // has 192 bits, but one attempt per second is still one attempt per second. Only **refusals** are
  // counted — whoever gets in consumes nothing.
  const rejected = createRateLimiter({ max: 30, windowMs: 5 * 60_000 });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const from = request.socket?.remoteAddress ?? 'unknown';
    const deny = (status) => {
      const verdict = rejected.check(from);
      if (verdict.ok) socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
      // Beyond the limit nothing is even answered: an error line is still a line written to someone
      // who is only trying random tokens.
      socket.destroy();
    };

    // The surface lock also applies here. The upgrade does not pass through Express: without this
    // check, a request with the public host would reach the terminal, bypassing the host rules that
    // cover only the HTTP routes.
    const host = normalizeHost(request.headers.host);
    // In **single-host** the websocket on this hostname is the dashboard socket: denying it as a
    // block would mean a page that opens and never speaks — the one thing that makes the interface
    // unusable from the phone. The two rules below protect it, and they apply identically: the
    // token, and the declared origin.
    if (config.mcpHost && host === config.mcpHost && !config.singleHost) {
      deny('404 Not Found');
      return;
    }

    if (!sameToken(tokenFrom(request, url), config.token)) {
      deny('401 Unauthorized');
      return;
    }
    if (!originAllowed(request.headers.origin, config)) {
      deny('403 Forbidden');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws);
    });
  });

  return {
    wss,
    close: () => {
      for (const client of clients) client.ws.close();
      for (const tail of chatTails.values()) clearInterval(tail.timer);
      chatTails.clear();
      wss.close();
    },
    stats: () => ({ clients: clients.size, sessions: subscribers.size }),
    // the history of a chat, for the local API and the browser
    history,
    /**
     * Makes attached windows let go (`rc detach`). The chat process is not touched: the client is
     * closed, not the conversation — the same promise as Ctrl+Q, reachable even when that key does
     * not arrive.
     *
     * @param {string|null} sessionId  only that chat, or all if not given
     * @returns {number} how many windows detach
     */
    detach: (sessionId = null) => {
      let count = 0;
      for (const client of [...clients]) {
        if (!client.attach) continue;
        if (sessionId && client.sessionId !== sessionId) continue;
        send(client, { t: 'detach', reason: 'rc detach' });
        client.ws.close(4000, 'detached');
        count += 1;
      }
      return count;
    },
  };
}