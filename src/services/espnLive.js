// ESPN live-score overlay.
//
// football-data's free tier delivers fixtures + (delayed) final results, but NOT
// in-play updates. ESPN's public scoreboard JSON is keyless and real-time, so we
// overlay it on top: every scheduler tick we fetch today's World Cup scoreboard
// and update score/status/minute for matches that are live there. The base
// fixtures/results still come from football-data; ESPN only adds the live beat.
//
//   - No API key, no quota; failures are silently skipped (next tick retries).
//   - Matches are paired by normalized team names (teamAliases handles "United
//     States" → "USA", "Czech Republic" → "Czechia", …).
//   - Admin manual scores (manual_score) are never overwritten.
//   - Disable with LIVE_ESPN=0; league overridable via ESPN_LEAGUE.
const db = require('../db/pool');
const { resolveTeamName, normalize } = require('./teamAliases');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

function leagueCode() {
  return process.env.ESPN_LEAGUE || 'fifa.world';
}

function enabled() {
  return process.env.LIVE_ESPN !== '0';
}

// ESPN status.type → football-data style status.
function mapStatus(type) {
  const name = (type && type.name) || '';
  const state = (type && type.state) || '';
  if (name === 'STATUS_HALFTIME') return 'PAUSED';
  if (state === 'in') return 'IN_PLAY';
  if (state === 'post') return 'FINISHED';
  return null; // 'pre' and anything unknown: nothing to overlay
}

// "62'" / "45'+2" → 62 / 45 (best-effort).
function parseMinute(clock) {
  const m = /(\d+)/.exec(String(clock || ''));
  return m ? Number(m[1]) : null;
}

// Classify an ESPN detail/event type → our compact kind.
function classifyEvent(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('own goal')) return 'own-goal';
  if (t.includes('penalty') && (t.includes('miss') || t.includes('saved'))) return 'pen-miss';
  if (t.includes('goal') || (t.includes('penalty') && t.includes('scored'))) return 'goal';
  if (t.includes('red')) return 'red';
  if (t.includes('yellow')) return 'yellow';
  return null; // ignore subs/VAR/other noise
}

// Parse comp.details (goals, cards, penalties) → a tidy events array.
function parseDetails(comp, teamById) {
  const out = [];
  for (const d of comp.details || []) {
    const kind = classifyEvent(d.type && (d.type.text || d.type.name));
    if (!kind) continue;
    const ath = (d.athletesInvolved && d.athletesInvolved[0]) || null;
    out.push({
      kind,
      minute: parseMinute(d.clock && d.clock.displayValue),
      team: (d.team && teamById[d.team.id]) || null,
      player: ath ? (ath.displayName || ath.shortName || null) : null,
    });
  }
  return out.sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999));
}

// Penalty-shootout result, when present. ESPN puts shootoutScore on competitors.
function parsePens(homeC, awayC, nameOf) {
  const hs = homeC.shootoutScore;
  const as = awayC.shootoutScore;
  if (hs == null || as == null) return null;
  const home = Number(hs);
  const away = Number(as);
  if (!Number.isFinite(home) || !Number.isFinite(away) || (home === 0 && away === 0)) return null;
  return { home, away, winner: home > away ? nameOf(homeC) : nameOf(awayC) };
}

// One ESPN scoreboard event → normalized match state + key events, or null.
function mapEspnEvent(ev) {
  const comp = ev && ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const competitors = comp.competitors || [];
  const homeC = competitors.find((c) => c.homeAway === 'home');
  const awayC = competitors.find((c) => c.homeAway === 'away');
  if (!homeC || !awayC) return null;
  // status may be null for pre-game events — we still return them so the overlay
  // can capture the ESPN id (needed to fetch lineups BEFORE kickoff).
  const status = mapStatus((ev.status && ev.status.type) || (comp.status && comp.status.type));
  const teamName = (c) => resolveTeamName(
    (c.team && (c.team.displayName || c.team.name || c.team.shortDisplayName)) || ''
  );
  const score = (c) => (c.score === undefined || c.score === null || c.score === '' ? null : Number(c.score));
  const teamById = {};
  if (homeC.team) teamById[homeC.team.id] = teamName(homeC);
  if (awayC.team) teamById[awayC.team.id] = teamName(awayC);
  return {
    espnId: ev.id != null ? String(ev.id) : null,
    home: teamName(homeC),
    away: teamName(awayC),
    homeScore: score(homeC),
    awayScore: score(awayC),
    status,
    minute: status === 'FINISHED' ? null : parseMinute(ev.status && ev.status.displayClock),
    liveEvents: { events: parseDetails(comp, teamById), pens: parsePens(homeC, awayC, teamName) },
  };
}

async function fetchScoreboard() {
  const res = await fetch(`${ESPN_BASE}/${leagueCode()}/scoreboard`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`espn ${res.status}`);
  const data = await res.json();
  return (data.events || []).map(mapEspnEvent).filter(Boolean);
}

// Overlay today's live ESPN data onto the matches table. Returns { updated }.
async function overlayEspnLive() {
  if (!enabled()) return { updated: 0, skipped: true };

  let events;
  try {
    events = await fetchScoreboard();
  } catch (e) {
    // ESPN being down must never break the loop — the FD sync still runs.
    console.warn('[espn] scoreboard fetch failed:', e.message);
    return { updated: 0, error: e.message };
  }
  if (!events.length) return { updated: 0 };

  // Candidate matches: around now (covers late kickoffs + just-finished games).
  const { rows } = await db.query(
    `SELECT id, home_team, away_team, status, home_score, away_score, manual_score, espn_id
       FROM matches
      WHERE utc_date BETWEEN NOW() - INTERVAL '12 hours' AND NOW() + INTERVAL '12 hours'`
  );
  const byPair = new Map();
  for (const m of rows) {
    byPair.set(`${normalize(m.home_team)}|${normalize(m.away_team)}`, m);
  }

  let updated = 0;
  let matched = 0;
  const unmatched = [];
  for (const ev of events) {
    const m = byPair.get(`${normalize(ev.home)}|${normalize(ev.away)}`);
    if (!m) {
      // ESPN reported a fixture we couldn't pair to any DB row by team name.
      // Most common cause: the team name from ESPN isn't in teamAliases.js, so
      // its score never reaches the DB and the match never counts on the
      // leaderboard. Surface it so we can fix the alias before the next match.
      unmatched.push({ home: ev.home, away: ev.away, espnId: ev.espnId, status: ev.status });
      continue;
    }
    if (m.manual_score) continue;
    matched += 1;

    // Always remember the ESPN id (even for not-yet-started games) so lineups
    // can be fetched BEFORE kickoff.
    if (ev.espnId && m.espn_id !== ev.espnId) {
      await db.query('UPDATE matches SET espn_id = $2 WHERE id = $1 AND manual_score = FALSE', [m.id, ev.espnId]);
    }
    // Pre-game (no live status yet) → nothing else to update.
    if (!ev.status) continue;
    // A FINISHED row is normally final — but if ESPN is actively reporting the
    // game as LIVE again (e.g. it was force-settled during a long stoppage),
    // trust the live source and bring it back.
    const espnLive = ev.status === 'IN_PLAY' || ev.status === 'PAUSED';
    if (m.status === 'FINISHED' && !espnLive) continue;

    const changed = m.status !== ev.status
      || (m.home_score ?? null) !== (ev.homeScore ?? null)
      || (m.away_score ?? null) !== (ev.awayScore ?? null);
    const winner = ev.status === 'FINISHED' && ev.homeScore != null && ev.awayScore != null
      ? (ev.homeScore > ev.awayScore ? 'HOME_TEAM' : ev.homeScore < ev.awayScore ? 'AWAY_TEAM' : 'DRAW')
      : null;

    // Refresh score/status/minute + the ESPN id. live_events is only written
    // when the scoreboard actually carried events/pens — so it never clobbers
    // the richer events the summary overlay stores (COALESCE keeps existing).
    const le = ev.liveEvents && ((ev.liveEvents.events && ev.liveEvents.events.length) || ev.liveEvents.pens)
      ? JSON.stringify(ev.liveEvents) : null;
    await db.query(
      `UPDATE matches
          SET status = $2, home_score = $3, away_score = $4,
              winner = COALESCE($5, winner),
              live_events = COALESCE($7::jsonb, live_events),
              espn_id = COALESCE($8, espn_id),
              raw = jsonb_set(coalesce(raw, '{}'::jsonb), '{minute}', coalesce(to_jsonb($6::int), 'null'::jsonb), true),
              last_updated = NOW(), synced_at = NOW()
        WHERE id = $1 AND manual_score = FALSE`,
      [m.id, ev.status, ev.homeScore, ev.awayScore, winner, ev.minute, le, ev.espnId]
    );
    if (changed) updated += 1;
  }

  // Persist the latest unmatched list (best-effort; never throws). /api/sync-status
  // surfaces this so it's obvious WHICH ESPN team name is missing from teamAliases.
  if (unmatched.length) {
    console.warn('[espn] unmatched fixtures (alias gap):', unmatched);
    try {
      await db.query(
        `INSERT INTO sync_state (key, value, updated_at)
         VALUES ('last_unmatched_espn', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify({ at: Date.now(), count: unmatched.length, fixtures: unmatched })]
      );
    } catch (e) {
      console.warn('[espn] persist unmatched failed:', e.message);
    }
  }
  // matched = how many of ESPN's games we paired to our fixtures (coverage check).
  return { updated, events: events.length, matched, unmatched: unmatched.length };
}

module.exports = { overlayEspnLive, mapEspnEvent, mapStatus, parseMinute, classifyEvent, fetchScoreboard };
