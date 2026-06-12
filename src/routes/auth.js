const router = require('express').Router();
const { signToken } = require('../middleware/auth');

// Exchange the admin password for a short-lived admin JWT. The frontend api()
// wrapper then sends it as `Authorization: Bearer <token>`.
router.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  const expected = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN;
  if (!expected) return res.status(500).json({ error: 'Admin auth not configured' });
  if (!password || password !== expected) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = signToken({ role: 'admin' });
  res.json({ token, role: 'admin' });
});

module.exports = router;
