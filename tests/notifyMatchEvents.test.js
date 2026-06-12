// Exercises the transition logic of notifyMatchEvents with a faked db + web-push.
// Push is enabled by setting VAPID env before requiring the module.
process.env.VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY
  || 'BLcOGDtRJTAz4KA8-qwdCirE7jFnk6kjA4KrbliGIqPFtf6VRsEK2OolVaul2CEENNLgCFp3i2yNbvG806R4a1g';
process.env.VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY
  || 'CwmNH4EUoZjSlK7JM83IOcSqYfUKgS31bHVj6qphSeI';

jest.mock('../src/db/pool');
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn().mockResolvedValue() }));

const db = require('../src/db/pool');
const webpush = require('web-push');
const { notifyMatchEvents } = require('../src/services/push');

// Minimal query router: matches on a substring of the SQL.
function makeDb({ matches, progress, picks, subs }) {
  const inserts = [];
  db.query.mockImplementation((sql, params) => {
    if (/FROM matches\s+WHERE status IN/.test(sql)) return { rows: matches };
    if (/FROM match_progress/.test(sql)) return { rows: progress };
    if (/FROM matches\s+WHERE status = 'FINISHED'/.test(sql)) {
      return { rows: matches.filter((m) => m.status === 'FINISHED') };
    }
    if (/SELECT player_id, match_id, pred_home/.test(sql)) return { rows: picks }; // confirmedTotals
    if (/SELECT player_id, pred_home, pred_away FROM score_picks WHERE match_id/.test(sql)) {
      return { rows: picks.filter((p) => String(p.match_id) === String(params[0])) };
    }
    if (/FROM push_subscriptions WHERE player_id/.test(sql)) {
      return { rows: subs.filter((s) => s.player_id === params[0]) };
    }
    if (/INSERT INTO match_progress/.test(sql)) { inserts.push({ sql, params }); return { rows: [] }; }
    if (/UPDATE match_progress/.test(sql)) { inserts.push({ sql, params }); return { rows: [] }; }
    return { rows: [] };
  });
  return { inserts };
}

beforeEach(() => { jest.clearAllMocks(); });

test('first sighting seeds state silently (no sends)', async () => {
  makeDb({
    matches: [{ id: 1, home_team: 'A', away_team: 'B', home_score: 1, away_score: 0, status: 'IN_PLAY' }],
    progress: [],
    picks: [{ player_id: 'p1', match_id: 1, pred_home: 1, pred_away: 0 }],
    subs: [{ player_id: 'p1', endpoint: 'e', p256dh: 'a', auth: 'b', lang: 'en' }],
  });
  const r = await notifyMatchEvents();
  expect(r.events).toBe(0);
  expect(webpush.sendNotification).not.toHaveBeenCalled();
});

test('a goal since last sync notifies the picker', async () => {
  makeDb({
    matches: [{ id: 1, home_team: 'A', away_team: 'B', home_score: 1, away_score: 0, status: 'IN_PLAY' }],
    progress: [{ match_id: 1, status: 'IN_PLAY', home_score: 0, away_score: 0, kickoff_sent: true, half_sent: false, full_sent: false }],
    picks: [{ player_id: 'p1', match_id: 1, pred_home: 1, pred_away: 0 }],
    subs: [{ player_id: 'p1', endpoint: 'e', p256dh: 'a', auth: 'b', lang: 'en' }],
  });
  const r = await notifyMatchEvents();
  expect(r.events).toBe(1);
  const body = JSON.parse(webpush.sendNotification.mock.calls[0][1]);
  expect(body.title).toContain('GOAL');
});

test('full-time fires once, not again after full_sent', async () => {
  const finished = { id: 1, home_team: 'A', away_team: 'B', home_score: 2, away_score: 1, status: 'FINISHED' };
  // first: was live, now finished → should send full
  makeDb({
    matches: [finished],
    progress: [{ match_id: 1, status: 'IN_PLAY', home_score: 2, away_score: 1, kickoff_sent: true, half_sent: true, full_sent: false }],
    picks: [{ player_id: 'p1', match_id: 1, pred_home: 2, pred_away: 1 }],
    subs: [{ player_id: 'p1', endpoint: 'e', p256dh: 'a', auth: 'b', lang: 'en' }],
  });
  let r = await notifyMatchEvents();
  expect(r.events).toBe(1);
  expect(JSON.parse(webpush.sendNotification.mock.calls[0][1]).title).toContain('FT:');

  // second: already full_sent → no send
  jest.clearAllMocks();
  makeDb({
    matches: [finished],
    progress: [{ match_id: 1, status: 'FINISHED', home_score: 2, away_score: 1, kickoff_sent: true, half_sent: true, full_sent: true }],
    picks: [{ player_id: 'p1', match_id: 1, pred_home: 2, pred_away: 1 }],
    subs: [{ player_id: 'p1', endpoint: 'e', p256dh: 'a', auth: 'b', lang: 'en' }],
  });
  r = await notifyMatchEvents();
  expect(r.events).toBe(0);
  expect(webpush.sendNotification).not.toHaveBeenCalled();
});
