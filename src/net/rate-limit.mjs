// A request counter per origin. It serves two different purposes with the same mechanics:
// not letting the token be guessed through repeated attempts, and not letting a client that
// retries in a loop fill up memory.
//
// It is not a traffic limiter: it is a door that closes when someone insists. The values are
// deliberately generous — a real MCP client makes bursts of legitimate calls, and a tight limit
// would break normal use in order to stop an abuse that is not happening.

export function createRateLimiter({ max, windowMs, now = () => Date.now(), maxKeys = 5_000 } = {}) {
  const hits = new Map(); // key -> [instants]

  const prune = (at) => {
    // Old keys are dropped: without this, an attack from a thousand different addresses would
    // fill memory exactly while it is being defended.
    if (hits.size <= maxKeys) return;
    for (const [key, times] of hits) {
      if (!times.some((time) => at - time < windowMs)) hits.delete(key);
    }
    // If they are all still inside the window (an attack from many origins at once), the oldest
    // are dropped anyway: the cap is a guarantee, not an intention. What is lost is the count for
    // some distant origin, not the process's memory.
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
  };

  const check = (key, at = now()) => {
    const recent = (hits.get(key) ?? []).filter((time) => at - time < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return { ok: false, retryAfterMs: windowMs - (at - recent[0]) };
    }
    recent.push(at);
    hits.set(key, recent);
    prune(at);
    return { ok: true, remaining: max - recent.length };
  };

  return {
    check,
    /** How many are left, without consuming them: for diagnostics. */
    peek: (key, at = now()) => max - (hits.get(key) ?? []).filter((time) => at - time < windowMs).length,
    reset: () => hits.clear(),
    size: () => hits.size,
    /** For express: responds 429 with `Retry-After` instead of letting it through. */
    middleware: (keyOf = (request) => request.ip ?? 'unknown') => (request, response, next) => {
      const verdict = check(keyOf(request));
      if (verdict.ok) {
        next();
        return;
      }
      response.setHeader('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
      response.status(429).json({ error: 'too many requests: try again shortly' });
    },
  };
}