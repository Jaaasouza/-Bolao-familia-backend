// Scoreline-pick scoring (the new game model).
//
// Each player predicts the exact score of each match. Points per match:
//   - EXACT score (home AND away correct)      → 3
//   - correct RESULT only (winner, or a draw   → 1
//     when both predicted and actual are draws)
//   - otherwise                                → 0
//
// Examples (per the product owner):
//   actual 2-1 (home win): pred 2-1 → 3 ; pred 1-0 (home win) → 1 ; pred 0-1 → 0
//   actual 1-1 (draw):     pred 1-1 → 3 ; pred 2-2 (draw)     → 1 ; pred 1-0 → 0

const EXACT = 3;
const RESULT = 1;

function outcome(h, a) {
  if (h > a) return 'H';
  if (h < a) return 'A';
  return 'D';
}

// Points for one prediction vs one actual scoreline. Returns 0 if either side
// is missing (match not played / no pick).
function scorePick(pred, actual) {
  if (!pred || !actual) return 0;
  if (pred.home == null || pred.away == null) return 0;
  if (actual.home == null || actual.away == null) return 0;
  if (pred.home === actual.home && pred.away === actual.away) return EXACT;
  if (outcome(pred.home, pred.away) === outcome(actual.home, actual.away)) return RESULT;
  return 0;
}

// Statuses where a leftover score must NOT be scored (void games).
const VOID_STATUS = new Set(['CANCELLED', 'CANCELED', 'POSTPONED', 'SUSPENDED', 'ABANDONED']);
// Back-compat: the explicit "live/finished" set (still exported).
const COUNTABLE = new Set(['FINISHED', 'IN_PLAY', 'PAUSED', 'LIVE']);

// A match counts once it has actually been played — i.e. it HAS a scoreline —
// and isn't a void game. We key off the score, not an exact status, so a game
// whose status lags (e.g. one of two simultaneous games stuck at TIMED while the
// other is IN_PLAY, or a feed reporting a final score before flipping to
// FINISHED) still counts. Pre-match games have null scores → not counted.
function isCountable(m) {
  if (!m) return false;
  if (VOID_STATUS.has(m.status)) return false;
  return m.home_score != null && m.away_score != null;
}

// Total for a player across all their score picks.
// picks: [{ match_id, pred_home, pred_away }]
// matchesById: { [id]: { home_score, away_score, status } }
function totalForPlayer(picks, matchesById) {
  let total = 0;
  let exact = 0;
  let resultOnly = 0;
  for (const p of picks || []) {
    const m = matchesById[p.match_id];
    if (!isCountable(m)) continue;
    const pts = scorePick(
      { home: p.pred_home, away: p.pred_away },
      { home: m.home_score, away: m.away_score }
    );
    total += pts;
    if (pts === EXACT) exact += 1;
    else if (pts === RESULT) resultOnly += 1;
  }
  return { total, exact, resultOnly };
}

module.exports = { scorePick, totalForPlayer, outcome, isCountable, EXACT, RESULT, COUNTABLE };
