const { predictedGroupTables, groupBonusForPlayer, decidedGroups } = require('../src/services/groupBonus');

// Group A: MEX beats RSA, etc. Build matches so MEX finishes 1st, RSA 2nd.
const matches = [
  { id: 1, home_team: 'MEX', away_team: 'RSA', stage: 'GROUP_STAGE', group_name: 'GROUP_A' },
  { id: 2, home_team: 'MEX', away_team: 'URU', stage: 'GROUP_STAGE', group_name: 'GROUP_A' },
  { id: 3, home_team: 'RSA', away_team: 'URU', stage: 'GROUP_STAGE', group_name: 'GROUP_A' },
];
const matchesById = Object.fromEntries(matches.map((m) => [m.id, m]));

// Picks: MEX wins both, RSA beats URU → MEX 1st (6), RSA 2nd (3), URU 0.
const picks = [
  { match_id: 1, pred_home: 2, pred_away: 0 },
  { match_id: 2, pred_home: 1, pred_away: 0 },
  { match_id: 3, pred_home: 1, pred_away: 0 },
];

describe('predictedGroupTables', () => {
  test('ranks the group from scorelines', () => {
    const t = predictedGroupTables(picks, matchesById);
    expect(t.A.first).toBe('MEX');
    expect(t.A.second).toBe('RSA');
    expect(t.A.complete).toBe(true);
  });
});

describe('groupBonusForPlayer (+2 exact / +1 swapped)', () => {
  const pred = predictedGroupTables(picks, matchesById);

  test('+2 when both qualifiers correct in order', () => {
    const { bonus, perGroup } = groupBonusForPlayer(pred, { A: { first: 'MEX', second: 'RSA' } });
    expect(perGroup.A).toBe(2);
    expect(bonus).toBe(2);
  });

  test('+1 when the two qualifiers are right but swapped', () => {
    const { bonus } = groupBonusForPlayer(pred, { A: { first: 'RSA', second: 'MEX' } });
    expect(bonus).toBe(1);
  });

  test('0 when a qualifier is wrong', () => {
    const { bonus } = groupBonusForPlayer(pred, { A: { first: 'MEX', second: 'URU' } });
    expect(bonus).toBe(0);
  });

  test('no bonus before the group is decided (no actual 1st/2nd)', () => {
    expect(groupBonusForPlayer(pred, { A: { first: null, second: null } }).bonus).toBe(0);
    expect(groupBonusForPlayer(pred, {}).bonus).toBe(0);
  });

  test('decided set gates the bonus — undecided groups score 0 even if standings are filled', () => {
    const act = { A: { first: 'MEX', second: 'RSA' } };
    // A correct prediction, but the group is NOT in the decided set → no points.
    expect(groupBonusForPlayer(pred, act, new Set()).bonus).toBe(0);
    // Once decided, it scores.
    expect(groupBonusForPlayer(pred, act, new Set(['A'])).bonus).toBe(2);
  });
});

describe('decidedGroups', () => {
  test('only groups with every match FINISHED are decided', () => {
    const byId = {
      1: { status: 'FINISHED', stage: 'GROUP_STAGE', group_name: 'GROUP_A' },
      2: { status: 'FINISHED', stage: 'GROUP_STAGE', group_name: 'GROUP_A' },
      3: { status: 'TIMED', stage: 'GROUP_STAGE', group_name: 'GROUP_B' },
      4: { status: 'FINISHED', stage: 'GROUP_STAGE', group_name: 'GROUP_B' },
    };
    const d = decidedGroups(byId);
    expect(d.has('A')).toBe(true);
    expect(d.has('B')).toBe(false);
  });

  test('empty before the tournament (nothing finished)', () => {
    const byId = {
      1: { status: 'TIMED', stage: 'GROUP_STAGE', group_name: 'GROUP_A' },
      2: { status: 'SCHEDULED', stage: 'GROUP_STAGE', group_name: 'GROUP_L' },
    };
    expect(decidedGroups(byId).size).toBe(0);
  });

  test('sums across multiple groups', () => {
    const m2 = {
      10: { id: 10, home_team: 'BRA', away_team: 'MAR', stage: 'GROUP_STAGE', group_name: 'GROUP_C' },
    };
    const p2 = [{ match_id: 10, pred_home: 3, pred_away: 0 }];
    const predC = predictedGroupTables(p2, m2);
    // Only one match → BRA 1st, MAR 2nd.
    const { bonus } = groupBonusForPlayer(predC, { C: { first: 'BRA', second: 'MAR' } });
    expect(bonus).toBe(2);
  });
});
