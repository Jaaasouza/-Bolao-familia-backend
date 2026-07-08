// Bracket backfill from ESPN.
//
// football-data.org takes hours/days to propagate the bracket from the group
// standings (and again from each knockout round to the next). Meanwhile,
// fixtures in our DB carry NULL home_team / away_team and players can't pick
// them. ESPN's keyless scoreboard has the bracket teams much faster, so we
// fill missing knockout teams from there as a defensive backfill.
//
// Strategy:
//   - find knockout fixtures with a null team and manual_teams = FALSE within
//     the next two weeks (and a small lookback to forgive timezone fuzziness);
//   - group them by date; for each date, query ESPN's scoreboard;
//   - pair each ESPN event to our fixture by exact utc_date match;
//   - copy non-placeholder team names (filter out "Round of 32 1 Winner" etc.)
//     into the DB, normalised through teamAliases.
//
// `manual_teams` is left FALSE on purpose: if football-data eventually catches
// up with the correct bracket, the protective sync upsert (PR #14: null can't
// erase a known value) lets FD's real names win. ESPN here is a temporary
// best-effort source — admin-pinned values are still honoured everywhere.

const db = require('../db/pool');
const { resolveTeamName } = require('./teamAliases');

const KNOCKOUT_STAGES = ['LAST_32', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'THIRD_PLACE', 'FINAL'];
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

function leagueCode() {
  return process.env.ESPN_LEAGUE || 'fifa.world';
}

function enabled() {
  return process.env.LIVE_ESPN !== '0' && process.env.ESPN_BRACKET_BACKFILL !== '0';
}

// ESPN sometimes returns placeholder team names like "Round of 32 1 Winner" or
// "T1 Winner" when its own bracket isn't fully resolved either. Skip those —
// the column should stay null until a real team is known.
const PLACEHOLDER_RE = /winner|loser|tbd|round of|^[ts]?\d+\s|\?/i;
function isPlaceholderName(name) {
  if (!name) return true;
  const s = String(name).trim();
  if (!s) return true;
  return PLACEHOLDER_RE.test(s);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function yyyymmdd(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

// One ESPN scoreboard event → { utc_date, home, away }, or null.
function mapEvent(ev) {
  const comp = ev && ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const cs = comp.competitors || [];
  const homeC = cs.find((c) => c.homeAway === 'home');
  const awayC = cs.find((c) => c.homeAway === 'away');
  if (!homeC || !awayC) return null;
  const nameOf = (c) => (c.team && (c.team.displayName || c.team.name || c.team.shortDisplayName)) || '';
  return {
    utc_date: ev.date || comp.date || null,
    home: nameOf(homeC),
    away: nameOf(awayC),
  };
}

async function findMissingFixtures() {
  const { rows } = await db.query(
    `SELECT id, utc_date, stage, home_team, away_team
       FROM matches
      WHERE stage = ANY($1::text[])
        AND manual_teams = FALSE
        AND (home_team IS NULL OR away_team IS NULL)
        AND utc_date IS NOT NULL
        AND utc_date BETWEEN NOW() - INTERVAL '12 hours' AND NOW() + INTERVAL '21 days'
      ORDER BY utc_date`,
    [KNOCKOUT_STAGES]
  );
  return rows;
}

async function fetchScoreboard(date) {
  const res = await fetch(`${ESPN_BASE}/${leagueCode()}/scoreboard?dates=${date}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`espn ${res.status}`);
  const data = await res.json();
  return (data.events || []).map(mapEvent).filter(Boolean);
}

// Widen a yyyymmdd list by ±1 day. ESPN indexes events by "tournament day"
// (US-local for FIFA WC 2026), so a kickoff at 00:00-06:00 UTC lands in the
// PREVIOUS day's scoreboard. Without this, e.g. QF #4 (2026-07-12T01:00Z) is
// looked up on 20260712 (empty) instead of 20260711 (where ESPN actually
// publishes it).
function expandDatesByOne(dates) {
  const set = new Set();
  const parse = (s) => {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ''));
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  };
  for (const d of dates) {
    const dt = parse(d);
    if (!dt) { set.add(d); continue; }
    set.add(yyyymmdd(new Date(dt.getTime() - 86_400_000)));
    set.add(d);
    set.add(yyyymmdd(new Date(dt.getTime() + 86_400_000)));
  }
  return [...set];
}

// Returns { missing, filled, scanned, dates }.
async function backfillBracket() {
  if (!enabled()) return { skipped: true };

  const missing = await findMissingFixtures();
  if (!missing.length) return { missing: 0, filled: 0, scanned: 0, dates: 0 };

  const baseDates = [...new Set(missing.map((m) => yyyymmdd(new Date(m.utc_date))))];
  const dates = expandDatesByOne(baseDates);

  let scanned = 0;
  // Global index — an ESPN event's epoch is unique across days, so we can
  // safely merge events from D-1/D/D+1 into one map and pair against every
  // missing fixture in one pass.
  const byTime = new Map();

  for (const d of dates) {
    let events;
    try {
      events = await fetchScoreboard(d);
    } catch (e) {
      console.warn(`[bracket-backfill] espn ${d}: ${e.message}`);
      continue;
    }
    scanned += events.length;
    for (const ev of events) {
      const t = ev.utc_date ? new Date(ev.utc_date).getTime() : null;
      if (t != null && !byTime.has(t)) byTime.set(t, ev);
    }
  }

  let filled = 0;
  for (const m of missing) {
    const t = new Date(m.utc_date).getTime();
    const espn = byTime.get(t);
    if (!espn) continue;

    // Only fill the side that's currently null (don't disturb a half-known
    // fixture), and only with non-placeholder names.
    const newHome = !m.home_team && !isPlaceholderName(espn.home) ? resolveTeamName(espn.home) : null;
    const newAway = !m.away_team && !isPlaceholderName(espn.away) ? resolveTeamName(espn.away) : null;
    if (!newHome && !newAway) continue;

    await db.query(
      `UPDATE matches
          SET home_team = COALESCE($2, home_team),
              away_team = COALESCE($3, away_team),
              last_updated = NOW(), synced_at = NOW()
        WHERE id = $1 AND manual_teams = FALSE`,
      [m.id, newHome, newAway]
    );
    filled += 1;
  }

  // Surface on /api/sync-status so operators can see when ESPN saved the day.
  try {
    await db.query(
      `INSERT INTO sync_state (key, value, updated_at)
       VALUES ('last_bracket_backfill', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify({ at: Date.now(), missing: missing.length, filled, scanned, dates: dates.length })]
    );
  } catch (_) { /* best-effort */ }

  return { missing: missing.length, filled, scanned, dates: dates.length };
}

module.exports = {
  backfillBracket,
  isPlaceholderName,
  mapEvent,
  findMissingFixtures,
  expandDatesByOne,
  KNOCKOUT_STAGES,
};
