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
