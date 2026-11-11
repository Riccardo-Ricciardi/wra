import crypto from 'node:crypto';

/**
 * The chat selection for each MCP connection: `clientId` (the OAuth client, that is, the
 * authenticated connection) → chosen session.
 *
 * Why not a single target: two different clients (ChatGPT and another, or two connections) must
 * not move the destination for each other. And why not re-read on every turn: the target is
 * frozen when the turn is accepted — if the user switches in the meantime, the turn already
 * started finishes where it began.
 *
 * Lifetime: in memory, with expiry (`ttlMs`, default 12 hours). A server restart clears the
 * selection: the client redoes it by calling `select_chat`. This is documented in the tool, and it
 * is the simplest choice that introduces no shared state between clients.
 */
export function createSelections({ ttlMs = 12 * 3_600_000, now = () => Date.now() } = {}) {
  const byClient = new Map(); // clientId -> { sessionId, at }

  const prune = () => {
    const at = now();
    for (const [clientId, entry] of byClient) if (at - entry.at > ttlMs) byClient.delete(clientId);
  };

  return {
    get(clientId) {
      prune();
      return byClient.get(clientId)?.sessionId ?? null;
    },
    set(clientId, sessionId) {
      byClient.set(clientId, { sessionId, at: now() });
      return sessionId;
    },
    clear(clientId) {
      return byClient.delete(clientId);
    },
    /** for the interface: who is talking to what */
    list() {
      prune();
      return [...byClient.entries()].map(([clientId, entry]) => ({
        clientId,
        sessionId: entry.sessionId,
        at: new Date(entry.at).toISOString(),
      }));
    },
    newClientId: () => crypto.randomUUID(),
  };
}