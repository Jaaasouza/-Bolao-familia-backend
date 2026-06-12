const router = require('express').Router();
const db = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { emit } = require('../services/eventBus');

router.get('/api/phases', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT team_name, phase FROM phases');
    res.json({ phases: Object.fromEntries(rows.map((r) => [r.team_name, r.phase])) });
  } catch (e) {
    next(e);
  }
});

// Body: { "Brazil": "r16", "Mexico": "group", ... }
router.post('/api/phases', requireRole('admin'), async (req, res, next) => {
  try {
    const update = req.body || {};
    const entries = Object.entries(update);
    if (!entries.length) return res.status(400).json({ error: 'no phases provided' });
    await emit(
      'phases.update',
      { actor: req.auth.role, entity: 'phases', data: update },
      async (client) => {
        for (const [team, phase] of entries) {
          await client.query(
            `INSERT INTO phases (team_name, phase, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (team_name) DO UPDATE SET phase = EXCLUDED.phase, updated_at = NOW()`,
            [team, phase]
          );
        }
      }
    );
    res.json({ ok: true, count: entries.length });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
