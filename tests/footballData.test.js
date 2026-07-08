const { mapMatch, fetchAllMatches } = require('../src/services/footballData');

describe('mapMatch', () => {
  test('flattens the football-data.org shape', () => {
    const m = mapMatch({
      id: 5,
      utcDate: '2026-06-11T16:00:00Z',
      status: 'FINISHED',
      stage: 'GROUP_STAGE',
      group: 'GROUP_A',
      homeTeam: { name: 'Brazil' },
      awayTeam: { name: 'Mexico' },
      score: { fullTime: { home: 2, away: 1 }, winner: 'HOME_TEAM' },
      lastUpdated: '2026-06-11T18:00:00Z',
    });
    expect(m).toMatchObject({
      id: 5,
      home_team: 'Brazil',
      away_team: 'Mexico',
      home_score: 2,
      away_score: 1,
      winner: 'HOME_TEAM',
      group_name: 'GROUP_A',
    });
  });

  test('tolerates missing nested fields', () => {
    const m = mapMatch({ id: 1, score: {} });
    expect(m.home_team).toBeNull();
    expect(m.home_score).toBeNull();
    expect(m.winner).toBeNull();
  });

  // Regression: R16 Switzerland 0-0 Colombia (won by CH on pens) was stored
  // as winner=DRAW because FD sent winner=null. The mapped row now derives
  // the winner from the fullTime aggregate when duration=PENALTY_SHOOTOUT.
  test('derives winner from fullTime aggregate on a shootout when FD says null', () => {
    const m = mapMatch({
      id: 537382,
      stage: 'LAST_16',
      homeTeam: { name: 'Switzerland' },
      awayTeam: { name: 'Colombia' },
      score: {
        winner: null,
        duration: 'PENALTY_SHOOTOUT',
        fullTime: { home: 4, away: 3 },
        regularTime: { home: 0, away: 0 },
        extraTime: { home: 0, away: 0 },
        penalties: { home: 3, away: 3 },
      },
    });
    expect(m.winner).toBe('HOME_TEAM');
    // Display score should be the regulation result, not the shootout aggregate.
    expect(m.home_score).toBe(0);
    expect(m.away_score).toBe(0);
  });

  test('picks AWAY_TEAM when the shootout aggregate favours the away side', () => {
    const m = mapMatch({
      id: 42,
      stage: 'LAST_16',
      homeTeam: { name: 'Portugal' },
      awayTeam: { name: 'Croatia' },
      score: {
        winner: null,
        duration: 'PENALTY_SHOOTOUT',
        fullTime: { home: 3, away: 4 },
        regularTime: { home: 1, away: 1 },
      },
    });
    expect(m.winner).toBe('AWAY_TEAM');
    expect(m.home_score).toBe(1);
    expect(m.away_score).toBe(1);
  });

  test('respects FD winner when it is populated (no derivation needed)', () => {
    const m = mapMatch({
      id: 7,
      stage: 'GROUP_STAGE',
      score: { winner: 'AWAY_TEAM', duration: 'REGULAR', fullTime: { home: 0, away: 1 } },
    });
    expect(m.winner).toBe('AWAY_TEAM');
    expect(m.home_score).toBe(0);
    expect(m.away_score).toBe(1);
  });

  test('leaves a group-stage 0-0 draw alone (no shootout, no forced winner)', () => {
    const m = mapMatch({
      id: 8,
      stage: 'GROUP_STAGE',
      score: { winner: 'DRAW', duration: 'REGULAR', fullTime: { home: 0, away: 0 } },
    });
    expect(m.winner).toBe('DRAW');
  });
});

describe('fetchAllMatches', () => {
  afterEach(() => {
    delete global.fetch;
  });

  test('throws without an API key', async () => {
    delete process.env.FOOTBALL_DATA_API_KEY;
    await expect(fetchAllMatches()).rejects.toThrow('FOOTBALL_DATA_API_KEY');
  });

  test('maps a successful response', async () => {
    process.env.FOOTBALL_DATA_API_KEY = 'k';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        matches: [{ id: 1, homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, score: {} }],
      }),
    });
    const rows = await fetchAllMatches();
    expect(rows).toHaveLength(1);
    expect(rows[0].home_team).toBe('A');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/competitions/WC/matches'),
      expect.objectContaining({ headers: { 'X-Auth-Token': 'k' } })
    );
  });
});
