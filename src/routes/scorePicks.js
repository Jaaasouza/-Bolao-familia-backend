const router = require('express').Router();
const db = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { emit } = require('../services/eventBus');
const { totalForPlayer } = require('../services/scorePicks');
const { parseAwards } = require('../services/awards');
const { predictedGroupTables, groupBonusForPlayer, decidedGroups, groupKey } = require('../services/groupBonus');

// A match is locked for picks once it has kicked off (status left TIMED/SCHEDULED
// or kickoff time has passed).
const OPEN_STATUS = new Set(['TIMED', 'SCHEDULED']);
function isLocked(match) {
  if (!match) return true;
  if (!OPEN_STATUS.has(match.status)) return true;
  if (match.utc_date && new Date(match.utc_date).getTime() <= Date.now()) return true;
  return false;
}

// Public: all score picks (for the leaderboard). Grouped by player.
router.get('/api/score-picks', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT player_id, match_id, pred_home, pred_away, phase, updated_at FROM score_picks'
    );
    const byPlayer = {};
    for (const r of rows) {
      (byPlayer[r.player_id] = byPlayer[r.player_id] || []).push(r);
    }
    res.json({ picks: byPlayer });
  } catch (e) {
    next(e);
  }
});

// Player: my own score picks + which phases I've locked in.
router.get('/api/my-score-picks', requireRole('player', 'admin'), async (req, res, next) => {
  try {
    const pid = req.auth.pid;
    if (!pid) return res.status(400).json({ error: 'token has no player id' });
    // If the player was removed (e.g. by an admin), invalidate the session so the
    // client drops its stored token and returns to the login screen.
    const { rows: exists } = await db.query('SELECT 1 FROM players WHERE id = $1', [pid]);
    if (!exists.length) return res.status(401).json({ error: 'player no longer exists' });
    const [{ rows }, { rows: awardRows }] = await Promise.all([
      db.query(
        'SELECT match_id, pred_home, pred_away, phase, updated_at FROM score_picks WHERE player_id = $1',
        [pid]
      ),
      db.query('SELECT kind, pick FROM award_picks WHERE player_id = $1', [pid]),
    ]);
    const awards = {};
    for (const a of awardRows) awards[a.kind] = a.pick;
    // Picks are locked per-match (once a match kicks off), never per-phase, so
    // there are no locked phases to report.
    res.json({ picks: rows, lockedPhases: [], awards });
  } catch (e) {
    next(e);
  }
});

// Player: SAVE score picks, match by match. Body: { picks:[{matchId,home,away}] }
// Rules (família pool — per product owner):
//  - pick whenever you want; no registration deadline, no one-shot-per-phase lock;
//  - a pick is FINAL once submitted — it can never be changed (insert-only);
//  - matches that already kicked off are skipped (you can't pick them anymore);
//  - any subset of matches can be submitted — no need to cover a whole phase.
router.post('/api/score-picks', requireRole('player', 'admin'), async (req, res, next) => {
  try {
    const pid = req.auth.pid || (req.body && req.body.playerId);
    if (!pid) return res.status(400).json({ error: 'token has no player id' });

    const list = Array.isArray(req.body && req.body.picks) ? req.body.picks : [];
    // Optional tournament award bets (golden boot / best player) — set once.
    const awards = parseAwards(req.body && req.body.awards);
    if (!list.length && !awards.length) {
      return res.status(400).json({ error: 'no picks provided' });
    }

    const { rows: allMatches } = await db.query('SELECT id, utc_date, status, stage FROM matches');
    const byId = Object.fromEntries(allMatches.map((m) => [String(m.id), m]));

    // Split the submitted picks into ones we can save (match exists and hasn't
    // kicked off) and ones to skip (already started — frozen). Validate scores.
    const savable = [];
    const skipped = [];
    for (const p of list) {
      const m = byId[String(p.matchId)];
      if (!m) return res.status(400).json({ error: `Match ${p.matchId} not found.` });
      const h = Number(p.home); const a = Number(p.away);
      if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 99 || a > 99) {
        return res.status(400).json({ error: `Invalid score for match ${p.matchId}.` });
      }
      if (isLocked(m)) { skipped.push(String(m.id)); continue; }
      savable.push({ m, h, a });
    }

    if (!savable.length && !awards.length) {
      return res.status(423).json({ error: 'Those matches have already started — picks are closed for them.' });
    }

    await emit(
      'score_picks.save',
      { actor: req.auth.role, entity: 'score_picks', entityId: pid, data: { saved: savable.length, skipped: skipped.length } },
      async (client) => {
        for (const { m, h, a } of savable) {
          await client.query(
            `INSERT INTO score_picks (player_id, match_id, pred_home, pred_away, phase, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (player_id, match_id) DO NOTHING`,
            [pid, m.id, h, a, m.stage || null]
          );
        }
        // Persist award bets (golden boot / best player) — set once, can't change.
        for (const aw of awards) {
          await client.query(
            `INSERT INTO award_picks (player_id, kind, pick) VALUES ($1, $2, $3)
             ON CONFLICT (player_id, kind) DO NOTHING`,
            [pid, aw.kind, aw.pick]
          );
        }
      }
    );
    res.json({ ok: true, saved: savable.length, skipped: skipped.length, awards: awards.length });
  } catch (e) {
    next(e);
  }
});

// Public: the scoreline leaderboard (server-computed so everyone agrees).
router.get('/api/score-leaderboard', async (req, res, next) => {
  try {
    const [{ rows: picks }, { rows: matches }, { rows: players }, { rows: standings }] = await Promise.all([
      db.query('SELECT player_id, match_id, pred_home, pred_away FROM score_picks'),
      db.query('SELECT id, home_team, away_team, home_score, away_score, status, stage, group_name FROM matches'),
      db.query('SELECT id, name FROM players'),
      db.query('SELECT group_name, first_team, second_team FROM standings'),
    ]);
    const matchesById = Object.fromEntries(matches.map((m) => [m.id, m]));
    // Actual decided group standings, keyed by group letter (for the bonus).
    const actualByGroup = {};
    for (const s of standings) {
      actualByGroup[groupKey(s.group_name)] = { first: s.first_team, second: s.second_team };
    }
    // Only groups whose matches are all finished can score the bonus.
    const decided = decidedGroups(matchesById);
    const byPlayer = {};
    for (const p of picks) (byPlayer[p.player_id] = byPlayer[p.player_id] || []).push(p);

    const board = players.map((pl) => {
      const mine = byPlayer[pl.id] || [];
      const s = totalForPlayer(mine, matchesById);
      const { bonus } = groupBonusForPlayer(predictedGroupTables(mine, matchesById), actualByGroup, decided);
      return { id: pl.id, name: pl.name, ...s, bonus, total: s.total + bonus };
    }).sort((a, b) => b.total - a.total || b.exact - a.exact);

    res.json({ leaderboard: board });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.isLocked = isLocked;
