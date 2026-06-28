#!/usr/bin/env node
//
// Reconcile orphan score_picks.
//
// Background — see scoring bug investigation 2026-06-27:
//
//   score_picks.match_id is BIGINT NOT NULL with NO foreign key to matches.id
//   (migration v7). When the backend transitions from ESPN-seed mode to
//   football-data, purgeEspnSeeded() (services/syncMatches.js) deletes the
//   ESPN-seeded rows where CAST(id AS TEXT) = espn_id. Any pick saved against
//   that ESPN id is left dangling: the leaderboard joins picks ↔ matches in
//   JS (matchesById[p.match_id]) and silently treats the missing row as
//   "not countable" → 0 points.
//
// Reconciliation strategy:
//
//   For each orphan whose match_id no longer exists in matches, look for a
//   row in matches whose espn_id equals the orphan's match_id. This works
//   because espnLive.js writes the ESPN id back onto the FD-imported row as
//   soon as it pairs them (services/espnLive.js:155-157). So:
//
//     orphan match_id = 727834   (deleted ESPN-seeded row)
//     current matches row with espn_id = '727834' (FD-imported row, new id)
//                                                  ← reassign pick to here
//
//   When no replacement is found, the pick is reported as unresolved and the
//   script moves on. Nothing is deleted.
//
// Safety:
//
//   - DRY-RUN by default. Pass `--apply` to actually update the DB.
//   - Never touches pred_home / pred_away — only the match_id.
//   - One transaction per pick (audited via eventBus).
//   - If the player already has a pick for the NEW id (they re-submitted
//     after the ESPN row went away), the orphan is dropped and the newer
//     conscious pick wins — we never overwrite a deliberate pick.
//
// Usage:
//
//   node scripts/reconcile-orphan-picks.js                # dry-run
//   node scripts/reconcile-orphan-picks.js --apply        # actually update
//   node scripts/reconcile-orphan-picks.js --apply -v     # + per-pick output
//
// Requires DATABASE_URL in env. Run from the backend root.

const db = require('../src/db/pool');
const { emit } = require('../src/services/eventBus');

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

function log(...args) {
  console.log(...args);
}
function vlog(...args) {
  if (VERBOSE) console.log(...args);
}

// Picks pointing at a match_id that no longer exists in `matches`.
async function findOrphans() {
  const { rows } = await db.query(`
    SELECT sp.player_id, sp.match_id, sp.pred_home, sp.pred_away, sp.phase,
           sp.created_at, sp.updated_at, p.name AS player_name
      FROM score_picks sp
      LEFT JOIN matches m ON m.id = sp.match_id
      LEFT JOIN players p ON p.id = sp.player_id
     WHERE m.id IS NULL
     ORDER BY p.name, sp.created_at
  `);
  return rows;
}

// Try to find the current matches row that is the same fixture as the orphan's
// long-gone match. Primary lookup: espn_id. Returns the new match row or null.
async function findReplacement(orphan) {
  const { rows } = await db.query(
    `SELECT id, home_team, away_team, stage, utc_date, status, home_score, away_score
       FROM matches
      WHERE espn_id = $1
      LIMIT 2`,
    [String(orphan.match_id)]
  );
  if (rows.length === 1) return { match: rows[0], reason: 'espn_id match' };
  // Two candidates with same espn_id should never happen, but skip if it does.
  return null;
}

// Reassign: INSERT new pick row + DELETE the orphan, atomically + audited.
// ON CONFLICT DO NOTHING preserves any deliberate newer pick the player made
// against the new id (e.g. pre-kickoff after the old row went away).
async function reassign(orphan, newMatchId) {
  return emit(
    'score_picks.reconcile',
    {
      actor: 'reconcile-script',
      entity: 'score_picks',
      entityId: orphan.player_id,
      data: {
        playerName: orphan.player_name,
        oldMatchId: String(orphan.match_id),
        newMatchId: String(newMatchId),
        pred: { home: orphan.pred_home, away: orphan.pred_away },
        phase: orphan.phase || null,
      },
    },
    async (client) => {
      const ins = await client.query(
        `INSERT INTO score_picks
           (player_id, match_id, pred_home, pred_away, phase, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (player_id, match_id) DO NOTHING
         RETURNING player_id`,
        [orphan.player_id, newMatchId, orphan.pred_home, orphan.pred_away,
         orphan.phase || null, orphan.created_at, orphan.updated_at]
      );
      const created = ins.rowCount > 0;
      const del = await client.query(
        `DELETE FROM score_picks WHERE player_id = $1 AND match_id = $2`,
        [orphan.player_id, orphan.match_id]
      );
      return { created, deleted: del.rowCount };
    }
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Aborting.');
    process.exit(1);
  }

  log(`Mode: ${APPLY ? 'APPLY (will write)' : 'DRY-RUN (no changes)'}`);
  const orphans = await findOrphans();
  log(`Orphan picks found: ${orphans.length}`);

  if (!orphans.length) {
    log('Nothing to do.');
    await db.getPool().end();
    process.exit(0);
  }

  const results = { reassigned: 0, alreadyExisted: 0, unresolved: 0 };

  for (const o of orphans) {
    const replacement = await findReplacement(o);
    if (!replacement) {
      results.unresolved += 1;
      vlog(`  [SKIP] ${o.player_name || o.player_id} match=${o.match_id} pred=${o.pred_home}-${o.pred_away} (no replacement found by espn_id)`);
      continue;
    }
    vlog(`  [${APPLY ? 'APPLY' : 'PLAN'}] ${o.player_name || o.player_id} pred=${o.pred_home}-${o.pred_away}  match ${o.match_id} → ${replacement.match.id}  (${replacement.match.home_team} vs ${replacement.match.away_team}, ${replacement.reason})`);
    if (APPLY) {
      try {
        const { created } = await reassign(o, replacement.match.id);
        if (created) results.reassigned += 1;
        else results.alreadyExisted += 1;
      } catch (e) {
        console.error(`  [ERR] reassign ${o.player_id}/${o.match_id}: ${e.message}`);
        results.unresolved += 1;
      }
    } else {
      results.reassigned += 1;
    }
  }

  log('');
  log('Summary');
  log('  reassigned       :', results.reassigned);
  log('  already existed  :', results.alreadyExisted);
  log('  unresolved       :', results.unresolved);
  if (!APPLY) {
    log('');
    log('No changes were made. Re-run with --apply to commit.');
  }

  await db.getPool().end();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
