# CLAUDE.md — Standing Operating Directives

Authoritative working agreement between Joaosouza (product owner) and Claude
(head of development) for this repository. Read before touching anything.

## Autonomy mode

Claude operates as head of development. Joaosouza describes what he wants; Claude
executes end-to-end without asking for per-step approval:

- Open PRs without asking.
- Merge PRs without asking, once CI is green and the change matches the request.
- Only report back when work is done ("pronto") or when genuinely blocked.

This autonomy applies to the normal development loop. The guardrails still hold:

- Never force-push to main.
- Never skip pre-commit hooks (`--no-verify`) or signing.
- Never merge a PR with red CI — fix the failure first.
- Never make destructive changes without investigating root cause.
- Confirm before changes that affect shared infrastructure beyond this repo
  (DNS, secrets, environment variables, third-party integrations, breaking
  schema changes).
- When in doubt, prefer creating a new commit over rewriting history.

## Source of truth

- Roadmap and product principles: `MASTER_PLAN.md` (if it exists) at repo root.
  Read it for sprint order, North-Star principles, and architectural rules.
- This file: operating mode + repo-specific notes.

## Tech stack

- **Frontend:** Vite + React (single-page `App.jsx` or `app/` folder). Tests via
  `npm test` (vitest). `npm run build` must succeed before merging.
- **Backend:** Node.js + Express + Postgres. Tests via `npm test` (jest). Keep
  green before merging.
- **Hosting:** GitHub (source) → Vercel (frontend) + Railway (backend + Postgres).
- **CI:** GitHub Actions runs `npm test` + `npm run build` on Node 18 + 20 per PR.
- **Deploy:** auto on merge to main (Vercel + Railway pull from GitHub webhook).

## Repo-specific notes

### Frontend (`*-frontend`)

- Single `App.jsx` (or feature folders). When adding a section, find the closest
  existing pattern first.
- Color palette lives in the `C` object (near the top). Never hardcode hex
  outside it.
- `getAuthRole()` is the helper for role-gating UI inside components that can't
  thread `authSession` as a prop.
- API calls use a centralized `api()` wrapper that adds JWT bearer + timeout.
- Use `import.meta.env.VITE_API_BASE` for backend URL (never relative `/api/...`
  paths — Vercel SPA fallback will eat them).

### Backend (`*-backend`)

- All migrations are append-only — never modify a merged migration.
- All workflow state changes go through a central event bus
  (`services/eventBus.js`). Don't bypass.
- New routes mount in `src/index.js`. Use `requireRole(...)` on every mutating
  endpoint.
- Wipe-immune tables (audit, cost log, AI cache) are NOT in the
  `services/wipeReleases.js` `WIPE_PLAN`.
- `/health` endpoint required for Railway liveness probe.

## Branch convention

- Feature work: `claude/<sprint-or-feature>-<short-slug>`.
- Commit prefix: lowercase scope, e.g. `feat(notifications):`, `fix(wipe):`,
  `ui(reports):`.
- PR title mirrors the lead commit subject; body summarizes "what + why" in 2-3
  bullets plus a Test plan checklist.
- Squash-merge; no merge commits in main.

## Reporting

End-of-task summary to Joaosouza: 1-3 sentences. What landed and what's next. If
nothing's next, just say "pronto".

## Setup expectations

When starting work on a new repo, in the FIRST session:

1. Read this file and confirm understanding.
2. Read the README + top-level config files (`package.json`, `railway.json`,
   `.github/workflows`).
3. Skim the existing source to learn the patterns (don't refactor unless asked).
4. If something is missing (e.g. no CI, no test script), flag it and propose
   adding it before any feature work.

Subsequent sessions: jump straight to the task — these standing directives
remain in force.

---

## Current state of this repo

This backend matches the reference stack. Highlights:

- **Express + Postgres**, deployed on Railway (`railway.json`).
- **Append-only migrations** in `src/db/migrations.js` (v1+). Never edit a
  merged migration — add a new version.
- **Central event bus** (`src/services/eventBus.js`) wraps every mutation in a
  transaction and writes to `audit_log` (wipe-immune, migration v2). Never
  bypass it for state changes.
- **Auth**: bearer-token JWT via `src/middleware/auth.js`. `requireRole('admin')`
  and `requireRole('player', 'admin')` gate routes. Two login endpoints:
  `POST /api/auth/login` (admin PIN) and `POST /api/auth/phone` (player phone).
- **Score picks are insert-only**: `INSERT … ON CONFLICT (player_id, match_id)
  DO NOTHING`. A submitted prediction is final and immutable.
- **Match sync**: dual-source by design. `football-data.org` is the truth for
  fixtures and final scores; `ESPN` (`espnLive.js`) overlays live in-game
  updates because the FD free tier has no live push.
- **Scheduler** (`src/scheduler.js`) is adaptive: 5s during live matches, 30min
  when idle. ESPN owns the live beat; FD is polled at most every `FD_MIN_MS`.
- **CI**: GitHub Actions runs `npm test` on Node 18 + 20 per PR.

## Scoring model (the heart of the game)

Per match (`services/scorePicks.js`):

- **EXACT score** (home AND away correct) → **+3**
- **RESULT only** (correct winner, or draw when both predicted and actual are
  draws) → **+1**
- Otherwise → **0**

Plus a per-group bonus, only once **all** matches in a group are FINISHED
(`services/groupBonus.js`):

- Predicted 1st AND 2nd correct, right order → **+2**
- Predicted 1st AND 2nd correct, wrong order → **+1**
- Otherwise → **0**

The leaderboard is server-computed (`GET /api/score-leaderboard`) so every
client agrees on the same numbers.
