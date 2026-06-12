const router = require('express').Router();
const db = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { emit } = require('../services/eventBus');
const { getDeadline, clearCache } = require('../services/deadline');

// Public: read app config the frontend needs (currently the picks deadline).
router.get('/api/config', async (req, res, next) => {
  try {
    const deadline = await getDeadline();
    res.json({
      picksDeadline: deadline,
      registrationOpen: !deadline || Date.now() < new Date(deadline).getTime(),
      serverTime: Date.now(),
    });
  } catch (e) {
    next(e);
  }
});

// Admin: set the picks deadline. Body: { picksDeadline: ISO string | null }.
router.post('/api/config', requireRole('admin'), async (req, res, next) => {
  try {
    const { picksDeadline } = req.body || {};
    if (picksDeadline !== null && picksDeadline !== undefined) {
      const t = new Date(picksDeadline).getTime();
      if (Number.isNaN(t)) return res.status(400).json({ error: 'invalid picksDeadline' });
    }
    await emit(
      'config.update',
      { actor: req.auth.role, entity: 'config', entityId: 'picks_deadline', data: { picksDeadline } },
      async (client) => {
        await client.query(
          `INSERT INTO app_config (key, value, updated_at) VALUES ('picks_deadline', $1, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [JSON.stringify(picksDeadline ?? null)]
        );
      }
    );
    clearCache();
    res.json({ ok: true, picksDeadline: picksDeadline ?? null });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
