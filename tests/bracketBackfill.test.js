jest.mock('../src/db/pool');

const db = require('../src/db/pool');
const {
  backfillBracket, isPlaceholderName, mapEvent,
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
    expect(r).toMatchObject({ missing: 1, filled: 1, scanned: 1, dates: 1 });

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
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => ({}) }) // first date errors
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ events: [espnEvent('Spain', 'Austria', '2026-07-02T19:00Z')] }) });
    // Mock the actual fetch invocation since we may also need a non-OK to throw
    global.fetch = jest.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('espn 503')))
      .mockImplementationOnce(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ events: [espnEvent('Spain', 'Austria', '2026-07-02T19:00Z')] }) }));

    const r = await backfillBracket();
    expect(r.dates).toBe(2);
    // One filled (the second date succeeded).
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
    expect(payload).toMatchObject({ missing: 1, filled: 1, dates: 1 });
  });
});
