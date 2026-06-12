const router = require('express').Router();
const db = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { emit } = require('../services/eventBus');

// Public read: all matches ordered by kickoff.
router.get('/api/matches', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM matches ORDER BY utc_date NULLS LAST');
    res.json({ matches: rows });
  } catch (e) {
    next(e);
  }
});

// Public read: the group→teams map DERIVED from the synced fixtures, so the
// frontend picks grid always matches the real draw (football-data group_name
// like "GROUP_A"). Returns {} until the fixtures are synced.
router.get('/api/groups', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT group_name, home_team AS team FROM matches
         WHERE group_name IS NOT NULL AND home_team IS NOT NULL
       UNION
       SELECT DISTINCT group_name, away_team AS team FROM matches
         WHERE group_name IS NOT NULL AND away_team IS NOT NULL`
    );
    const groups = {};
    for (const r of rows) {
      // "GROUP_A" → "A"
      const key = String(r.group_name).replace(/^GROUP[_ ]?/i, '').trim() || r.group_name;
      (groups[key] = groups[key] || new Set()).add(r.team);
    }
    const out = {};
    for (const k of Object.keys(groups).sort()) out[k] = [...groups[k]].sort();
    res.json({ groups: out });
  } catch (e) {
    next(e);
  }
});

// Admin: toggle the upset flag on a match (awards the upset bonus on a win).
router.post('/api/matches/:id/upset', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid match id' });
    const upset = req.body && typeof req.body.upset === 'boolean' ? req.body.upset : true;
    await emit(
      'match.upset',
      { actor: req.auth.role, entity: 'match', entityId: id, data: { upset } },
      async (client) => {
        await client.query('UPDATE matches SET upset = $1 WHERE id = $2', [upset, id]);
      }
    );
    res.json({ ok: true, id, upset });
  } catch (e) {
    next(e);
  }
});

// Admin: set/clear a match score manually (override when the live feed lags).
// Body: { home, away, status?, manual? }. When manual!==false the match is
// pinned so the football-data sync won't overwrite it. Fires live notifications.
router.post('/api/matches/:id/score', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid match id' });
    const b = req.body || {};
    const toInt = (v) => (v === null || v === '' || v === undefined ? null : Number(v));
    const home = toInt(b.home);
    const away = toInt(b.away);
    const bad = (n) => n !== null && (!Number.isInteger(n) || n < 0);
    if (bad(home) || bad(away)) return res.status(400).json({ error: 'home/away must be non-negative integers or null' });
    const manual = b.manual !== false;
    const allowed = new Set(['TIMED', 'SCHEDULED', 'IN_PLAY', 'PAUSED', 'FINISHED']);
    const status = typeof b.status === 'string' && allowed.has(b.status)
      ? b.status
      : (home !== null && away !== null ? 'IN_PLAY' : 'TIMED');
    const winner = status === 'FINISHED' && home !== null && away !== null
      ? (home > away ? 'HOME_TEAM' : home < away ? 'AWAY_TEAM' : 'DRAW')
      : null;

    await emit(
      'match.score',
      { actor: req.auth.role, entity: 'match', entityId: id, data: { home, away, status, manual } },
      async (client) => {
        await client.query(
          `UPDATE matches SET home_score = $2, away_score = $3, status = $4, winner = $5,
                  manual_score = $6, last_updated = NOW(), synced_at = NOW() WHERE id = $1`,
          [id, home, away, status, winner, manual]
        );
      }
    );
    try { await require('../services/push').notifyMatchEvents(); } catch { /* best-effort */ }
    res.json({ ok: true, id, home, away, status, manual });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
