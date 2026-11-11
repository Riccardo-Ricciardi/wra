import crypto from 'node:crypto';

/**
 * Permission requests waiting for a human decision.
 *
 * The real TUI, when a tool needs a permission, runs the `PermissionRequest` hook and **waits for
 * its answer**. This is the piece that turns that wait into a question visible from the browser and
 * the phone: the request enters here, is shown, and the answer goes back as the hook's decision.
 *
 * A rule that is not negotiable: here **nothing is ever granted on its own**. If nobody answers
 * within the maximum time, or if something breaks, the answer is "no decision" and the normal
 * dialog reappears in the terminal. A relay failure must cost a wait, not a permission given away.
 *
 * The only exception is the "controlled automatic MCP" policy (`policy`), and it is not an
 * exception to the rule: it is a policy applied **before** the wait, which never decides on a
 * failure (if it does not answer, we ask), and which is queried on every single request. That is
 * why revocation takes effect immediately, without restarting anything.
 *
 * @param {object} input
 * @param {(request: {sessionId: string, toolName: string, input: object}) => ({behavior: 'allow', reason: string}|null)} [input.policy]
 */
export function createApprovals({ config, now = () => Date.now(), policy = null } = {}) {
  const pending = new Map(); // id -> waiting request
  const listeners = new Set();
  // Automatic grants stay in memory for a moment: a permission granted without asking must be
  // **visible** to whoever comes back to look, otherwise the person does not know what happened
  // while they were away. It is a log, not state: nothing is decided here.
  const automatic = [];
  const AUTO_LOG_SIZE = 50;

  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };

  const view = (request) => ({
    id: request.id,
    sessionId: request.sessionId,
    toolName: request.toolName,
    input: request.input,
    suggestions: request.suggestions,
    askedAt: request.askedAt,
    expiresAt: request.expiresAt,
    // Present only on an automatic grant: whoever looks must be able to tell "I decided" from
    // "the policy decided", and know why.
    ...(request.automatic ? { automatic: true, reason: request.reason ?? null } : {}),
  });

  const settle = (request, decision, reason) => {
    if (!pending.has(request.id)) return false;
    pending.delete(request.id);
    clearTimeout(request.timer);
    request.settle(decision);
    emit({ type: 'gone', id: request.id, sessionId: request.sessionId, reason, decision });
    return true;
  };

  return {
    /**
     * Puts a request on hold and returns the decision — or `null`, which means "I am not
     * deciding": the hook exits without writing anything and Claude Code shows its dialog.
     */
    ask({ sessionId, toolName, input = {}, suggestions = [] }) {
      // TTL zero: the relay is off — "the terminal handles requests". It also applies to the
      // automatic policy: if WRA must not answer permissions, it does not answer through this
      // path either. It is the first check on purpose.
      if (!(config.approvalTtlMs > 0)) return Promise.resolve(null);

      // The automatic policy is queried **here**, on every request: what answers is the state
      // now, not the state when the conversation started. A policy that throws grants nothing —
      // we continue to the normal wait.
      let auto = null;
      try {
        auto = policy?.({ sessionId, toolName, input }) ?? null;
      } catch {
        auto = null;
      }
      if (auto?.behavior === 'allow') {
        const granted = {
          id: `auto-${crypto.randomUUID()}`,
          sessionId,
          toolName,
          input,
          suggestions,
          askedAt: now(),
          expiresAt: null,
          automatic: true,
          reason: auto.reason ?? null,
        };
        automatic.push(view(granted));
        if (automatic.length > AUTO_LOG_SIZE) automatic.shift();
        emit({ type: 'auto', approval: view(granted) });
        return Promise.resolve({ behavior: 'allow' });
      }

      const id = crypto.randomUUID();
      const request = {
        id,
        sessionId,
        toolName,
        input,
        suggestions,
        askedAt: now(),
        expiresAt: now() + config.approvalTtlMs,
        settle: null,
        timer: null,
      };

      const answer = new Promise((resolve) => { request.settle = resolve; });
      request.timer = setTimeout(() => settle(request, null, 'expired'), config.approvalTtlMs);
      request.timer.unref?.();
      pending.set(id, request);
      emit({ type: 'asked', approval: view(request) });
      return answer;
    },

    /** The human decision. Repeating it on the same id does nothing: the first wins. */
    decide(id, { behavior, message = null } = {}) {
      const request = pending.get(id);
      if (!request) return null;
      if (behavior !== 'allow' && behavior !== 'deny') throw new Error(`invalid decision: ${behavior}`);
      const decision = behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: message || 'Rejected by WRA' };
      settle(request, decision, 'decided');
      return view(request);
    },

    get: (id) => (pending.has(id) ? view(pending.get(id)) : null),
    list: () => [...pending.values()].map(view),
    /** The latest automatic grants: what went through without asking, and why. */
    autoList: () => automatic.map((entry) => ({ ...entry })),
    autoCount: () => automatic.length,
    forSession: (sessionId) => [...pending.values()]
      .filter((request) => request.sessionId === sessionId)
      .map(view),

    /** A session that dies must not leave requests hanging: the hook must be able to exit. */
    clear: (sessionId) => {
      for (const request of [...pending.values()]) {
        if (!sessionId || request.sessionId === sessionId) settle(request, null, 'session-gone');
      }
    },

    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}