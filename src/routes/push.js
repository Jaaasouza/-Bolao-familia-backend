const router = require('express').Router();
const db = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { isEnabled, publicKey } = require('../services/push');

// Public: the VAPID public key + whether push is configured. The frontend needs
// the key to create a subscription.
router.get('/api/push/key', (req, res) => {
  res.json({ enabled: isEnabled(), publicKey: publicKey() });
});

// Player: register this browser's push subscription.
// Body: { subscription: { endpoint, keys: { p256dh, auth } } }
router.post('/api/push/subscribe', requireRole('player', 'admin'), async (req, res, next) => {
  try {
    const pid = req.auth.pid;
    if (!pid) return res.status(400).json({ error: 'token has no player id' });
    const sub = req.body && req.body.subscription;
    const endpoint = sub && sub.endpoint;
    const p256dh = sub && sub.keys && sub.keys.p256dh;
    const auth = sub && sub.keys && sub.keys.auth;
    const lang = req.body && req.body.lang === 'es' ? 'es' : 'en';
    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({ error: 'invalid subscription' });
    }
    await db.query(
      `INSERT INTO push_subscriptions (endpoint, player_id, p256dh, auth, lang)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET
         player_id = EXCLUDED.player_id, p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth, lang = EXCLUDED.lang`,
      [endpoint, pid, p256dh, auth, lang]
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Player: drop a subscription (e.g. they turned notifications off).
router.post('/api/push/unsubscribe', requireRole('player', 'admin'), async (req, res, next) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
