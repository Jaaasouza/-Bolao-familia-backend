// Mirror mode — pull match data from another pool's backend instead of
// football-data.org.
//
// Two pools of the SAME tournament share identical fixtures/scores. Rather than
// each backend spending football-data quota (10 req/min limit), a secondary
// pool can set MIRROR_SOURCE_URL to the primary pool's backend and copy its
// public matches + standings into its own DB. Players, picks, leaderboard and
// notifications all stay local to each pool — only the match data is mirrored.
const { emit } = require('./eventBus');

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const e = new Error(`mirror fetch ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// Copy matches (+ decided standings) from the source backend. Upserts use the
// same protective merge as syncMatches:
//   - admin manual scores (manual_score) are never overwritten;
//   - admin manual teams (manual_teams) are never overwritten;
//   - a FINISHED row's score is immutable to the mirror;
//   - a known team name is never nulled (defence against the source briefly
//     losing a team assignment on a knockout fixture).
// The per-pool `upset` flag is intentionally NOT mirrored.
async function mirrorFromSource(sourceUrl) {
  const base = String(sourceUrl).replace(/\/+$/, '');
  const [matchesJson, standingsJson] = await Promise.all([
    fetchJson(`${base}/api/matches`),
    fetchJson(`${base}/api/standings`).catch(() => ({ standings: {} })),
  ]);

  const matches = (matchesJson && matchesJson.matches) || [];
  if (!matches.length) return { count: 0, skipped: true };
  const standings = (standingsJson && standingsJson.standings) || {};

  await emit(
    'matches.mirror',
    { actor: 'mirror', entity: 'matches', data: { count: matches.length, source: base } },
    async (client) => {
      for (const m of matches) {
        const raw = m.raw == null ? null
          : (typeof m.raw === 'string' ? m.raw : JSON.stringify(m.raw));
        await client.query(
          `INSERT INTO matches
             (id, utc_date, status, stage, group_name, home_team, away_team,
              home_score, away_score, winner, last_updated, raw, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
           ON CONFLICT (id) DO UPDATE SET
             utc_date     = EXCLUDED.utc_date,
             status       = CASE
                              WHEN matches.manual_score THEN matches.status
                              WHEN matches.status = 'FINISHED' THEN 'FINISHED'
                              ELSE EXCLUDED.status END,
             stage        = EXCLUDED.stage,
             group_name   = EXCLUDED.group_name,
             home_team    = CASE
                              WHEN matches.manual_teams THEN matches.home_team
                              WHEN EXCLUDED.home_team IS NULL THEN matches.home_team
                              ELSE EXCLUDED.home_team END,
             away_team    = CASE
                              WHEN matches.manual_teams THEN matches.away_team
                              WHEN EXCLUDED.away_team IS NULL THEN matches.away_team
                              ELSE EXCLUDED.away_team END,
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
            m.away_team, m.home_score, m.away_score, m.winner, m.last_updated, raw,
          ]
        );
      }
      // Mirror decided group standings (only declared 1st/2nd come through).
      for (const [g, v] of Object.entries(standings)) {
        await client.query(
          `INSERT INTO standings (group_name, first_team, second_team, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (group_name) DO UPDATE SET
             first_team = EXCLUDED.first_team, second_team = EXCLUDED.second_team, updated_at = NOW()`,
          [g, v && v.first, v && v.second]
        );
      }
      await client.query(
        `INSERT INTO sync_state (key, value, updated_at)
         VALUES ('last_mirror', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify({ at: Date.now(), count: matches.length, source: base })]
      );
    }
  );

  return { count: matches.length };
}

module.exports = { mirrorFromSource };
