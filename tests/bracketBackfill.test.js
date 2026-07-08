jest.mock('../src/db/pool');

const db = require('../src/db/pool');
const {
  backfillBracket, isPlaceholderName, mapEvent, expandDatesByOne,
} = require('../src/services/bracketBackfill');

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { delete global.fetch; });

describe('isPlaceholderName', () => {
  test.each([
    ['Round of 32 1 Winner', true],
    ['T1 Winner', true],
    ['Winner Group A', true],
    ['Loser of Match 5', true],
    ['TBD', true],
    ['?', true],
    ['', true],
    [null, true],
    [undefined, true],
    ['Brazil', false],
    ['South Korea', false],
    ['Côte d\'Ivoire', false],
    ['Cape Verde', false],
    ['DR Congo', false],
  ])('isPlaceholderName(%j) → %s', (input, expected) => {
    expect(isPlaceholderName(input)).toBe(expected);
  });
});

describe('mapEvent', () => {
  test('extracts home + away + utc_date', () => {
    const ev = {
      date: '2026-06-29T20:30Z',
      competitions: [{ competitors: [
        { homeAway: 'home', team: { displayName: 'Germany' } },
        { homeAway: 'away', team: { displayName: 'Paraguay' } },
      ] }],
    };
    expect(mapEvent(ev)).toEqual({ utc_date: '2026-06-29T20:30Z', home: 'Germany', away: 'Paraguay' });
  });

  test('returns null when competitors are missing a side', () => {
    expect(mapEvent({ competitions: [{ competitors: [{ homeAway: 'home', team: { name: 'Brazil' } }] }] })).toBe(null);
  });

  test('returns null on malformed events', () => {
    expect(mapEvent(null)).toBe(null);
    expect(mapEvent({})).toBe(null);
    expect(mapEvent({ competitions: [] })).toBe(null);
  });
});

describe('backfillBracket', () => {
  function missingRow(over = {}) {
    return {
      id: 537415,
      utc_date: '2026-06-29T20:30:00.000Z',
      stage: 'LAST_32',
      home_team: 'Germany',
      away_team: null,
      ...over,
    };
  }

  function espnEvent(home, away, utc = '2026-06-29T20:30Z') {
    return {
      date: utc,
      competitions: [{ competitors: [
        { homeAway: 'home', team: { displayName: home } },
        { homeAway: 'away', team: { displayName: away } },
      ] }],
    };
  }

  test('fills only the null side from a real ESPN event', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [missingRow()] })  // findMissingFixtures
      .mockResolvedValue({ rows: [] });                  // UPDATE + sync_state
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [espnEvent('Germany', 'Paraguay')] }),
    });

    const r = await backfillBracket();
    // dates=3 because we now query D-1/D/D+1 for each base date; the event only
    // exists once in the merged index, so filled/scanned still line up.
    expect(r).toMatchObject({ missing: 1, filled: 1, dates: 3 });

    const upd = db.query.mock.calls.find((c) => /UPDATE matches/.test(c[0]));
    expect(upd[0]).toMatch(/manual_teams = FALSE/);
    // params: [id, newHome, newAway] — home stays null (we didn't need to update it)
    expect(upd[1]).toEqual([537415, null, 'Paraguay']);
  });

  test('skips ESPN events whose team is a placeholder (e.g. "Round of 32 1 Winner")', async () => {
    db.query.mockResolvedValueOnce({
      rows: [missingRow({ id: 537376, utc_date: '2026-07-04T17:00:00.000Z', home_team: null, away_team: null, stage: 'LAST_16' })],
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [espnEvent('Round of 32 1 Winner', 'Round of 32 3 Winner', '2026-07-04T17:00Z')] }),
    });

    const r = await backfillBracket();
    expect(r).toMatchObject({ missing: 1, filled: 0 });
    expect(db.query.mock.calls.find((c) => /UPDATE matches/.test(c[0]))).toBeUndefined();
  });

  test('respects manual_teams = TRUE (filtered out at the SELECT)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    global.fetch = jest.fn();
    const r = await backfillBracket();
    expect(r).toMatchObject({ missing: 0, filled: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('continues to other dates when ESPN errors on one', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        missingRow({ id: 1, utc_date: '2026-07-01T20:00:00.000Z' }),
        missingRow({ id: 2, utc_date: '2026-07-02T19:00:00.000Z' }),
      ] })
      .mockResolvedValue({ rows: [] });
    // With the D±1 widened window we can query up to 4 unique days
    // (20260630, 20260701, 20260702, 20260703). Match by url so ordering
    // doesn't matter.
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('20260701')) return Promise.reject(new Error('espn 503'));
      if (url.includes('20260702')) return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ events: [espnEvent('Spain', 'Austria', '2026-07-02T19:00Z')] }),
      });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ events: [] }) });
    });

    const r = await backfillBracket();
    // 20260630, 20260701, 20260702, 20260703 = 4 days scanned.
    expect(r.dates).toBe(4);
    // The 20260701 fetch throws but the loop continues; 20260702 fills id=2.
    // id=1 (kickoff 2026-07-01T20:00Z) has no ESPN event in any of the mocked
    // days, so it stays null.
    expect(r.filled).toBe(1);
  });

  test('honours ESPN_BRACKET_BACKFILL=0', async () => {
    const prev = process.env.ESPN_BRACKET_BACKFILL;
    process.env.ESPN_BRACKET_BACKFILL = '0';
    try {
      const r = await backfillBracket();
      expect(r).toEqual({ skipped: true });
      expect(db.query).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ESPN_BRACKET_BACKFILL;
      else process.env.ESPN_BRACKET_BACKFILL = prev;
    }
  });

  test('writes last_bracket_backfill summary to sync_state', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [missingRow()] })
      .mockResolvedValue({ rows: [] });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [espnEvent('Germany', 'Paraguay')] }),
    });
    await backfillBracket();
    const ins = db.query.mock.calls.find((c) => /last_bracket_backfill/.test(c[0]));
    expect(ins).toBeTruthy();
    const payload = JSON.parse(ins[1][0]);
    expect(payload).toMatchObject({ missing: 1, filled: 1, dates: 3 });
  });

  // Regression: QF #4 kickoff 2026-07-12T01:00Z was showing "? vs ?" in the
  // pool because bracketBackfill only queried ESPN's 20260712 scoreboard,
  // which is empty — ESPN indexes that game under 20260711 (US-local
  // tournament day). Now that we widen to D±1 the event is found.
  test('fills a fixture whose ESPN event is on the previous UTC day', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [missingRow({
        id: 537386,
        utc_date: '2026-07-12T01:00:00.000Z',
        home_team: null,
        away_team: null,
        stage: 'QUARTER_FINALS',
      })] })
      .mockResolvedValue({ rows: [] });
    global.fetch = jest.fn().mockImplementation((url) => {
      // Only the 20260711 scoreboard actually returns the event, matching what
      // ESPN's live API does for 00-06 UTC kickoffs.
      if (url.includes('20260711')) return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ events: [espnEvent('Argentina', 'Switzerland', '2026-07-12T01:00Z')] }),
      });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ events: [] }) });
    });

    const r = await backfillBracket();
    expect(r).toMatchObject({ missing: 1, filled: 1 });

    const upd = db.query.mock.calls.find((c) => /UPDATE matches/.test(c[0]));
    expect(upd[1]).toEqual([537386, 'Argentina', 'Switzerland']);
  });
});

describe('expandDatesByOne', () => {
  test('adds the day before and after each entry', () => {
    expect(expandDatesByOne(['20260712']).sort()).toEqual(['20260711', '20260712', '20260713']);
  });

  test('deduplicates overlapping windows', () => {
    const out = expandDatesByOne(['20260711', '20260712']).sort();
    expect(out).toEqual(['20260710', '20260711', '20260712', '20260713']);
  });

  test('crosses month boundaries', () => {
    expect(expandDatesByOne(['20260701']).sort()).toEqual(['20260630', '20260701', '20260702']);
  });
});
