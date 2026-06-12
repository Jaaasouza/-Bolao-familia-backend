const { mapStandings, mapScorers } = require('../src/services/footballData');

describe('mapStandings', () => {
  test('maps GROUP standings to { group: { first, second, table } }', () => {
    const data = {
      standings: [
        {
          type: 'TOTAL', group: 'GROUP_A',
          table: [
            { position: 1, team: { name: 'Mexico' }, playedGames: 3, won: 3, draw: 0, lost: 0, points: 9, goalsFor: 6, goalsAgainst: 1, goalDifference: 5 },
            { position: 2, team: { name: 'Korea Republic' }, playedGames: 3, won: 1, draw: 1, lost: 1, points: 4, goalsFor: 3, goalsAgainst: 3, goalDifference: 0 },
          ],
        },
      ],
    };
    const out = mapStandings(data);
    expect(out.A.first).toBe('Mexico');
    expect(out.A.second).toBe('South Korea'); // alias resolved
    expect(out.A.table).toHaveLength(2);
    expect(out.A.table[0].points).toBe(9);
  });

  test('pre-tournament (0 games played) → no 1st/2nd, but table kept', () => {
    const data = {
      standings: [
        {
          type: 'TOTAL', group: 'GROUP_A',
          table: [
            { position: 1, team: { name: 'Mexico' }, playedGames: 0, won: 0, draw: 0, lost: 0, points: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0 },
            { position: 2, team: { name: 'Czechia' }, playedGames: 0, won: 0, draw: 0, lost: 0, points: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0 },
          ],
        },
      ],
    };
    const out = mapStandings(data);
    expect(out.A.first).toBeNull();
    expect(out.A.second).toBeNull();
    expect(out.A.table).toHaveLength(2); // full table still exposed for display
  });

  test('ignores non-group standings', () => {
    expect(mapStandings({ standings: [{ type: 'TOTAL', table: [] }] })).toEqual({});
  });
});

describe('mapScorers', () => {
  test('maps scorers with resolved team names', () => {
    const out = mapScorers({
      scorers: [
        { player: { name: 'Player One', nationality: 'Brazil' }, team: { name: 'Brazil' }, goals: 5, assists: 2, penalties: 1 },
      ],
    });
    expect(out[0]).toMatchObject({ player: 'Player One', team: 'Brazil', goals: 5 });
  });
});
