// Tiny in-memory rate limiter — enough for a single Railway dyno.
//
// Used to slow brute-force attempts against POST /api/auth/login. We don't try
// to be a security control beyond that: a determined attacker behind a botnet
// of IPs would bypass it. The goal is to make casual guessing (one machine,
// one curl loop) prohibitively slow without a redis dependency.
//
// Per (key) you get N attempts in WINDOW_MS. Beyond that, the request is
// rejected with 429 until the window slides. Failures only increment the
// counter; explicit "successful login" resets the counter for that key (so a
// legitimate operator never gets locked out).
//
// Each instance is independent — call createRateLimiter() per protected route.

function createRateLimiter({ max = 5, windowMs = 15 * 60_000, keyFn } = {}) {
  // key → array of recent attempt timestamps (only failed ones).
  const attempts = new Map();

  function gc(now) {
    // Drop empty buckets so memory stays bounded.
    for (const [k, ts] of attempts) {
      const fresh = ts.filter((t) => now - t < windowMs);
      if (fresh.length) attempts.set(k, fresh);
      else attempts.delete(k);
    }
  }

  function snapshot(key, now) {
    const ts = (attempts.get(key) || []).filter((t) => now - t < windowMs);
    if (ts.length) attempts.set(key, ts);
    else attempts.delete(key);
    return ts;
  }

  function middleware(req, res, next) {
    const now = Date.now();
    if (now % 100 === 0) gc(now); // light occasional GC
    const key = (typeof keyFn === 'function' ? keyFn(req) : null)
      || req.ip
      || req.connection?.remoteAddress
      || 'unknown';
    const recent = snapshot(key, now);
    if (recent.length >= max) {
      const retryMs = windowMs - (now - recent[0]);
      res.set('Retry-After', String(Math.ceil(retryMs / 1000)));
      return res.status(429).json({
        error: 'Too many attempts. Try again later.',
        retryAfterSeconds: Math.ceil(retryMs / 1000),
      });
    }
    // Tag the request so the route handler can decide success/fail.
    req.rateLimit = {
      key,
      recordFailure() {
        const arr = attempts.get(key) || [];
        arr.push(Date.now());
        attempts.set(key, arr);
      },
      recordSuccess() {
        attempts.delete(key);
      },
    };
    next();
  }

  return middleware;
}

module.exports = { createRateLimiter };
