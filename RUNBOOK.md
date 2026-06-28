# Runbook — Post-Deploy Steps

Manual steps required after the cleanup + bug-fix PRs land. Each step is
**reversible** and uses only existing safety mechanisms (audit_log, insert-only
picks, manual_score immunity). No destructive operations.

---

## 0. Backup the production DB

Always do this before any data-touching step.

```bash
# Run on your laptop (Railway's DATABASE_URL is in your project's Variables tab)
pg_dump "$DATABASE_URL" --no-owner --no-acl > bolao-familia-$(date +%Y%m%d-%H%M).dump
```

Keep the file somewhere safe. Restore with `pg_restore` if anything goes wrong.

---

## 1. Run the diagnostic queries (read-only)

Open `psql "$DATABASE_URL"` (or any SQL client) and run:

### 1a. Orphan picks — points silently lost

```sql
SELECT sp.player_id, sp.match_id, p.name, sp.pred_home, sp.pred_away, sp.phase
  FROM score_picks sp
  LEFT JOIN matches m ON m.id = sp.match_id
  LEFT JOIN players p ON p.id = sp.player_id
 WHERE m.id IS NULL
 ORDER BY p.name;
```

If this returns rows, those players have predictions pointing at deleted match
rows. They're scoring 0 for those games even when they're right. Fix in
step 3.

### 1b. Matches finalized without scores

```sql
SELECT id, home_team, away_team, status, home_score, away_score, utc_date, group_name
  FROM matches
 WHERE status = 'FINISHED'
   AND (home_score IS NULL OR away_score IS NULL);
```

Should be empty. If not, fix manually in step 4.

### 1c. Matches that kicked off long ago but still have no score

```sql
SELECT id, home_team, away_team, status, home_score, away_score, utc_date
  FROM matches
 WHERE utc_date < NOW() - INTERVAL '4 hours'
   AND (home_score IS NULL OR away_score IS NULL)
 ORDER BY utc_date DESC;
```

These are the "didn't compute" candidates. Fix in step 4.

### 1d. Simultaneous group games (last-day fixtures, FIFA rule)

```sql
SELECT a.id, a.home_team, a.away_team, a.status, a.home_score, a.away_score,
       b.id AS pair_id, b.home_team AS pair_home, b.away_team AS pair_away,
       b.status AS pair_status, b.home_score AS pair_hs, b.away_score AS pair_as,
       a.group_name, a.utc_date
  FROM matches a
  JOIN matches b ON a.group_name = b.group_name
                AND a.utc_date = b.utc_date
                AND a.id < b.id
 WHERE a.group_name IS NOT NULL
 ORDER BY a.utc_date DESC;
```

Pairs where one game has a score and the other is null → smoking gun for the
ESPN alias gap.

### 1e. Was anything unmatched recently? (new endpoint)

```bash
curl -s https://<backend>.up.railway.app/api/sync-status | jq '.lastUnmatchedEspn'
```

After this deploy, ESPN fixtures that fail to pair are logged here.
`null` means everything pairs cleanly. Otherwise you'll see the team names
ESPN sent that aren't in `teamAliases.js`.

---

## 2. (If 1e shows unmatched) — Fix `teamAliases.js`

Edit `src/services/teamAliases.js`, add the unmatched ESPN spelling to the
`ALIASES` object for the corresponding canonical name. Commit, deploy, watch
`/api/sync-status` clear within one scheduler tick.

---

## 3. Reconcile orphan picks

```bash
# Dry-run first — shows the plan, writes nothing.
node scripts/reconcile-orphan-picks.js

# If the plan looks right (and step 0 backup is in hand):
node scripts/reconcile-orphan-picks.js --apply -v
```

Each reassignment goes through `eventBus.emit()` → `audit_log` row recording
`oldMatchId` + `newMatchId`. Reversible via SQL by reading the audit_log if
needed.

---

## 4. Manually set missing scores

For each match found in 1b/1c that didn't recover, set the final score via the
admin UI (Admin panel → match → enter score) or directly via API:

```bash
TOKEN=<your admin JWT from /api/auth/login>
curl -X POST https://<backend>.up.railway.app/api/matches/<id>/score \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "home": 1, "away": 2, "status": "FINISHED" }'
```

This sets `manual_score=true`, immune to future sync overwrites. Audited.

---

## 5. Smoke-test end-to-end

After step 3 / 4, log in as a player and confirm:

1. Open the leaderboard — totals reflect the reconciled / manually-set games.
2. Open "My Picks" — predictions show the correct point credits.
3. Confirm with one specific player whose orphan was reconciled (e.g. via
   audit_log: `SELECT * FROM audit_log WHERE event = 'score_picks.reconcile'
   ORDER BY created_at DESC LIMIT 10;`).

---

## 6. Verify rate-limit didn't lock you out

```bash
# Five wrong PINs in a row should trip the limit.
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://<backend>.up.railway.app/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"password":"wrong"}'
done
# Expect: 401 401 401 401 401
# Next attempt:
curl -s -X POST https://<backend>.up.railway.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"wrong"}'
# Expect: 429 with retryAfterSeconds
```

Wait the window or log in successfully to reset.

---

## Rollback

If anything goes wrong:

1. Restore the DB dump from step 0: `pg_restore -d "$DATABASE_URL" --clean
   bolao-familia-YYYYMMDD-HHMM.dump`
2. Revert the PR(s) in GitHub → Railway redeploys the previous code
   automatically.

Audit log is wipe-immune, so the trail of what happened is preserved across
restores.
