# World Cup full-tournament simulation

An end-to-end load/behaviour test that drives the **real** backend through an
entire World Cup, to catch surprises before the actual tournament.

What it exercises:

- registers **100 fictional players** via the public `POST /api/register`
- verifies the **lock**: re-registering an existing name returns `409`
- simulates the whole tournament **by team strength** (probabilistic): 72 group
  matches + knockouts to a champion, with upsets flagged
- writes **standings** and **team phases** through the admin API (so the
  **event bus + audit_log** path is exercised)
- seeds the simulated matches into Postgres (mimicking the football-data sync),
  then **reads them back from the mirror** (`/api/state`, `/api/matches`,
  `/api/players`) and computes the leaderboard with the same scoring the
  frontend uses
- asserts: ≥95 players registered, lock enforced, phases persisted, score
  variety, champion reflected in the mirror

It is **not** part of `npm test` (it needs a running server + Postgres; jest is
configured to ignore `tests/sim/`).

## Run it locally

```bash
# 1. Postgres running, schema migrated:
DATABASE_URL=postgres://... node src/db/migrate.js

# 2. backend running against that DB (no FOOTBALL_DATA_API_KEY so the
#    scheduler stays off):
DATABASE_URL=postgres://... JWT_SECRET=... ADMIN_PASSWORD=2026 PORT=3055 node src/index.js &

# 3. run the sim (the seeder needs DATABASE_URL to insert matches):
BASE=http://localhost:3055 ADMIN_PASSWORD=2026 \
  DATABASE_URL=postgres://... \
  SEED_MATCHES_CMD="node tests/sim/seed_matches.mjs" \
  node tests/sim/worldcup-sim.mjs
```

## Last verified result

100 players · 72 group + 15 knockout matches · 24 teams advanced ·
500 concurrent `/api/state` reads → **0 external football-data calls**
(read path is a pure DB mirror) · `/api/state` ~3ms · audit_log captured every
mutation (`player.register ×100`, `phases.update`, `standings.update`).
