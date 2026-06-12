const router = require('express').Router();
const db = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { emit } = require('../services/eventBus');

router.get('/api/standings', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT group_name, first_team, second_team FROM standings');
    res.json({
      standings: Object.fromEntries(
        rows.map((r) => [r.group_name, { first: r.first_team, second: r.second_team }])
      ),
    });
  } catch (e) {
    next(e);
  }
});

// Body: { "A": { "first": "Brazil", "second": "Morocco" }, ... }
router.post('/api/standings', requireRole('admin'), async (req, res, next) => {
  try {
    const update = req.body || {};
    const entries = Object.entries(update);
    if (!entries.length) return res.status(400).json({ error: 'no standings provided' });
    await emit(
      'standings.update',
      { actor: req.auth.role, entity: 'standings', data: update },
      async (client) => {
        for (const [group, v] of entries) {
          await client.query(
            `INSERT INTO standings (group_name, first_team, second_team, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (group_name) DO UPDATE SET
               first_team = EXCLUDED.first_team, second_team = EXCLUDED.second_team, updated_at = NOW()`,
            [group, (v && v.first) || null, (v && v.second) || null]
          );
        }
      }
    );
    res.json({ ok: true, count: entries.length });
  } catch (e) {
    next(e);
  }
});

// Admin: clear all group standings (e.g. to wipe a pre-tournament mistake).
router.delete('/api/standings', requireRole('admin'), async (req, res, next) => {
  try {
    await emit(
      'standings.clear',
      { actor: req.auth.role, entity: 'standings' },
      async (client) => {
        await client.query('DELETE FROM standings');
        // also drop the cached full table so the leaderboard recomputes clean
        await client.query("DELETE FROM sync_state WHERE key = 'standings_full'");
      }
    );
    res.json({ ok: true, cleared: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
