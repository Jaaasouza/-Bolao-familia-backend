const router = require('express').Router();
const db = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { syncMatches } = require('../services/syncMatches');
const { syncEspnSchedule } = require('../services/espnSchedule');
const { rateInfo } = require('../services/footballData');

// Public read-only diagnostic: is the match sync actually working? Shows when it
// last ran, how many matches it pulled, the last error (if any), the live rate
// limit, and which mode/competition is configured (no secrets exposed).
router.get('/api/sync-status', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT key, value, updated_at FROM sync_state WHERE key IN ('last_sync_matches','last_sync_error','last_espn','last_espn_schedule','last_unmatched_espn','last_bracket_backfill','standings_full','scorers')"
    );
    const map = {};
    for (const r of rows) map[r.key] = { value: r.value, updatedAt: r.updated_at };
    const mirror = Boolean(process.env.MIRROR_SOURCE_URL);
    const fd = Boolean(process.env.FOOTBALL_DATA_API_KEY);
    res.json({
      mode: mirror ? 'mirror' : fd ? 'api+espn' : 'espn',
      apiKeyConfigured: fd,
      mirrorConfigured: mirror,
      competition: process.env.FOOTBALL_DATA_COMPETITION || 'WC',
      espnEnabled: process.env.LIVE_ESPN !== '0',
      espnLeague: process.env.ESPN_LEAGUE || 'fifa.world',
      rate: rateInfo(),
      lastSyncMatches: map.last_sync_matches || null,
      lastSyncError: map.last_sync_error || null,
      lastEspn: map.last_espn || null,
      lastEspnSchedule: map.last_espn_schedule || null,
      // When non-null, ESPN reported fixtures we couldn't pair to our DB rows
      // by team name — usually means a country is missing from teamAliases.js.
      // The fixture's score won't be written until the alias is added.
      lastUnmatchedEspn: map.last_unmatched_espn || null,
      // Last bracket-backfill outcome (how many missing teams ESPN filled in
      // for knockout fixtures FD hadn't propagated yet).
      lastBracketBackfill: map.last_bracket_backfill || null,
      serverTime: Date.now(),
    });
  } catch (e) {
    next(e);
  }
});

// Force an immediate fixture sync. football-data is the source when its key is
// configured (and it purges any leftover ESPN-seeded rows); otherwise we seed
// the schedule from ESPN's keyless API.
router.post('/api/sync-now', requireRole('admin'), async (req, res, next) => {
  try {
    let fd = null;
    let espn = null;
    if (process.env.FOOTBALL_DATA_API_KEY) {
      fd = await syncMatches(req.auth.role);
    } else if (process.env.LIVE_ESPN !== '0') {
      try {
        espn = await syncEspnSchedule(req.auth.role);
      } catch (e) {
        espn = { error: e.message };
      }
    }
    res.json({ ok: true, fd, espn, rate: rateInfo() });
  } catch (e) {
    if (e.code === 'RATE_LIMITED') {
      return res.status(429).json({ error: e.message, rate: rateInfo() });
    }
    next(e);
  }
});

module.exports = router;
