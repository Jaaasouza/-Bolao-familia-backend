const { fetchAllMatches, fetchStandings, fetchScorers } = require('./footballData');
const { emit } = require('./eventBus');
const db = require('../db/pool');

// Upsert a list of normalized match rows. Shared by the football-data sync and
// the ESPN schedule seeder, so both go through the same protective merge:
//   - admin manual scores (manual_score) are never overwritten;
//   - a FINISHED row is immutable to the sync (a lagging source must never
//     un-finish a game or wipe its points);
//   - a known score is never nulled; status only moves forward;
//   - espn_id is filled when a source provides it and kept otherwise.
// `stateKey` records the outcome in sync_state for /api/sync-status.
async function upsertMatches(matches, actor = 'scheduler', eventName = 'matches.sync', stateKey = 'last_sync_matches') {
  if (!matches || !matches.length) return { count: 0, skipped: true };

  await emit(
    eventName,
    { actor, entity: 'matches', data: { count: matches.length } },
    async (client) => {
      for (const m of matches) {
        await client.query(
          `INSERT INTO matches
             (id, utc_date, status, stage, group_name, home_team, away_team,
              home_score, away_score, winner, last_updated, raw, espn_id, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
           ON CONFLICT (id) DO UPDATE SET
             utc_date     = EXCLUDED.utc_date,
             stage        = EXCLUDED.stage,
             group_name   = EXCLUDED.group_name,
             home_team    = EXCLUDED.home_team,
             away_team    = EXCLUDED.away_team,
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
             espn_id      = COALESCE(EXCLUDED.espn_id, matches.espn_id),
             last_updated = EXCLUDED.last_updated,
             raw          = EXCLUDED.raw,
             synced_at    = NOW()`,
          [
            m.id, m.utc_date, m.status, m.stage, m.group_name, m.home_team,
            m.away_team, m.home_score, m.away_score, m.winner, m.last_updated,
            m.raw, m.espn_id || null,
          ]
        );
      }
      await client.query(
        `INSERT INTO sync_state (key, value, updated_at)
         VALUES ($2, $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify({ at: Date.now(), count: matches.length }), stateKey]
      );
    }
  );

  return { count: matches.length };
}

// When football-data is the fixture source, remove any rows the ESPN seeder
// created (its PK equals its espn_id) so each game isn't duplicated. football-
// data rows keep their own id (≠ espn_id) and are never touched; the ESPN live
// overlay still attaches to them by team name. Best-effort, idempotent.
async function purgeEspnSeeded() {
  try {
    const { rowCount } = await db.query(
      "DELETE FROM matches WHERE espn_id IS NOT NULL AND CAST(id AS TEXT) = espn_id"
    );
    if (rowCount) console.log(`[sync] purged ${rowCount} ESPN-seeded duplicate fixtures`);
    return { purged: rowCount || 0 };
  } catch (e) {
    console.warn('[sync] purge espn-seeded failed:', e.message);
    return { purged: 0, error: e.message };
  }
}

// Pull all matches from football-data.org and upsert them. Runs via the
// scheduler and the admin POST /api/sync-now endpoint.
async function syncMatches(actor = 'scheduler') {
  const matches = await fetchAllMatches();
  if (!matches.length) return { count: 0, skipped: true };
  const result = await upsertMatches(matches, actor, 'matches.sync', 'last_sync_matches');
  // football-data is now the source → drop any leftover ESPN-seeded fixtures.
  await purgeEspnSeeded();
  return result;
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

// Self-heal: settle a match that's clearly over so it always counts on the
// leaderboard. Two cases, so a LIVE match in a long stoppage/half-time break is
// never finished prematurely:
//   - stuck at TIMED/SCHEDULED (football-data lag) with a score, 3h+ after KO;
//   - still IN_PLAY/PAUSED only once 4h30 have passed (no match runs that long,
//     even with extra time + pens + a long break) → ESPN must have abandoned it.
// Never touches admin-set matches.
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
        AND (
          (status IN ('IN_PLAY','PAUSED','LIVE') AND utc_date < NOW() - INTERVAL '4 hours 30 minutes')
          OR (status NOT IN ('IN_PLAY','PAUSED','LIVE') AND utc_date < NOW() - INTERVAL '3 hours')
        )`
  );
  return { settled: rowCount || 0 };
}

module.exports = { syncMatches, syncSecondary, settleStaleMatches, upsertMatches, purgeEspnSeeded };
