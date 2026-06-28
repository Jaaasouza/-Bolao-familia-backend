const router = require('express').Router();
const { signToken } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

// Slow brute-force on the admin PIN: 5 failed attempts per IP per 15 min.
// Successful logins clear the counter (so the operator isn't punished for a
// typo earlier in the day). Tunable via env for tests / local dev.
const loginLimiter = createRateLimiter({
  max: Number(process.env.LOGIN_RATE_MAX || 5),
  windowMs: Number(process.env.LOGIN_RATE_WINDOW_MS || 15 * 60_000),
});

// Exchange the admin password for a short-lived admin JWT. The frontend api()
// wrapper then sends it as `Authorization: Bearer <token>`.
router.post('/api/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  const expected = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN;
  if (!expected) return res.status(500).json({ error: 'Admin auth not configured' });
  if (!password || password !== expected) {
    if (req.rateLimit) req.rateLimit.recordFailure();
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (req.rateLimit) req.rateLimit.recordSuccess();
  const token = signToken({ role: 'admin' });
  res.json({ token, role: 'admin' });
});

module.exports = router;
