const { syncMatches, syncSecondary, settleStaleMatches } = require('./services/syncMatches');
const { mirrorFromSource } = require('./services/mirrorSync');
const { overlayEspnLive } = require('./services/espnLive');
const { overlayLineups } = require('./services/espnLineups');
const { syncEspnSchedule } = require('./services/espnSchedule');
const { clearChatOnGameEnd } = require('./services/chatReset');
const { notifyMatchEvents } = require('./services/push');
const { backfillBracket } = require('./services/bracketBackfill');
const db = require('./db/pool');

// Standings + scorers change slowly and cost 2 extra API calls, so only refresh
// them at most this often (default 30 min).
const SECONDARY_MS = Number(process.env.SYNC_SECONDARY_MS || 30 * 60_000);
let lastSecondary = 0;

// Adaptive polling. We don't need to hit football-data every minute around the
// clock — only when something is actually happening. The cadence adapts to the
// fixtures already in the DB (no extra external calls to decide).
//
// IMPORTANT: the /competitions/WC/matches endpoint returns ALL matches in ONE
// call, so a single request already covers every simultaneous live game. That's
// why even a 15s live cadence costs only ~4 calls/min (limit is 10/min).
//
//   - LIVE  (a match IN_PLAY/PAUSED right now)           → every 7s   (catch goals fast)
//   - SOON  (a match kicks off within the next 15 min)   → every 20s
//   - GAMEDAY (a match earlier/later today, none live)    → every 5 min
//   - IDLE  (no matches today)                            → every 30 min
//
// Quiet days use a few calls/hour (vs ~1440 before); a full live minute uses ~9
// (guard 9, hard limit 10/min).
const LIVE_MS = Number(process.env.SYNC_LIVE_MS || 5_000);
const SOON_MS = Number(process.env.SYNC_SOON_MS || 15_000);
const GAMEDAY_MS = Number(process.env.SYNC_GAMEDAY_MS || 5 * 60_000);
const IDLE_MS = Number(process.env.SYNC_IDLE_MS || 30 * 60_000);
const SOON_WINDOW_MS = 15 * 60_000;

const LIVE_STATUS = new Set(['IN_PLAY', 'PAUSED', 'LIVE']);

// Persist the last sync outcome so /api/sync-status can show WHY scores aren't
// flowing (rate limit, bad key, network, etc.). Best-effort; never throws.
function recordSyncResult(err) {
  const value = err
    ? JSON.stringify({ at: Date.now(), code: err.code || null, message: String(err.message || err).slice(0, 300) })
    : null;
  db.query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('last_sync_error', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [value]
  ).catch(() => {});
}

// Persist the last ESPN overlay outcome so /api/sync-status can confirm the live
// feed is connected and how many of its games we matched to our fixtures.
function recordEspnResult(o) {
  db.query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('last_espn', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify({ at: Date.now(), ...o })]
  ).catch(() => {});
}

// "Quiet" = no match live or about to start, so it's safe to spend 2 extra API
// calls on standings + scorers. During live/kickoff-soon we only sync scores.
function isQuiet(reason) {
  return reason !== 'live' && reason !== 'kickoff-soon';
}

// Decide the next delay from what's in the DB. Returns { delay, reason }.
async function nextDelay() {
  try {
    const { rows } = await db.query(
      `SELECT status, utc_date FROM matches
         WHERE utc_date IS NOT NULL
           AND utc_date >= NOW() - INTERVAL '1 day'
           AND utc_date <= NOW() + INTERVAL '1 day'`
    );
    const now = Date.now();
    let soon = false;
    let gameday = false;
    for (const r of rows) {
      if (LIVE_STATUS.has(r.status)) return { delay: LIVE_MS, reason: 'live' };
      const t = new Date(r.utc_date).getTime();
      if (t > now && t - now <= SOON_WINDOW_MS) soon = true;
      // a match scheduled within today's window (±, but not live) → gameday
      if (Math.abs(t - now) <= 12 * 3600_000) gameday = true;
    }
    if (soon) return { delay: SOON_MS, reason: 'kickoff-soon' };
    if (gameday) return { delay: GAMEDAY_MS, reason: 'gameday' };
    return { delay: IDLE_MS, reason: 'idle' };
  } catch (e) {
    return { delay: GAMEDAY_MS, reason: 'fallback' };
  }
}

// Railway runs a single long-lived process. Self-rescheduling timer so the
// cadence can change between ticks.
//
// Two modes:
//   - MIRROR: if MIRROR_SOURCE_URL is set, copy matches+standings from another
//     pool's backend (no football-data quota used).
//   - API: otherwise poll football-data.org directly (needs FOOTBALL_DATA_API_KEY).
// No-op if neither is configured.
function startScheduler() {
  const mirrorUrl = process.env.MIRROR_SOURCE_URL;
  const mirror = Boolean(mirrorUrl);
  const espnEnabled = process.env.LIVE_ESPN !== '0';
  const fdEnabled = Boolean(process.env.FOOTBALL_DATA_API_KEY);

  // The família pool runs in "ESPN mode": ESPN seeds the fixtures AND owns the
  // live beat, so the loop must start even without football-data or a mirror.
  if (!mirror && !fdEnabled && !espnEnabled) {
    console.log('[scheduler] no MIRROR_SOURCE_URL, no FOOTBALL_DATA_API_KEY, ESPN disabled — polling disabled');
    return null;
  }

  let stopped = false;
  let handle = null;
  // With the ESPN overlay owning the live beat, football-data only needs to be
  // polled occasionally (fixtures + finals) — at most once per this interval,
  // even while the loop spins at LIVE_MS for ESPN.
  const FD_MIN_MS = Number(process.env.SYNC_FD_MIN_MS || 60_000);
  let lastFd = 0;
  // The match summary carries events + commentary (+ lineups), which update in
  // near-real-time, so pull it often during games. overlayLineups only hits ESPN
  // for matches in the kickoff window, so off-match days this is just idle.
  const LINEUPS_MS = Number(process.env.LINEUPS_MS || 15_000);
  let lastLineups = 0;
  // ESPN schedule seed — fetch the fixture list (keyless) on a slow cadence; the
  // first run happens right after boot (lastSchedule = 0).
  const SCHEDULE_MS = Number(process.env.ESPN_SCHEDULE_MS || 30 * 60_000);
  let lastSchedule = 0;

  const loop = async () => {
    if (stopped) return;

    // 1) Refresh match data — mirror from the source pool, or sync from the API
    //    (throttled: ESPN covers the fast live updates).
    try {
      if (mirror) {
        const r = await mirrorFromSource(mirrorUrl);
        console.log('[scheduler] mirror', r);
        recordSyncResult(null);
      } else if (fdEnabled && Date.now() - lastFd >= FD_MIN_MS) {
        lastFd = Date.now();
        const r = await syncMatches('scheduler');
        console.log('[scheduler] sync', r);
        recordSyncResult(null); // clear any stale error
      }
    } catch (e) {
      if (e.code === 'RATE_LIMITED') console.warn('[scheduler] rate limited, backing off');
      else console.error(`[scheduler] ${mirror ? 'mirror' : 'sync'} failed:`, e.message);
      recordSyncResult(e); // surface it on /api/sync-status
    }

    // 1a) ESPN schedule seed — ONLY when football-data isn't the source. ESPN is
    //     the keyless fallback that seeds fixtures; when a football-data key is
    //     present, FD owns the fixtures and ESPN stays the live/lineup overlay.
    if (!mirror && espnEnabled && !fdEnabled && Date.now() - lastSchedule >= SCHEDULE_MS) {
      lastSchedule = Date.now();
      try {
        const sc = await syncEspnSchedule('scheduler');
        if (sc.count) console.log('[scheduler] espn-schedule', sc);
      } catch (e) {
        console.warn('[scheduler] espn-schedule failed:', e.message);
      }
    }

    // 1b) ESPN live overlay (keyless, real-time). football-data's free tier
    //     doesn't push in-play updates, so ESPN owns the live beat. Runs even
    //     when FD is rate-limited; skipped in mirror mode (the source pool's
    //     overlay flows through the mirror).
    if (!mirror) {
      try {
        const o = await overlayEspnLive();
        if (o.updated) console.log('[scheduler] espn', o);
        recordEspnResult(o);
      } catch (e) {
        console.warn('[scheduler] espn failed:', e.message);
        recordEspnResult({ error: e.message });
      }
    }

    // 1b2) Lineups (escalações) from ESPN's per-match summary — slow cadence.
    if (!mirror && Date.now() - lastLineups >= LINEUPS_MS) {
      lastLineups = Date.now();
      try {
        const l = await overlayLineups();
        if (l.updated) console.log('[scheduler] lineups', l);
      } catch (e) {
        console.warn('[scheduler] lineups failed:', e.message);
      }
    }

    // 1c) Self-heal: settle any scored match that's clearly over (3h+ since
    //     kickoff) so it can never drop off the leaderboard.
    try {
      const s = await settleStaleMatches();
      if (s.settled) console.log('[scheduler] settle', s);
    } catch (e) {
      console.warn('[scheduler] settle failed:', e.message);
    }

    // 1c2) Bracket backfill: when football-data lags propagating knockout
    //      teams (it often takes hours/days after each round), copy them from
    //      ESPN's scoreboard as a best-effort fill so players can keep picking.
    //      manual_teams pins are honoured. Disabled by ESPN_BRACKET_BACKFILL=0.
    if (!mirror) {
      try {
        const b = await backfillBracket();
        if (b.filled) console.log('[scheduler] bracket-backfill', b);
      } catch (e) {
        console.warn('[scheduler] bracket-backfill failed:', e.message);
      }
    }

    // 1d) After scores update, fire match-beat alerts (kickoff/goal/half/full).
    try {
      const n = await notifyMatchEvents();
      if (n.events) console.log('[scheduler] push', n);
    } catch (e) {
      console.warn('[scheduler] push failed:', e.message);
    }

    // 1e) Per-game chat: wipe messages once the live game(s) have ended.
    try {
      const c = await clearChatOnGameEnd();
      if (c.cleared) console.log('[scheduler] chat cleared (game ended)', c);
    } catch (e) {
      console.warn('[scheduler] chat reset failed:', e.message);
    }

    // 2) Decide cadence from the freshly-synced statuses.
    const { delay, reason } = await nextDelay();

    // 3) Standings + scorers (2 extra API calls) ONLY in API mode, when nothing
    //    is live/about to kick off, at most every SECONDARY_MS. In mirror mode
    //    standings come bundled with the mirrored matches, so this is skipped.
    if (!mirror && isQuiet(reason) && Date.now() - lastSecondary >= SECONDARY_MS) {
      lastSecondary = Date.now();
      try {
        const s = await syncSecondary('scheduler');
        console.log('[scheduler] secondary', s);
      } catch (e) {
        if (e.code !== 'RATE_LIMITED') console.warn('[scheduler] secondary failed:', e.message);
      }
    }

    console.log(`[scheduler] next ${mirror ? 'mirror' : 'sync'} in ${Math.round(delay / 1000)}s (${reason})`);
    handle = setTimeout(loop, delay);
    if (handle.unref) handle.unref();
  };

  // First sync shortly after boot (gives the DB pool a moment).
  handle = setTimeout(loop, 2000);
  if (handle.unref) handle.unref();
  const modeLabel = mirror ? 'mirror' : fdEnabled ? 'api+espn' : 'espn';
  console.log(`[scheduler] adaptive polling started (${modeLabel} mode)`);

  return {
    stop() { stopped = true; if (handle) clearTimeout(handle); },
  };
}

module.exports = { startScheduler, nextDelay, isQuiet };
