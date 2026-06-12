// Web-push notifications.
//
// Configured from env (set these on Railway):
//   VAPID_PUBLIC_KEY  — also exposed to the frontend (VITE_VAPID_PUBLIC_KEY)
//   VAPID_PRIVATE_KEY — secret, backend only
//   VAPID_SUBJECT     — a mailto: or https: contact (optional, defaults below)
//
// If the keys aren't set, push is a no-op (the app still works; nothing sends).
//
// Players get a notification at each beat of a match they picked — kickoff,
// every goal, half-time and full-time — always with their points status (the
// points that pick is worth on the current score, plus their confirmed total).
const webpush = require('web-push');
const db = require('../db/pool');
const { scorePick } = require('./scorePicks');

const PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@usam-world-cup.app';
const enabled = Boolean(PUBLIC && PRIVATE);

if (enabled) {
  try { webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE); }
  catch (e) { console.warn('[push] invalid VAPID config:', e.message); }
}

const LIVE_STATUS = new Set(['IN_PLAY', 'PAUSED', 'LIVE']);

function isEnabled() { return enabled; }
function publicKey() { return PUBLIC; }

// "+3 pts" / "no points" in the right language.
function ptsLabel(lang, pts) {
  if (pts > 0) return `+${pts} pt${pts > 1 ? 's' : ''}`;
  return lang === 'es' ? 'sin puntos' : 'no points';
}

// Localized notification text for a match beat. `event` is one of
// 'kickoff' | 'goal' | 'half' | 'full'; `f` carries the facts:
// { home, away, homeScore, awayScore, predHome, predAway, pts, total }.
function matchEventMessage(lang, event, f) {
  const score = `${f.home} ${f.homeScore}–${f.awayScore} ${f.away}`;
  const matchup = `${f.home} vs ${f.away}`;
  const pick = `${f.predHome}–${f.predAway}`;
  const pl = ptsLabel(lang, f.pts);
  const es = lang === 'es';

  switch (event) {
    case 'kickoff':
      return es
        ? { title: `🟢 Comienza: ${matchup}`, body: `Tu pronóstico: ${pick}. Tu total hasta ahora: ${f.total} pts.`, url: '/' }
        : { title: `🟢 Kickoff: ${matchup}`, body: `Your pick: ${pick}. Your total so far: ${f.total} pts.`, url: '/' };
    case 'goal':
      return es
        ? { title: `⚽ ¡GOL! ${score}`, body: `Tu pronóstico ${pick} → ${pl} si termina así. Total: ${f.total} pts.`, url: '/' }
        : { title: `⚽ GOAL! ${score}`, body: `Your pick ${pick} → ${pl} if it ends now. Total: ${f.total} pts.`, url: '/' };
    case 'half':
      return es
        ? { title: `⏸️ Medio tiempo: ${score}`, body: `Tu pronóstico ${pick} → ${pl} por ahora. Total: ${f.total} pts.`, url: '/' }
        : { title: `⏸️ Half-time: ${score}`, body: `Your pick ${pick} → ${pl} so far. Total: ${f.total} pts.`, url: '/' };
    case 'full':
    default:
      return es
        ? { title: `Final: ${score}`, body: `Tu pronóstico ${pick} → ${pl}. Total: ${f.total} pts.`, url: '/' }
        : { title: `FT: ${score}`, body: `Your pick ${pick} → ${pl}. Total: ${f.total} pts.`, url: '/' };
  }
}

// Back-compat shim (a finished match is the 'full' event).
function matchResultMessage(lang, f) { return matchEventMessage(lang, 'full', f); }

// Send a match-beat notification to every subscription a player has, each in the
// language that subscription was registered with. Dead endpoints (410/404) are
// pruned. Returns the number of successful sends.
async function sendPlayerEvent(playerId, event, facts) {
  if (!enabled) return 0;
  const { rows } = await db.query(
    'SELECT endpoint, p256dh, auth, lang FROM push_subscriptions WHERE player_id = $1',
    [playerId]
  );
  let sent = 0;
  for (const s of rows) {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    const body = JSON.stringify(matchEventMessage(s.lang || 'en', event, facts));
    try {
      await webpush.sendNotification(sub, body);
      sent += 1;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]).catch(() => {});
      } else {
        console.warn('[push] send failed:', e.statusCode || e.message);
      }
    }
  }
  return sent;
}

// Confirmed points per player, from FINISHED matches only (the "Total" line).
async function confirmedTotals() {
  const { rows: finished } = await db.query(
    `SELECT id, home_score, away_score FROM matches
      WHERE status = 'FINISHED' AND home_score IS NOT NULL AND away_score IS NOT NULL`
  );
  const fmap = Object.fromEntries(finished.map((m) => [String(m.id), m]));
  const { rows: picks } = await db.query(
    'SELECT player_id, match_id, pred_home, pred_away FROM score_picks'
  );
  const totals = {};
  for (const pk of picks) {
    const fm = fmap[String(pk.match_id)];
    if (!fm) continue;
    totals[pk.player_id] = (totals[pk.player_id] || 0)
      + scorePick({ home: pk.pred_home, away: pk.pred_away }, { home: fm.home_score, away: fm.away_score });
  }
  return totals;
}

// Notify everyone who picked match `m` about `event`, with their points status.
async function notifyPickers(m, event, totals) {
  const { rows: picks } = await db.query(
    'SELECT player_id, pred_home, pred_away FROM score_picks WHERE match_id = $1',
    [m.id]
  );
  const hs = m.home_score;
  const as = m.away_score;
  let sent = 0;
  for (const pk of picks) {
    const pts = (hs != null && as != null)
      ? scorePick({ home: pk.pred_home, away: pk.pred_away }, { home: hs, away: as })
      : 0;
    await sendPlayerEvent(pk.player_id, event, {
      home: m.home_team, away: m.away_team,
      homeScore: hs == null ? 0 : hs, awayScore: as == null ? 0 : as,
      predHome: pk.pred_home, predAway: pk.pred_away,
      pts, total: totals[pk.player_id] || 0,
    });
    sent += 1;
  }
  return sent;
}

// Run after each score sync. Detects, per live/finished match, which beats have
// happened since we last looked and fires one notification per beat per picker.
//
// First time we ever see a match we only RECORD its state (no sends), so a fresh
// deploy never back-blasts notifications for matches already played or in
// progress — we only announce transitions we actually witness.
async function notifyMatchEvents() {
  if (!enabled) return { events: 0 };

  const { rows: matches } = await db.query(
    `SELECT id, home_team, away_team, home_score, away_score, status
       FROM matches
      WHERE status IN ('IN_PLAY', 'PAUSED', 'LIVE', 'FINISHED')`
  );
  if (!matches.length) return { events: 0 };

  const { rows: progRows } = await db.query('SELECT * FROM match_progress');
  const prog = Object.fromEntries(progRows.map((p) => [String(p.match_id), p]));

  const totals = await confirmedTotals();
  let events = 0;

  for (const m of matches) {
    const id = String(m.id);
    const p = prog[id];
    const hs = m.home_score;
    const as = m.away_score;
    const live = LIVE_STATUS.has(m.status);
    const finished = m.status === 'FINISHED';

    if (!p) {
      // First sighting — seed state silently, marking as "already announced" any
      // beat that's clearly in the past so we never notify retroactively.
      await db.query(
        `INSERT INTO match_progress
           (match_id, status, home_score, away_score, kickoff_sent, half_sent, full_sent)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (match_id) DO NOTHING`,
        [m.id, m.status, hs, as, live || finished, m.status === 'PAUSED' || finished, finished]
      );
      continue;
    }

    const toSend = [];
    if (!p.kickoff_sent && (live || finished)) toSend.push('kickoff');
    // Goal: a known score that went up since last sync, while still in play.
    if (!finished && hs != null && as != null && p.home_score != null && p.away_score != null
        && (hs > p.home_score || as > p.away_score)) {
      toSend.push('goal');
    }
    if (!p.half_sent && m.status === 'PAUSED') toSend.push('half');
    if (!p.full_sent && finished) toSend.push('full');

    for (const ev of toSend) {
      events += await notifyPickers(m, ev, totals);
    }

    await db.query(
      `UPDATE match_progress
          SET status = $2, home_score = $3, away_score = $4,
              kickoff_sent = kickoff_sent OR $5,
              half_sent    = half_sent OR $6,
              full_sent    = full_sent OR $7,
              updated_at   = NOW()
        WHERE match_id = $1`,
      [m.id, m.status, hs, as,
        toSend.includes('kickoff'), toSend.includes('half'), toSend.includes('full')]
    );
  }

  return { events };
}

module.exports = {
  isEnabled, publicKey,
  matchEventMessage, matchResultMessage,
  sendPlayerEvent, notifyMatchEvents,
};
