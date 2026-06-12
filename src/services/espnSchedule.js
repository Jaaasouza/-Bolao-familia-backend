// ESPN schedule seeder.
//
// football-data.org needs a paid-ish key, so the família pool sources its whole
// fixture list from ESPN's free, keyless public API instead (the same endpoint
// the live overlay already uses). This module FETCHES the tournament schedule
// and UPSERTS it into the matches table (espnLive.js then keeps those rows live).
//
//   - Source: https://site.api.espn.com/apis/site/v2/sports/soccer/<league>/scoreboard
//   - League is configurable via ESPN_LEAGUE (default fifa.world).
//   - Keyless, no quota; failures are caught by the caller (never break the loop).
//   - Disable with LIVE_ESPN=0; widen/narrow the window with ESPN_DATES_FROM /
//     ESPN_DATES_TO (YYYYMMDD) when ESPN's calendar isn't available.
const { resolveTeamName } = require('./teamAliases');
const { TEAM_TO_GROUP } = require('../data/groups');
const { upsertMatches } = require('./syncMatches');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const MAX_DATES = 80; // safety cap on how many days we'll fetch in one seed

const leagueCode = () => process.env.ESPN_LEAGUE || 'fifa.world';
const enabled = () => process.env.LIVE_ESPN !== '0';

// ESPN status.type → our football-data-style status. Unlike the live overlay,
// the seeder maps the pre-game state to TIMED so fixtures land before kickoff.
function scheduleStatus(type) {
  const name = (type && type.name) || '';
  const state = (type && type.state) || '';
  if (name === 'STATUS_HALFTIME') return 'PAUSED';
  if (state === 'in') return 'IN_PLAY';
  if (state === 'post') return 'FINISHED';
  return 'TIMED'; // 'pre' / scheduled / postponed / unknown → not yet played
}

// Best-effort stage + group from any ESPN label (note headline, event name…).
// Returns { stage, group_name } using the same codes football-data emits, so the
// frontend's phaseOf()/groupKey() keep working unchanged.
function stageGroupFrom(text) {
  const t = String(text || '');
  const g = /group\s+([A-L])\b/i.exec(t);
  if (g) return { stage: 'GROUP_STAGE', group_name: `GROUP_${g[1].toUpperCase()}` };
  if (/third[-\s]?place|3rd[-\s]?place/i.test(t)) return { stage: 'THIRD_PLACE', group_name: null };
  if (/round of 32|last 32|1\/16/i.test(t)) return { stage: 'LAST_32', group_name: null };
  if (/round of 16|last 16|1\/8|eighth/i.test(t)) return { stage: 'LAST_16', group_name: null };
  if (/quarter/i.test(t)) return { stage: 'QUARTER_FINALS', group_name: null };
  if (/semi/i.test(t)) return { stage: 'SEMI_FINALS', group_name: null };
  if (/\bfinal\b/i.test(t)) return { stage: 'FINAL', group_name: null };
  return null;
}

// Decide a match's stage + group. ESPN doesn't reliably label the group on its
// scoreboard, so we (1) try any explicit label, then (2) fall back to the fixed
// 2026 draw: two teams from the SAME group ⇒ a group-stage game in that group.
function resolveStageGroup(ev, comp, homeTeam, awayTeam) {
  const labels = [];
  for (const n of (comp && comp.notes) || []) {
    if (n && n.headline) labels.push(n.headline);
  }
  if (ev && ev.name) labels.push(ev.name);
  if (ev && ev.shortName) labels.push(ev.shortName);
  if (ev && ev.season && ev.season.slug) labels.push(ev.season.slug);
  for (const l of labels) {
    const sg = stageGroupFrom(l);
    if (sg) return sg;
  }
  // Derive the group from the known draw when both teams share one.
  const gh = TEAM_TO_GROUP[homeTeam];
  const ga = TEAM_TO_GROUP[awayTeam];
  if (gh && gh === ga) return { stage: 'GROUP_STAGE', group_name: `GROUP_${gh}` };
  // Unknown → treat as group stage with no letter (phaseOf(null) is 'group' too).
  return { stage: 'GROUP_STAGE', group_name: null };
}

// One ESPN scoreboard event → a matches-table row, or null if unusable.
function mapScheduleEvent(ev) {
  const comp = ev && ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const competitors = comp.competitors || [];
  const homeC = competitors.find((c) => c.homeAway === 'home');
  const awayC = competitors.find((c) => c.homeAway === 'away');
  if (!homeC || !awayC) return null;

  // ESPN event id is the primary key (numeric) and the espn_id for the overlays.
  const espnId = ev.id != null ? String(ev.id) : null;
  if (!espnId || !/^\d+$/.test(espnId)) return null;

  const teamName = (c) => resolveTeamName(
    (c.team && (c.team.displayName || c.team.name || c.team.shortDisplayName)) || ''
  );
  const score = (c) => (c.score === undefined || c.score === null || c.score === '' ? null : Number(c.score));
  const status = scheduleStatus((ev.status && ev.status.type) || (comp.status && comp.status.type));
  const homeTeam = teamName(homeC);
  const awayTeam = teamName(awayC);
  const homeScore = score(homeC);
  const awayScore = score(awayC);
  const winner = status === 'FINISHED' && homeScore != null && awayScore != null
    ? (homeScore > awayScore ? 'HOME_TEAM' : homeScore < awayScore ? 'AWAY_TEAM' : 'DRAW')
    : null;
  const { stage, group_name } = resolveStageGroup(ev, comp, homeTeam, awayTeam);

  return {
    id: Number(espnId),
    espn_id: espnId,
    utc_date: ev.date || comp.date || null,
    status,
    stage,
    group_name,
    home_team: homeTeam,
    away_team: awayTeam,
    home_score: homeScore,
    away_score: awayScore,
    winner,
    last_updated: new Date().toISOString(),
    raw: ev,
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }
function toYyyymmdd(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

// Build a YYYYMMDD list from ESPN's league calendar (array of ISO strings or of
// objects carrying startDate). Falls back to [] when the shape is unrecognised.
function datesFromCalendar(data) {
  const cal = data && data.leagues && data.leagues[0] && data.leagues[0].calendar;
  if (!Array.isArray(cal)) return [];
  const out = new Set();
  for (const entry of cal) {
    const iso = typeof entry === 'string' ? entry : (entry && (entry.startDate || entry.value));
    const d = iso ? new Date(iso) : null;
    if (d && !Number.isNaN(d.getTime())) out.add(toYyyymmdd(d));
  }
  return [...out];
}

// Inclusive day-by-day list between two YYYYMMDD strings (env override / default
// window when ESPN gives no usable calendar).
function buildWindowDates(from, to) {
  const parse = (s) => {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ''));
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b || b < a) return [];
  const out = [];
  for (let d = a; d <= b && out.length < MAX_DATES; d = new Date(d.getTime() + 86_400_000)) {
    out.push(toYyyymmdd(d));
  }
  return out;
}

async function fetchScoreboard(dateParam) {
  const url = `${ESPN_BASE}/${leagueCode()}/scoreboard${dateParam ? `?dates=${dateParam}` : ''}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`espn scoreboard ${res.status}`);
  return res.json();
}

// Decide which days to fetch: ESPN's own calendar first, else the configured /
// default tournament window (June 11 – July 19, overridable via env).
function scheduleDates(baseData) {
  const fromCal = datesFromCalendar(baseData);
  if (fromCal.length) return fromCal.slice(0, MAX_DATES);
  const from = process.env.ESPN_DATES_FROM || '20260611';
  const to = process.env.ESPN_DATES_TO || '20260719';
  return buildWindowDates(from, to);
}

// Fetch the whole schedule from ESPN and upsert it into matches. Returns
// { count, dates } (or { skipped } when disabled / nothing came back).
async function syncEspnSchedule(actor = 'scheduler') {
  if (!enabled()) return { count: 0, skipped: true };

  // One base call doubles as "today's games" and the source of the calendar.
  const base = await fetchScoreboard();
  const dates = scheduleDates(base);

  const byId = new Map();
  for (const ev of (base.events || [])) {
    const row = mapScheduleEvent(ev);
    if (row) byId.set(row.id, row);
  }
  for (const day of dates) {
    let data;
    try {
      data = await fetchScoreboard(day);
    } catch (e) {
      // One bad day must not abort the whole seed.
      console.warn(`[espn-schedule] ${day} failed:`, e.message);
      continue;
    }
    for (const ev of (data.events || [])) {
      const row = mapScheduleEvent(ev);
      if (row) byId.set(row.id, row);
    }
  }

  const matches = [...byId.values()];
  if (!matches.length) return { count: 0, skipped: true };
  await upsertMatches(matches, actor, 'matches.espn_schedule');
  return { count: matches.length, dates: dates.length };
}

module.exports = {
  syncEspnSchedule,
  mapScheduleEvent,
  stageGroupFrom,
  resolveStageGroup,
  scheduleStatus,
  datesFromCalendar,
  buildWindowDates,
  scheduleDates,
};
