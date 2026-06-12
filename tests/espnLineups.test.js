const { parseLineups, parseTeamRoster } = require('../src/services/espnLineups');

function team(homeAway, id, formation, starters) {
  return {
    homeAway, team: { id },
    formation,
    coach: [{ firstName: 'Coach', lastName: id }],
    roster: [
      ...starters.map((s, i) => ({ starter: true, jersey: String(i + 1), formationPlace: String(i + 1),
        position: { abbreviation: i === 0 ? 'G' : 'M' }, athlete: { displayName: s } })),
      { starter: false, jersey: '12', position: { abbreviation: 'F' }, athlete: { displayName: 'Sub One' } },
    ],
  };
}

const ELEVEN = Array.from({ length: 11 }, (_, i) => `Player ${i + 1}`);

describe('parseTeamRoster', () => {
  test('splits starters/subs, keeps formation + coach', () => {
    const t = parseTeamRoster(team('home', 'H', '4-3-3', ELEVEN));
    expect(t.formation).toBe('4-3-3');
    expect(t.coach).toBe('Coach H');
    expect(t.starters).toHaveLength(11);
    expect(t.subs).toHaveLength(1);
    expect(t.starters[0]).toMatchObject({ num: '1', name: 'Player 1', pos: 'G', place: 1 });
  });
});

describe('parseLineups', () => {
  test('maps home/away by homeAway', () => {
    const l = parseLineups({ rosters: [team('home', 'H', '4-4-2', ELEVEN), team('away', 'A', '4-3-3', ELEVEN)] });
    expect(l.home.formation).toBe('4-4-2');
    expect(l.away.formation).toBe('4-3-3');
  });

  test('maps home/away by header competitors when homeAway absent', () => {
    const h = team(undefined, 'H', '4-4-2', ELEVEN);
    const a = team(undefined, 'A', '3-5-2', ELEVEN);
    const l = parseLineups({
      rosters: [a, h],
      header: { competitions: [{ competitors: [{ homeAway: 'home', team: { id: 'H' } }, { homeAway: 'away', team: { id: 'A' } }] }] },
    });
    expect(l.home.formation).toBe('4-4-2');
    expect(l.away.formation).toBe('3-5-2');
  });

  test('returns null before lineups are published (no starters)', () => {
    const empty = { homeAway: 'home', team: { id: 'H' }, roster: [] };
    expect(parseLineups({ rosters: [empty, empty] })).toBe(null);
    expect(parseLineups({ rosters: [] })).toBe(null);
  });
});

const { parseSummaryEvents } = require('../src/services/espnLineups');

describe('parseSummaryEvents', () => {
  const summary = {
    header: { competitions: [{ competitors: [
      { team: { id: 'H', displayName: 'Mexico' } },
      { team: { id: 'A', displayName: 'South Africa' } },
    ] }] },
    keyEvents: [
      { type: { text: 'Yellow Card' }, clock: { displayValue: "40'" }, team: { id: 'A' }, participants: [{ athlete: { displayName: 'Mokoena' } }] },
      { type: { text: 'Goal' }, clock: { displayValue: "23'" }, team: { id: 'H' }, participants: [{ athlete: { displayName: 'Raúl Jiménez' } }] },
      { type: { text: 'Substitution' }, clock: { displayValue: "60'" }, team: { id: 'H' } },
    ],
  };

  test('parses goals + cards, sorted, canonical teams', () => {
    expect(parseSummaryEvents(summary)).toEqual([
      { kind: 'goal', minute: 23, team: 'Mexico', player: 'Raúl Jiménez' },
      { kind: 'yellow', minute: 40, team: 'South Africa', player: 'Mokoena' },
    ]);
  });

  test('empty when there are no key events', () => {
    expect(parseSummaryEvents({ keyEvents: [] })).toEqual([]);
    expect(parseSummaryEvents({})).toEqual([]);
  });
});

const { parseSummaryCommentary } = require('../src/services/espnLineups');

describe('parseSummaryCommentary', () => {
  test('maps play-by-play text + minute', () => {
    const c = parseSummaryCommentary({ commentary: [
      { time: { displayValue: "12'" }, text: 'Corner, Mexico.' },
      { play: { text: 'Foul by Mokoena.' }, clock: { displayValue: "40'" } },
      { text: '' },
    ] });
    expect(c).toEqual([
      { minute: 12, text: 'Corner, Mexico.' },
      { minute: 40, text: 'Foul by Mokoena.' },
    ]);
  });
  test('empty when no commentary', () => {
    expect(parseSummaryCommentary({})).toEqual([]);
  });
});
