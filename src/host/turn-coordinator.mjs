import crypto from 'node:crypto';
import { runTurn } from '../core/turns.mjs';

/**
 * The turns of all sessions: one per session at a time, queued, with a `requestId` that makes
 * resubmission harmless.
 *
 * Why it is needed: an MCP client can call `talk` again after a timeout or a disconnection. Without
 * idempotency the turn would start twice (two prompts in the same transcript, or two overlapping
 * turns in the same session). And the target must be **frozen at acceptance**: if the user moves
 * the switch in the meantime, the turn already started finishes where it began.
 */
export function createTurnCoordinator({ config, registry, run: engine = runTurn, now = () => Date.now(), journal = null } = {}) {
  const turns = new Map(); // turnId -> turn
  const byRequest = new Map(); // requestId -> turnId
  const queues = new Map(); // sessionId -> { current: turnId|null, waiting: turnId[] }
  const listeners = new Set();

  const KEEP_FINISHED = 50;

  const emit = (turn) => {
    for (const listener of listeners) listener(turn);
  };

  const queueFor = (sessionId) => {
    if (!queues.has(sessionId)) queues.set(sessionId, { current: null, waiting: [] });
    return queues.get(sessionId);
  };

  const isFinished = (state) => state === 'done' || state === 'error' || state === 'timeout';

  // The **real** limit of a turn. `turnMaxMs` is only the length of one listening window, and
  // windows follow one another; this is the point beyond which a turn is no longer long work but a
  // stalled agent (on a permission question, or on a stuck PTY). Generous on purpose, because long
  // work must be able to finish. It is changed from the environment, for tests.
  const hardMs = () => config.turnHardMs ?? 4 * 3_600_000;

  function remember(turn) {
    turns.set(turn.turnId, turn);
    if (turn.requestId) byRequest.set(turn.requestId, turn.turnId);
    // only a bit of history is kept: old turns no longer interest anyone
    while (turns.size > KEEP_FINISHED) {
      const oldest = turns.keys().next().value;
      const gone = turns.get(oldest);
      turns.delete(oldest);
      if (gone?.requestId && byRequest.get(gone.requestId) === oldest) byRequest.delete(gone.requestId);
    }
  }

  function view(turn) {
    return {
      turnId: turn.turnId,
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      source: turn.source,
      state: turn.state,
      position: turn.position,
      reply: turn.reply,
      partial: turn.partial,
      error: turn.error,
      promptId: turn.promptId,
      transcript: turn.transcript,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt ?? null,
      // A queued turn has not started yet: `startedAt` is null, and "how long it lasted" is zero.
      elapsedMs: turn.startedAt ? (turn.finishedAt ?? now()) - turn.startedAt : 0,
      // How many listening windows have followed one another (1 = the turn finished within the
      // first), and since when the partial has not changed: it is the difference between "it is
      // working" and "it has stopped".
      watches: turn.watches ?? 1,
      lastProgressAt: turn.progressAt ?? turn.startedAt ?? null,
      idleMs: turn.progressAt ? now() - turn.progressAt : 0,
    };
  }

  /** A turn remembered from the journal presents itself as a finished turn, not a live one. */
  function rememberView(entry) {
    return {
      turnId: entry.turnId,
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      source: 'journal',
      state: entry.state,
      position: null,
      reply: entry.reply,
      partial: entry.partial ?? null,
      error: entry.error,
      promptId: null,
      transcript: null,
      startedAt: null,
      finishedAt: entry.finishedAt ?? null,
      elapsedMs: 0,
      watches: null,
      lastProgressAt: null,
      idleMs: 0,
      fromJournal: true,
    };
  }

  async function execute(turn) {
    const queue = queueFor(turn.sessionId);
    queue.current = turn.turnId;
    turn.state = 'running';
    turn.startedAt = now();
    turn.progressAt = turn.startedAt;
    turn.watches = 0;
    registry.markBusy?.(turn.sessionId, true);
    emit(turn);

    const hardDeadline = turn.startedAt + hardMs();
    let resume = null;

    try {
      // A turn can last longer than one listening window. When the window ends the turn does
      // **not** end: the agent is still working, and the only thing that changed is that nobody is
      // watching it. Here we start watching again from the same point, without resending the
      // message — resending it would be a second prompt in the same conversation, which is the
      // damage idempotency exists to prevent.
      for (;;) {
        const sink = registry.sinkFor(turn.sessionId);
        turn.watches += 1;
        const result = await engine({
          pty: sink,
          message: turn.message,
          transcriptPath: sink.transcriptPath,
          projectsRoot: config.projectsRoot,
          projectDir: sink.projectPath,
          promptMatchMs: config.promptMatchMs,
          pollMs: config.pollMs,
          settleMs: config.settleMs,
          maxWaitMs: config.turnMaxMs,
          resume,
          onProgress: (text) => {
            if (text !== turn.partial) turn.progressAt = now();
            turn.partial = text;
          },
        });

        turn.promptId = result.promptId ?? turn.promptId;
        turn.transcript = result.transcript ?? sink.transcriptPath ?? null;

        if (result.status === 'in_progress') {
          turn.partial = result.partial ?? turn.partial;
          emit(turn);
          if (now() >= hardDeadline) {
            turn.state = 'timeout';
            turn.error = `the turn did not finish within ${Math.round(hardMs() / 60_000)} minutes: `
              + 'the agent may be stuck on a permission question. The partial is below; '
              + 'the complete reply, if the agent writes it, stays in the transcript.';
            break;
          }
          resume = {
            transcriptPath: result.transcript,
            promptId: result.promptId ?? null,
            offset: result.offset ?? 0,
            partial: result.partial ?? '',
            tools: result.tools ?? [],
            ended: result.ended === true,
          };
          continue;
        }

        turn.state = result.status === 'done' ? 'done' : 'error';
        turn.reply = result.reply ?? null;
        turn.partial = result.partial ?? turn.partial;
        turn.error = result.error ?? null;
        break;
      }
    } catch (error) {
      turn.state = 'error';
      turn.error = error?.message ?? String(error);
    } finally {
      turn.finishedAt = now();
      registry.markBusy?.(turn.sessionId, false);
      // Only at the end: a turn still running is not a reply to repeat.
      journal?.remember(turn);
      queue.current = null;
      emit(turn);
      const next = queue.waiting.shift();
      if (next) {
        const nextTurn = turns.get(next);
        if (nextTurn) execute(nextTurn);
      }
    }
    return turn;
  }

  return {
    /**
     * Adds a turn. With the same `requestId` it is not executed twice: the turn that already
     * exists is returned (running, queued or finished).
     */
    submit({ sessionId, message, source = 'mcp', requestId = null } = {}) {
      if (!sessionId) throw new Error('a session is required');
      if (typeof message !== 'string' || !message.trim()) throw new Error('a message is required');

      if (requestId) {
        const existing = byRequest.get(requestId);
        if (existing) {
          const turn = turns.get(existing);
          if (turn) return { turn: view(turn), reused: true };
        }
        // The server may have restarted since that request was executed: the journal is the only
        // memory left, and it is what prevents doing it again.
        const remembered = journal?.get(requestId);
        if (remembered) return { turn: rememberView(remembered), reused: true, fromJournal: true };
      }

      const queue = queueFor(sessionId);
      // The queue cap: without it, someone retrying in a loop fills memory and clogs the
      // conversation for hours. Better to say so immediately than to queue and disappear.
      if (queue.waiting.length >= (config.maxQueue ?? 16)) {
        const error = new Error(`this session's queue is full (${config.maxQueue} turns): wait for them to finish`);
        error.code = 'QUEUE_FULL';
        throw error;
      }

      const turn = {
        turnId: crypto.randomUUID(),
        requestId,
        sessionId,
        source,
        message,
        state: 'queued',
        position: queue.waiting.length + (queue.current ? 1 : 0),
        reply: null,
        partial: '',
        error: null,
        promptId: null,
        transcript: null,
        startedAt: null,
        finishedAt: null,
      };
      remember(turn);
      emit(turn);

      if (queue.current) {
        queue.waiting.push(turn.turnId);
      } else {
        execute(turn);
      }
      return { turn: view(turn), reused: false };
    },

    get: (turnId) => {
      const turn = turns.get(turnId);
      return turn ? view(turn) : null;
    },

    byRequest: (requestId) => {
      const turnId = byRequest.get(requestId);
      if (turnId) {
        const turn = turns.get(turnId);
        if (turn) return view(turn);
      }
      const remembered = journal?.get(requestId);
      return remembered ? rememberView(remembered) : null;
    },

    /**
     * The latest turn of a session, running or finished. It serves whoever **lost the id**: a new
     * connection, a client that does not carry the `requestId` from one round to the next. Without
     * it, the only recoverable reply would be the one whose name you remember.
     */
    latest: (sessionId) => {
      let found = null;
      for (const turn of turns.values()) {
        if (turn.sessionId !== sessionId) continue;
        if (!found || (turn.startedAt ?? 0) >= (found.startedAt ?? 0)) found = turn;
      }
      if (found) return view(found);
      const remembered = journal?.latestFor(sessionId);
      return remembered ? rememberView(remembered) : null;
    },

    /**
     * What is happening now, for diagnostics: for each session the running turn and how many are
     * waiting, and the list of turns that have been running for too long. It distinguishes "it is
     * working" from "it is stuck" without guessing.
     */
    snapshot() {
      const sessions = [...queues.entries()].map(([sessionId, queue]) => {
        const running = queue.current ? turns.get(queue.current) : null;
        return {
          sessionId,
          running: running ? view(running) : null,
          waiting: queue.waiting.length,
        };
      });
      // A turn "running" for a long time is **not** suspicious in itself: long work is long, and
      // the listening window renews itself. What is suspicious is a turn that has produced nothing
      // for a while — the agent stuck on a question, or a stuck PTY. So the measure is
      // **inactivity**, not age.
      const stallAfterMs = config.turnStallMs ?? 15 * 60_000;
      const stuck = [...turns.values()]
        .filter((turn) => turn.state === 'running' && turn.startedAt && now() - (turn.progressAt ?? turn.startedAt) > stallAfterMs)
        .map(view);
      return { sessions, stuck };
    },

    /** How many turns are running or waiting for a session. */
    depth: (sessionId) => {
      const queue = queues.get(sessionId);
      if (!queue) return 0;
      return (queue.current ? 1 : 0) + queue.waiting.length;
    },

    /**
     * Waits for a turn that has just been accepted.
     *
     * It is needed because a turn remembered from the journal is **not** in memory: `wait` would
     * not find it and the client would receive an empty reply — that is, idempotency would work and
     * the caller would not. If the turn is already finished by definition, it is returned.
     */
    async settle(turn, ms) {
      if (turn?.fromJournal) return turn;
      return this.wait(turn?.turnId, ms);
    },

    /** Waits for a turn to finish, or expires: it never blocks an MCP call forever. */
    async wait(turnId, ms) {
      const turn = turns.get(turnId);
      if (!turn) return null;
      const deadline = now() + ms;
      while (!isFinished(turn.state) && now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return view(turn);
    },

    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}