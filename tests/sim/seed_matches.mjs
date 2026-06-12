// Insert simulated matches straight into the DB (mimics what the football-data
// sync does), so we can verify /api/matches mirror + per-match scoring.
import pg from 'pg';
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const matches = JSON.parse(process.env.SIM_MATCHES);
for (const m of matches) {
  await c.query(
    `INSERT INTO matches (id,utc_date,status,stage,group_name,home_team,away_team,home_score,away_score,upset,synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (id) DO UPDATE SET home_score=EXCLUDED.home_score, away_score=EXCLUDED.away_score, status=EXCLUDED.status, upset=EXCLUDED.upset`,
    [m.id, m.utc_date, m.status, m.stage, m.group_name, m.home_team, m.away_team, m.home_score, m.away_score, !!m.upset]
  );
}
await c.query(`INSERT INTO sync_state (key,value,updated_at) VALUES ('last_sync_matches',$1,NOW())
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [JSON.stringify({at:Date.now(),count:matches.length})]);
console.log('seeded', matches.length, 'matches');
await c.end();
