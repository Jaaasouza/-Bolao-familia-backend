const router = require('express').Router();
const db = require('../db/pool');

// Full snapshot for the frontend: matches + phases + standings + last sync.
router.get('/api/state', async (req, res, next) => {
  try {
    const [matches, phases, standings, sync, standingsFull, scorers] = await Promise.all([
      db.query('SELECT * FROM matches ORDER BY utc_date NULLS LAST'),
      db.query('SELECT team_name, phase FROM phases'),
      db.query('SELECT group_name, first_team, second_team FROM standings'),
      db.query("SELECT value FROM sync_state WHERE key = 'last_sync_matches'"),
      db.query("SELECT value FROM sync_state WHERE key = 'standings_full'"),
      db.query("SELECT value FROM sync_state WHERE key = 'scorers'"),
    ]);

    res.json({
      matches: matches.rows,
      phases: Object.fromEntries(phases.rows.map((r) => [r.team_name, r.phase])),
      standings: Object.fromEntries(
        standings.rows.map((r) => [r.group_name, { first: r.first_team, second: r.second_team }])
      ),
      // Full official group tables (points/GD/…) when available from the API.
      standingsTable: standingsFull.rows[0] ? standingsFull.rows[0].value : null,
      scorers: scorers.rows[0] ? scorers.rows[0].value : null,
      lastSyncMatches: sync.rows[0] ? sync.rows[0].value : null,
      serverTime: Date.now(),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
