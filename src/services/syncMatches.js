const { fetchAllMatches, fetchStandings, fetchScorers } = require('./footballData');
const { emit } = require('./eventBus');
const db = require('../db/pool');

// Pull all matches from football-data.org and upsert them, recording a single
// audit event for the sync. Runs via the scheduler (every minute) and via the
// admin POST /api/sync-now endpoint.
async function syncMatches(actor = 'scheduler') {
  const matches = await fetchAllMatches();
  if (!matches.length) return { count: 0, skipped: true };

  await emit(
    'matches.sync',
    { actor, entity: 'matches', data: { count: matches.length } },
    async (client) => {
      for (const m of matches) {
        await client.query(
          `INSERT INTO matches
             (id, utc_date, status, stage, group_name, home_team, away_team,
              home_score, away_score, winner, last_updated, raw, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
           ON CONFLICT (id) DO UPDATE SET
             utc_date     = EXCLUDED.utc_date,
             stage        = EXCLUDED.stage,
             group_name   = EXCLUDED.group_name,
             home_team    = EXCLUDED.home_team,
             away_team    = EXCLUDED.away_team,
             -- Score/status/winner: preserved when the admin set them manually,
             -- and football-data may NEVER regress a match. Status only moves
             -- forward (TIMED → IN_PLAY → FINISHED); a FINISHED row is immutable
             -- to the sync (its free tier lags in-play and can still report a
             -- played game as TIMED — that must never un-finish it or wipe the
             -- points). A known score is never nulled. Admin changes via the
             -- score endpoint (manual_score) always win.
             status       = CASE
                              WHEN matches.manual_score THEN matches.status
                              WHEN matches.status = 'FINISHED' THEN 'FINISHED'
                              WHEN matches.status IN ('IN_PLAY','PAUSED')
                                   AND EXCLUDED.status IN ('TIMED','SCHEDULED') THEN matches.status
                              ELSE EXCLUDED.status END,
             home_score   = CASE
                              WHEN matches.manual_score THEN matches.home_score
                              WHEN matches.status = 'FINISHED' THEN matches.home_score
                              WHEN EXCLUDED.home_score IS NULL THEN matches.home_score
                              ELSE EXCLUDED.home_score END,
             away_score   = CASE
                              WHEN matches.manual_score THEN matches.away_score
                              WHEN matches.status = 'FINISHED' THEN matches.away_score
                              WHEN EXCLUDED.away_score IS NULL THEN matches.away_score
                              ELSE EXCLUDED.away_score END,
             winner       = CASE
                              WHEN matches.manual_score THEN matches.winner
                              WHEN matches.status = 'FINISHED' THEN matches.winner
                              ELSE COALESCE(EXCLUDED.winner, matches.winner) END,
             last_updated = EXCLUDED.last_updated,
             raw          = EXCLUDED.raw,
             synced_at    = NOW()`,
          [
            m.id, m.utc_date, m.status, m.stage, m.group_name, m.home_team,
            m.away_team, m.home_score, m.away_score, m.winner, m.last_updated,
            m.raw,
          ]
        );
      }
      await client.query(
        `INSERT INTO sync_state (key, value, updated_at)
         VALUES ('last_sync_matches', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify({ at: Date.now(), count: matches.length })]
      );
    }
  );

  return { count: matches.length };
}

// Secondary sync: official FIFA standings (auto-fills group 1st/2nd) + top
// scorers. Two extra API calls, so it's run on a slower cadence (and skipped
// gracefully on a rate-limit). Standings overwrite the group standings table
// only when the API actually returns a table for a group, so an admin's manual
// entry is never clobbered by an empty API response.
async function syncSecondary(actor = 'scheduler') {
  let standings = null;
  let scorers = null;
  try { standings = await fetchStandings(); } catch (e) { if (e.code !== 'RATE_LIMITED') console.warn('[sync] standings:', e.message); }
  try { scorers = await fetchScorers(20); } catch (e) { if (e.code !== 'RATE_LIMITED') console.warn('[sync] scorers:', e.message); }

  // Only upsert group 1st/2nd for groups the API has actually decided (first
  // is non-null — see mapStandings). Pre-tournament this is empty, so no group
  // bonuses are awarded before any match is played. The full table (incl. the
  // 0-0-0 pre-tournament rows) is still cached for display.
  const groups = standings
    ? Object.keys(standings).filter((g) => standings[g].first)
    : [];
  const hasFullTable = standings && Object.keys(standings).length > 0;
  if (!groups.length && !hasFullTable && !(scorers && scorers.length)) {
    return { standings: 0, scorers: 0, skipped: true };
  }

  await emit(
    'secondary.sync',
    { actor, entity: 'secondary', data: { groups: groups.length, scorers: scorers ? scorers.length : 0 } },
    async (client) => {
      for (const g of groups) {
        const s = standings[g];
        await client.query(
          `INSERT INTO standings (group_name, first_team, second_team, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (group_name) DO UPDATE SET
             first_team = EXCLUDED.first_team, second_team = EXCLUDED.second_team, updated_at = NOW()`,
          [g, s.first, s.second]
        );
      }
      if (standings) {
        await client.query(
          `INSERT INTO sync_state (key, value, updated_at) VALUES ('standings_full', $1, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [JSON.stringify(standings)]
        );
      }
      if (scorers) {
        await client.query(
          `INSERT INTO sync_state (key, value, updated_at) VALUES ('scorers', $1, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [JSON.stringify({ at: Date.now(), list: scorers })]
        );
      }
    }
  );

  return { standings: groups.length, scorers: scorers ? scorers.length : 0 };
}

// Self-heal: a match that has a score AND kicked off more than 3h ago is over —
// force it FINISHED so it always counts on the leaderboard. This catches the
// case where the live source (ESPN) stopped reporting a game after full-time
// while football-data still lags at TIMED. Never touches admin-set matches.
async function settleStaleMatches() {
  const { rowCount } = await db.query(
    `UPDATE matches
        SET status = 'FINISHED',
            winner = CASE WHEN home_score > away_score THEN 'HOME_TEAM'
                          WHEN home_score < away_score THEN 'AWAY_TEAM'
                          ELSE 'DRAW' END,
            last_updated = NOW()
      WHERE manual_score = FALSE
        AND status <> 'FINISHED'
        AND home_score IS NOT NULL AND away_score IS NOT NULL
        AND utc_date IS NOT NULL
        AND utc_date < NOW() - INTERVAL '3 hours'`
  );
  return { settled: rowCount || 0 };
}

module.exports = { syncMatches, syncSecondary, settleStaleMatches };
