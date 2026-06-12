const { parseAwards, AWARD_KINDS } = require('../src/services/awards');

describe('parseAwards', () => {
  test('maps goldenBoot/bestPlayer to kinds', () => {
    expect(parseAwards({ goldenBoot: 'Kylian Mbappé', bestPlayer: 'Lionel Messi' })).toEqual([
      { kind: 'golden_boot', pick: 'Kylian Mbappé' },
      { kind: 'best_player', pick: 'Lionel Messi' },
    ]);
  });

  test('drops empty / missing picks', () => {
    expect(parseAwards({ goldenBoot: '  ', bestPlayer: 'Vinicius Junior' })).toEqual([
      { kind: 'best_player', pick: 'Vinicius Junior' },
    ]);
    expect(parseAwards({})).toEqual([]);
    expect(parseAwards(null)).toEqual([]);
  });

  test('trims and caps length at 80', () => {
    const [a] = parseAwards({ goldenBoot: `  ${'x'.repeat(200)}  ` });
    expect(a.pick.length).toBe(80);
  });

  test('AWARD_KINDS are the two expected kinds', () => {
    expect(AWARD_KINDS).toEqual(['golden_boot', 'best_player']);
  });
});
