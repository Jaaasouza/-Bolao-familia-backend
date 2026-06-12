const { resolveTeamName } = require('./teamAliases');

const BASE = 'https://api.football-data.org/v4';

// Free tier: 10 requests/min. Defensive in-memory sliding window — stop just
// under the cap and back off hard on a 429. At a 7s live cadence we do ~8.5
// calls/min, so the guard sits at 9 (1 below the hard limit) — a single call
// already returns every match.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 9;
const PAUSE_MS = 90_000;

let calls = [];
let pausedUntil = 0;

function rateInfo() {
  const now = Date.now();
  calls = calls.filter((t) => now - t < WINDOW_MS);
  return { used: calls.length, max: MAX_PER_WINDOW, pausedUntil };
}

function canCall() {
  if (Date.now() < pausedUntil) return false;
  return rateInfo().used < MAX_PER_WINDOW;
}

// Flatten the football-data.org match shape into our row shape.
function mapMatch(m) {
  return {
    id: m.id,
    utc_date: m.utcDate || null,
    status: m.status || null,
    stage: m.stage || null,
    group_name: m.group || null,
    home_team: resolveTeamName((m.homeTeam && m.homeTeam.name) || null),
    away_team: resolveTeamName((m.awayTeam && m.awayTeam.name) || null),
    home_score: m.score && m.score.fullTime ? m.score.fullTime.home ?? null : null,
    away_score: m.score && m.score.fullTime ? m.score.fullTime.away ?? null : null,
    winner: m.score ? m.score.winner || null : null,
    last_updated: m.lastUpdated || null,
    // Full payload (minute, half-time, venue, matchday, referees…) is kept here
    // and returned to the frontend, which reads what it needs from raw.
    raw: m,
  };
}

async function fetchJson(path) {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error('FOOTBALL_DATA_API_KEY not configured');

  if (!canCall()) {
    const e = new Error('Rate limit guard active');
    e.code = 'RATE_LIMITED';
    throw e;
  }
  calls.push(Date.now());

  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Auth-Token': key } });
  if (res.status === 429) {
    pausedUntil = Date.now() + PAUSE_MS;
    const e = new Error('football-data 429 — backing off');
    e.code = 'RATE_LIMITED';
    throw e;
  }
  if (!res.ok) throw new Error(`football-data ${res.status}`);
  return res.json();
}

async function fetchAllMatches() {
  const comp = process.env.FOOTBALL_DATA_COMPETITION || 'WC';
  const data = await fetchJson(`/competitions/${comp}/matches`);
  return (data.matches || []).map(mapMatch);
}

// Official FIFA standings → { [group]: { first, second, table:[...] } }.
// football-data returns one GROUP-type standing per group with a sorted table.
function mapStandings(data) {
  const out = {};
  for (const s of data.standings || []) {
    if (s.type && s.type !== 'TOTAL') continue;
    if (!s.group) continue;
    const key = String(s.group).replace(/^GROUP[_ ]?/i, '').trim();
    const table = (s.table || []).map((row) => ({
      position: row.position,
      team: resolveTeamName(row.team && row.team.name),
      played: row.playedGames,
      won: row.won,
      draw: row.draw,
      lost: row.lost,
      points: row.points,
      gf: row.goalsFor,
      ga: row.goalsAgainst,
      gd: row.goalDifference,
    }));
    // Only declare 1st/2nd once the group has actually been played. Before
    // kickoff every team is 0pts/0 games and the API still returns a (seed-
    // ordered) table — declaring positions then would award group bonuses for
    // matches that haven't happened. Require at least one played game AND the
    // top team to have points.
    const anyPlayed = table.some((r) => (r.played || 0) > 0);
    const leaderHasPoints = table[0] && (table[0].points || 0) > 0;
    const decided = anyPlayed && leaderHasPoints;
    out[key] = {
      first: decided && table[0] ? table[0].team : null,
      second: decided && table[1] ? table[1].team : null,
      table, // full table is always exposed (shows 0-0-0 pre-tournament)
    };
  }
  return out;
}

async function fetchStandings() {
  const comp = process.env.FOOTBALL_DATA_COMPETITION || 'WC';
  const data = await fetchJson(`/competitions/${comp}/standings`);
  return mapStandings(data);
}

// Top scorers → [{ team, player, goals, assists }].
function mapScorers(data) {
  return (data.scorers || []).map((s) => ({
    player: s.player && s.player.name,
    nationality: s.player && s.player.nationality,
    team: resolveTeamName(s.team && s.team.name),
    goals: s.goals ?? 0,
    assists: s.assists ?? null,
    penalties: s.penalties ?? null,
  }));
}

async function fetchScorers(limit = 20) {
  const comp = process.env.FOOTBALL_DATA_COMPETITION || 'WC';
  const data = await fetchJson(`/competitions/${comp}/scorers?limit=${limit}`);
  return mapScorers(data);
}

module.exports = {
  fetchAllMatches, fetchStandings, fetchScorers,
  rateInfo, canCall, mapMatch, mapStandings, mapScorers,
};
