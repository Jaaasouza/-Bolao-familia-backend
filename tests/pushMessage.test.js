const { matchEventMessage, matchResultMessage } = require('../src/services/push');

const facts = { home: 'Mexico', away: 'USA', homeScore: 2, awayScore: 1, predHome: 2, predAway: 1, pts: 3, total: 14 };

describe('matchEventMessage', () => {
  test('full-time, English (back-compat shim matches too)', () => {
    const m = matchEventMessage('en', 'full', facts);
    expect(m.title).toBe('FT: Mexico 2–1 USA');
    expect(m.body).toBe('Your pick 2–1 → +3 pts. Total: 14 pts.');
    expect(matchResultMessage('en', facts)).toEqual(m);
  });

  test('full-time, Spanish', () => {
    const m = matchEventMessage('es', 'full', facts);
    expect(m.title).toBe('Final: Mexico 2–1 USA');
    expect(m.body).toBe('Tu pronóstico 2–1 → +3 pts. Total: 14 pts.');
  });

  test('kickoff shows the pick + running total, no score', () => {
    const en = matchEventMessage('en', 'kickoff', { ...facts, homeScore: 0, awayScore: 0, pts: 0 });
    expect(en.title).toBe('🟢 Kickoff: Mexico vs USA');
    expect(en.body).toBe('Your pick: 2–1. Your total so far: 14 pts.');
    expect(matchEventMessage('es', 'kickoff', facts).title).toBe('🟢 Comienza: Mexico vs USA');
  });

  test('goal is provisional ("if it ends now")', () => {
    expect(matchEventMessage('en', 'goal', facts).title).toBe('⚽ GOAL! Mexico 2–1 USA');
    expect(matchEventMessage('en', 'goal', facts).body).toContain('if it ends now');
    expect(matchEventMessage('es', 'goal', facts).title).toBe('⚽ ¡GOL! Mexico 2–1 USA');
    expect(matchEventMessage('es', 'goal', facts).body).toContain('si termina así');
  });

  test('half-time wording per language', () => {
    expect(matchEventMessage('en', 'half', facts).title).toBe('⏸️ Half-time: Mexico 2–1 USA');
    expect(matchEventMessage('en', 'half', facts).body).toContain('so far');
    expect(matchEventMessage('es', 'half', facts).title).toBe('⏸️ Medio tiempo: Mexico 2–1 USA');
  });

  test('zero / singular point wording', () => {
    expect(matchEventMessage('en', 'full', { ...facts, pts: 0 }).body).toContain('no points');
    expect(matchEventMessage('es', 'full', { ...facts, pts: 0 }).body).toContain('sin puntos');
    expect(matchEventMessage('en', 'full', { ...facts, pts: 1 }).body).toContain('+1 pt.');
  });
});
