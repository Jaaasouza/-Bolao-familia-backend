const router = require('express').Router();
const db = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { syncMatches } = require('../services/syncMatches');
const { rateInfo } = require('../services/footballData');

// Public read-only diagnostic: is the match sync actually working? Shows when it
// last ran, how many matches it pulled, the last error (if any), the live rate
// limit, and which mode/competition is configured (no secrets exposed).
router.get('/api/sync-status', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT key, value, updated_at FROM sync_state WHERE key IN ('last_sync_matches','last_sync_error','last_espn','standings_full','scorers')"
    );
    const map = {};
    for (const r of rows) map[r.key] = { value: r.value, updatedAt: r.updated_at };
    res.json({
      mode: process.env.MIRROR_SOURCE_URL ? 'mirror' : 'api',
      apiKeyConfigured: Boolean(process.env.FOOTBALL_DATA_API_KEY),
      mirrorConfigured: Boolean(process.env.MIRROR_SOURCE_URL),
      competition: process.env.FOOTBALL_DATA_COMPETITION || 'WC',
      espnEnabled: process.env.LIVE_ESPN !== '0',
      espnLeague: process.env.ESPN_LEAGUE || 'fifa.world',
      rate: rateInfo(),
      lastSyncMatches: map.last_sync_matches || null,
      lastSyncError: map.last_sync_error || null,
      lastEspn: map.last_espn || null,
      serverTime: Date.now(),
    });
  } catch (e) {
    next(e);
  }
});

// Force an immediate sync (the scheduler also runs every minute).
router.post('/api/sync-now', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await syncMatches(req.auth.role);
    res.json({ ok: true, ...result, rate: rateInfo() });
  } catch (e) {
    if (e.code === 'RATE_LIMITED') {
      return res.status(429).json({ error: e.message, rate: rateInfo() });
    }
    next(e);
  }
});

module.exports = router;
