// ESPN lineups overlay.
//
// The scoreboard call (espnLive.js) doesn't carry lineups, so for matches that
// are live or about to kick off we fetch ESPN's per-match summary and parse the
// starting XI + bench + formation + coach. Stored as matches.lineups:
//   { home: { formation, coach, starters:[{num,name,pos,place}], subs:[...] },
//     away: { ... } }
// Lineups publish ~1h before kickoff, so this is a no-op until then. Keyless,
// best-effort; failures are swallowed.
const db = require('../db/pool');
const { resolveTeamName } = require('./teamAliases');
const { classifyEvent, parseMinute } = require('./espnLive');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const leagueCode = () => process.env.ESPN_LEAGUE || 'fifa.world';
const enabled = () => process.env.LIVE_ESPN !== '0';

function parsePlayer(r) {
  const a = r.athlete || {};
  return {
    num: r.jersey != null && r.jersey !== '' ? String(r.jersey) : null,
    name: a.displayName || a.shortName || a.fullName || null,
    pos: (r.position && (r.position.abbreviation || r.position.name)) || null,
    place: r.formationPlace != null ? Number(r.formationPlace) : null,
    starter: !!r.starter,
  };
}

function parseTeamRoster(rt) {
  const players = (rt.roster || []).map(parsePlayer).filter((p) => p.name);
  const starters = players.filter((p) => p.starter);
  let coach = null;
  const c = Array.isArray(rt.coach) ? rt.coach[0] : rt.coach;
  if (c) coach = c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || null;
  return {
    formation: (rt.formation && (rt.formation.name || rt.formation)) || null,
    coach,
    starters: (starters.length ? starters : players.slice(0, 11))
      .sort((a, b) => (a.place ?? 99) - (b.place ?? 99)),
    subs: players.filter((p) => !p.starter),
  };
}

// summary JSON → { home, away } lineups, or null if not published yet.
function parseLineups(summary) {
  const rosters = summary && summary.rosters;
  if (!Array.isArray(rosters) || rosters.length < 2) return null;

  const haById = {};
  const comp = summary.header && summary.header.competitions && summary.header.competitions[0];
  if (comp) for (const c of comp.competitors || []) if (c.team) haById[c.team.id] = c.homeAway;

  const out = { home: null, away: null };
  for (const rt of rosters) {
    const ha = rt.homeAway || (rt.team && haById[rt.team.id]) || null;
    const parsed = parseTeamRoster(rt);
    if (ha === 'home') out.home = parsed;
    else if (ha === 'away') out.away = parsed;
  }
  // Fallback when homeAway is missing: assume rosters are [home, away].
  if (!out.home && !out.away) { out.home = parseTeamRoster(rosters[0]); out.away = parseTeamRoster(rosters[1]); }
  if (!out.home || !out.away) return null;
  if (!out.home.starters.length || !out.away.starters.length) return null; // not published
  return out;
}

// The match summary carries the authoritative key events (the scoreboard's
// `details` is often empty). Parse summary.keyEvents → [{kind,minute,team,player}].
function parseSummaryEvents(summary) {
  const ke = (summary && summary.keyEvents) || (summary && summary.commentary) || [];
  if (!Array.isArray(ke) || !ke.length) return [];

  // team id → canonical name (from the header competitors).
  const nameById = {};
  const comp = summary.header && summary.header.competitions && summary.header.competitions[0];
  if (comp) for (const c of comp.competitors || []) {
    if (c.team) nameById[c.team.id] = resolveTeamName(c.team.displayName || c.team.name || c.team.shortDisplayName || '');
  }

  const out = [];
  for (const e of ke) {
    const kind = classifyEvent(e.type && (e.type.text || e.type.name));
    if (!kind) continue;
    const ath = (e.participants && e.participants[0] && e.participants[0].athlete)
      || (e.athletesInvolved && e.athletesInvolved[0]) || null;
    out.push({
      kind,
      minute: parseMinute((e.clock && (e.clock.displayValue || e.clock.value)) || e.time),
      team: (e.team && nameById[e.team.id]) || null,
      player: ath ? (ath.displayName || ath.shortName || null) : null,
    });
  }
  return out.sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999));
}

// ESPN play-by-play → [{ minute, text }] (most recent last). Keeps the latest 60.
function parseSummaryCommentary(summary) {
  const c = (summary && summary.commentary) || [];
  if (!Array.isArray(c) || !c.length) return [];
  const out = [];
  for (const x of c) {
    const text = x.text || (x.play && x.play.text) || null;
    if (!text) continue;
    out.push({
      minute: parseMinute((x.time && (x.time.displayValue || x.time.value)) || (x.clock && x.clock.displayValue)),
      text: String(text).slice(0, 240),
    });
  }
  return out.slice(-60);
}

async function fetchSummary(espnId) {
  const res = await fetch(`${ESPN_BASE}/${leagueCode()}/summary?event=${encodeURIComponent(espnId)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`espn summary ${res.status}`);
  return res.json();
}

// Pull lineups for matches near kickoff / live that have an ESPN id. Refreshes
// during the game (subs) but skips long-finished games. Returns { updated }.
async function overlayLineups() {
  if (!enabled()) return { updated: 0, skipped: true };

  const { rows } = await db.query(
    `SELECT id, espn_id, status FROM matches
      WHERE espn_id IS NOT NULL
        AND utc_date BETWEEN NOW() - INTERVAL '3 hours' AND NOW() + INTERVAL '2 hours'
        AND (lineups IS NULL OR status IN ('IN_PLAY','PAUSED'))
      ORDER BY utc_date
      LIMIT 8`
  );
  if (!rows.length) return { updated: 0 };

  let updated = 0;
  let events = 0;
  for (const m of rows) {
    try {
      const summary = await fetchSummary(m.espn_id);
      const lineups = parseLineups(summary);
      if (lineups) {
        await db.query('UPDATE matches SET lineups = $2::jsonb WHERE id = $1 AND manual_score = FALSE',
          [m.id, JSON.stringify(lineups)]);
        updated += 1;
      }
      // Key events from the summary (authoritative). Set just the `events` key so
      // the scoreboard overlay's `pens` is preserved.
      const evs = parseSummaryEvents(summary);
      if (evs.length) {
        await db.query(
          `UPDATE matches SET live_events =
             jsonb_set(coalesce(live_events, '{"pens":null}'::jsonb), '{events}', $2::jsonb, true)
           WHERE id = $1 AND manual_score = FALSE`,
          [m.id, JSON.stringify(evs)]
        );
        events += evs.length;
      }
      // Play-by-play commentary (what's happening, minute by minute).
      const comm = parseSummaryCommentary(summary);
      if (comm.length) {
        await db.query('UPDATE matches SET commentary = $2::jsonb WHERE id = $1 AND manual_score = FALSE',
          [m.id, JSON.stringify(comm)]);
      }
    } catch (e) {
      console.warn('[espn] summary failed:', m.espn_id, e.message);
    }
  }
  return { updated, events };
}

module.exports = { overlayLineups, parseLineups, parseTeamRoster, parseSummaryEvents, parseSummaryCommentary, fetchSummary };
