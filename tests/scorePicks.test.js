const { scorePick, totalForPlayer, outcome, isCountable } = require('../src/services/scorePicks');

describe('scorePick (exact 3 / result 1)', () => {
  test('exact score → 3', () => {
    expect(scorePick({ home: 2, away: 1 }, { home: 2, away: 1 })).toBe(3);
    expect(scorePick({ home: 1, away: 1 }, { home: 1, away: 1 })).toBe(3);
  });
  test('correct winner, wrong score → 1', () => {
    expect(scorePick({ home: 1, away: 0 }, { home: 2, away: 1 })).toBe(1); // home win
    expect(scorePick({ home: 0, away: 3 }, { home: 1, away: 2 })).toBe(1); // away win
  });
  test('correct draw, wrong score → 1', () => {
    expect(scorePick({ home: 2, away: 2 }, { home: 1, away: 1 })).toBe(1);
  });
  test('wrong outcome → 0', () => {
    expect(scorePick({ home: 0, away: 1 }, { home: 2, away: 1 })).toBe(0);
    expect(scorePick({ home: 1, away: 1 }, { home: 2, away: 1 })).toBe(0); // draw vs home win
  });
  test('missing data → 0', () => {
    expect(scorePick(null, { home: 1, away: 0 })).toBe(0);
    expect(scorePick({ home: 1, away: 0 }, { home: null, away: null })).toBe(0);
  });
});

describe('outcome', () => {
  test('classifies', () => {
    expect(outcome(2, 1)).toBe('H');
    expect(outcome(0, 2)).toBe('A');
    expect(outcome(1, 1)).toBe('D');
  });
});

describe('totalForPlayer', () => {
  const matchesById = {
    1: { home_score: 2, away_score: 1, status: 'FINISHED' }, // home win
    2: { home_score: 1, away_score: 1, status: 'FINISHED' }, // draw
    3: { home_score: null, away_score: null, status: 'TIMED' }, // not played
  };
  test('aggregates exact + result, ignores unplayed', () => {
    const picks = [
      { match_id: 1, pred_home: 2, pred_away: 1 }, // exact → 3
      { match_id: 2, pred_home: 2, pred_away: 2 }, // draw result → 1
      { match_id: 3, pred_home: 0, pred_away: 0 }, // not played → 0
    ];
    const s = totalForPlayer(picks, matchesById);
    expect(s).toEqual({ total: 4, exact: 1, resultOnly: 1 });
  });

  test('counts a played game even if its status lags (score present)', () => {
    // Two simultaneous games: one is IN_PLAY, the other still shows TIMED/LIVE
    // but already has a score → BOTH must count.
    const mbid = {
      10: { home_score: 1, away_score: 0, status: 'IN_PLAY' },
      11: { home_score: 2, away_score: 2, status: 'TIMED' }, // status lagging
      12: { home_score: 0, away_score: 1, status: 'LIVE' },
    };
    const picks = [
      { match_id: 10, pred_home: 1, pred_away: 0 }, // exact → 3
      { match_id: 11, pred_home: 3, pred_away: 3 }, // draw result → 1
      { match_id: 12, pred_home: 0, pred_away: 1 }, // exact → 3
    ];
    expect(totalForPlayer(picks, mbid)).toEqual({ total: 7, exact: 2, resultOnly: 1 });
  });
});

describe('isCountable', () => {
  test('counts any game with a scoreline, ignores void/unplayed', () => {
    expect(isCountable({ home_score: 1, away_score: 0, status: 'IN_PLAY' })).toBe(true);
    expect(isCountable({ home_score: 2, away_score: 2, status: 'TIMED' })).toBe(true); // status lagging
    expect(isCountable({ home_score: null, away_score: null, status: 'TIMED' })).toBe(false); // not played
    expect(isCountable({ home_score: 0, away_score: 0, status: 'CANCELLED' })).toBe(false); // void
    expect(isCountable(null)).toBe(false);
  });
});
