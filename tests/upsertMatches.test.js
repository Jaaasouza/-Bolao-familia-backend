jest.mock('../src/db/pool');

const db = require('../src/db/pool');
const { upsertMatches } = require('../src/services/syncMatches');

describe('upsertMatches — merge protections', () => {
  let client;
  beforeEach(() => {
    jest.clearAllMocks();
    client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.getClient.mockResolvedValue(client);
  });

  function getUpsertSql() {
    const call = client.query.mock.calls.find((c) => /INSERT INTO matches/i.test(c[0]));
    return call ? call[0] : null;
  }

  test('protects manual_score (existing behavior — regression guard)', async () => {
    await upsertMatches([
      { id: 1, utc_date: '2026-06-29', status: 'TIMED', stage: 'LAST_32', group_name: null,
        home_team: 'Germany', away_team: 'Brazil', home_score: null, away_score: null,
        winner: null, last_updated: null, raw: {} },
    ]);
    const sql = getUpsertSql();
    expect(sql).toMatch(/WHEN matches\.manual_score THEN matches\.home_score/);
  });

  test('protects admin-set teams (manual_teams=TRUE leaves home_team/away_team alone)', async () => {
    await upsertMatches([
      { id: 1, utc_date: '2026-06-29', status: 'TIMED', stage: 'LAST_32', group_name: null,
        home_team: 'Germany', away_team: 'Brazil', home_score: null, away_score: null,
        winner: null, last_updated: null, raw: {} },
    ]);
    const sql = getUpsertSql();
    // The whole point of v19: admin entry beats anything the source pushes.
    expect(sql).toMatch(/WHEN matches\.manual_teams THEN matches\.home_team/);
    expect(sql).toMatch(/WHEN matches\.manual_teams THEN matches\.away_team/);
  });

  test('never nulls a known team name (defense against transient null from FD)', async () => {
    // The merge keeps the previous team_name when EXCLUDED.x is null. This is
    // why a knockout fixture that briefly comes back as null from FD won't
    // erase the names the admin entered (or that an earlier sync filled in).
    await upsertMatches([
      { id: 1, utc_date: '2026-06-29', status: 'TIMED', stage: 'LAST_32', group_name: null,
        home_team: null, away_team: null, home_score: null, away_score: null,
        winner: null, last_updated: null, raw: {} },
    ]);
    const sql = getUpsertSql();
    expect(sql).toMatch(/WHEN EXCLUDED\.home_team IS NULL THEN matches\.home_team/);
    expect(sql).toMatch(/WHEN EXCLUDED\.away_team IS NULL THEN matches\.away_team/);
  });

  test('self-heals a stuck DRAW when a decisive winner arrives (shootout fix)', async () => {
    // In a knockout there's no draw — but FD (and sometimes ESPN before the
    // shootout ends) can leave the row on DRAW. The upsert must let a later
    // sync promote DRAW → HOME_TEAM/AWAY_TEAM even if the row is FINISHED.
    await upsertMatches([
      { id: 1, utc_date: '2026-06-29', status: 'FINISHED', stage: 'LAST_16', group_name: null,
        home_team: 'Switzerland', away_team: 'Colombia', home_score: 0, away_score: 0,
        winner: 'HOME_TEAM', last_updated: null, raw: {} },
    ]);
    const sql = getUpsertSql();
    // The healing clause must run BEFORE the "FINISHED locks winner" clause,
    // otherwise the DRAW stays permanent.
    expect(sql).toMatch(/WHEN matches\.winner = 'DRAW'[\s\S]+EXCLUDED\.winner IN \('HOME_TEAM', 'AWAY_TEAM'\)[\s\S]+THEN EXCLUDED\.winner/);
    const healIdx = sql.search(/matches\.winner = 'DRAW'/);
    const finishedLockIdx = sql.search(/WHEN matches\.status = 'FINISHED' THEN matches\.winner/);
    expect(healIdx).toBeGreaterThan(-1);
    expect(finishedLockIdx).toBeGreaterThan(-1);
    expect(healIdx).toBeLessThan(finishedLockIdx);
  });
});
