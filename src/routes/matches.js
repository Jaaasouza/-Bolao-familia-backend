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

// Admin: set/clear home/away team names on a fixture. Used for knockout matches
// whose teams football-data hasn't propagated yet (lag after a group ends, or
// the bracket source itself is temporarily incomplete). When manual!==false the
// fixture is pinned so the football-data sync won't overwrite the names later.
// Body: { home, away, manual? } — pass an empty string or null to clear a side.
router.post('/api/matches/:id/teams', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid match id' });
    const b = req.body || {};
    const norm = (v) => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      return s.length ? s : null;
    };
    const home = norm(b.home);
    const away = norm(b.away);
    if (home === null && away === null) {
      return res.status(400).json({ error: 'provide at least one of home / away' });
    }
    const manual = b.manual !== false;

    const { rows } = await db.query('SELECT id, home_team, away_team FROM matches WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'match not found' });
    const before = rows[0];
    // Preserve the existing side when the request omits it (null), so an admin
    // can set just one slot at a time.
    const nextHome = home === null ? before.home_team : home;
    const nextAway = away === null ? before.away_team : away;

    await emit(
      'match.teams',
      {
        actor: req.auth.role,
        entity: 'match',
        entityId: id,
        data: {
          from: { home_team: before.home_team, away_team: before.away_team },
          to: { home_team: nextHome, away_team: nextAway },
          manual,
        },
      },
      async (client) => {
        await client.query(
          `UPDATE matches
              SET home_team = $2, away_team = $3, manual_teams = $4,
                  last_updated = NOW(), synced_at = NOW()
            WHERE id = $1`,
          [id, nextHome, nextAway, manual]
        );
      }
    );
    res.json({ ok: true, id, home_team: nextHome, away_team: nextAway, manual });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
