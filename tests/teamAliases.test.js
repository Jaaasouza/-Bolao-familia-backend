const { resolveTeamName, CANONICAL } = require('../src/services/teamAliases');

describe('resolveTeamName', () => {
  test('maps football-data names to canonical pool names', () => {
    expect(resolveTeamName('Korea Republic')).toBe('South Korea');
    expect(resolveTeamName('IR Iran')).toBe('Iran');
    expect(resolveTeamName("Côte d'Ivoire")).toBe('Ivory Coast');
    expect(resolveTeamName('United States')).toBe('USA');
    expect(resolveTeamName('Turkey')).toBe('Türkiye');
    expect(resolveTeamName('Czech Republic')).toBe('Czechia');
  });

  test('passes through already-canonical names', () => {
    for (const t of CANONICAL) expect(resolveTeamName(t)).toBe(t);
  });

  test('is accent/punctuation/case insensitive', () => {
    expect(resolveTeamName('  brazil ')).toBe('Brazil');
    expect(resolveTeamName('TÜRKIYE')).toBe('Türkiye');
  });

  test('returns the original for unknown names', () => {
    expect(resolveTeamName('Atlantis')).toBe('Atlantis');
    expect(resolveTeamName(null)).toBe(null);
  });
});
