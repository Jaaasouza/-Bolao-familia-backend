# USAM FIFA World Cup 2026 — Backend

Node.js + Express + Postgres backend for the USAM World Cup 2026 pool. Polls
**football-data.org** for live match data, stores everything in Postgres, and
serves a read API to the frontend plus admin endpoints for player picks, phases
and standings.

Deployed on **Railway** (auto-deploy on push to `main`); migrations run before
the server starts.

## Stack

- **Express** HTTP API (`src/app.js`, `src/routes/*`)
- **Postgres** via `pg` (`src/db/*`), append-only migrations
- **JWT** bearer auth — `requireRole('admin')` on every mutating endpoint
- **Event bus** (`src/services/eventBus.js`) — every mutation + audit log in one
  transaction
- **Scheduler** (`src/scheduler.js`) — polls football-data.org every minute

## Local development

```bash
npm install
cp .env.example .env        # fill in JWT_SECRET, ADMIN_PASSWORD, FOOTBALL_DATA_API_KEY
npm run migrate             # apply migrations to DATABASE_URL
npm start                   # http://localhost:3000
npm test                    # jest
```

You need a local Postgres reachable at `DATABASE_URL` (the default points at
`localhost:5432`).

## Endpoints

### Public (read-only)
- `GET /health` — liveness probe
- `GET /api/state` — matches + phases + standings + last sync
- `GET /api/matches`, `GET /api/players`, `GET /api/groups`,
  `GET /api/phases`, `GET /api/standings`, `GET /api/config`
- `GET /api/score-picks` — all picks grouped by player
- `GET /api/score-leaderboard` — server-computed ranking
- `GET /api/sync-status` — last sync result + rate-limit info
- `GET /api/push/key` — VAPID public key for web-push

### Auth
- `POST /api/auth/login` — `{ password }` → `{ token, role: "admin" }`
- `POST /api/auth/phone` — `{ phone }` → `{ token, player }`

### Player (`Authorization: Bearer <playerToken>`)
- `GET /api/my-score-picks` — my picks + award bets
- `POST /api/score-picks` — submit picks `{ picks:[{matchId,home,away}], awards }`
- `POST /api/register` — self-signup (closes after deadline)
- `POST /api/push/subscribe`, `POST /api/push/unsubscribe`
- `GET /api/chat`, `POST /api/chat`

### Admin (`Authorization: Bearer <adminToken>`)
- `POST /api/players`, `DELETE /api/players/:id`
- `POST /api/phases` — `{ "Brazil": "r16", ... }`
- `POST /api/standings` — `{ "A": { "first": "...", "second": "..." }, ... }`
- `POST /api/matches/:id/score` — manual score override (sets `manual_score=true`,
  immune to sync overwrites)
- `POST /api/matches/:id/upset` — toggle upset flag
- `POST /api/sync-now` — force an immediate football-data sync
- `DELETE /api/chat/:id` — moderation

## Scoring rules

Per match (`services/scorePicks.js`):
- **+3** exact scoreline (home AND away correct)
- **+1** correct result (winner, or draw when both predicted and actual are draws)
- **0** otherwise

Plus a per-group bonus, only when ALL group matches are FINISHED
(`services/groupBonus.js`):
- **+2** 1st AND 2nd correct, right order
- **+1** 1st AND 2nd correct, wrong order
- **0** otherwise

Predictions are insert-only (`ON CONFLICT … DO NOTHING`) — a submitted pick can
never be changed.

## Environment variables

See `.env.example`. On Railway, set these on the **backend** service (not the
Postgres service): `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `JWT_SECRET`,
`ADMIN_PASSWORD`, `ALLOWED_ORIGINS`, `FOOTBALL_DATA_API_KEY`, `NODE_ENV`.

## Deploy (Railway)

`railway.json` sets the start command to
`node src/db/migrate.js && node src/index.js` — migrations run first, and if a
migration fails the deploy aborts. Health check is `GET /health`.

## CI

GitHub Actions (`.github/workflows/test.yml`) runs `npm test` on Node 18 + 20
and a `migration-smoke` job that applies migrations against a real Postgres 15
service (twice, to prove idempotency). Don't merge with red CI.
