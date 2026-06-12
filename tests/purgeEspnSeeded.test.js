jest.mock('../src/db/pool');

const db = require('../src/db/pool');
const { purgeEspnSeeded } = require('../src/services/syncMatches');

describe('purgeEspnSeeded', () => {
  beforeEach(() => jest.clearAllMocks());

  test('deletes only ESPN-seeded rows (PK == espn_id) and reports the count', async () => {
    db.query.mockResolvedValue({ rowCount: 3 });
    const r = await purgeEspnSeeded();
    expect(r).toEqual({ purged: 3 });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/DELETE FROM matches/);
    expect(sql).toMatch(/CAST\(id AS TEXT\) = espn_id/);
  });

  test('is best-effort — never throws', async () => {
    db.query.mockRejectedValue(new Error('boom'));
    await expect(purgeEspnSeeded()).resolves.toMatchObject({ purged: 0 });
  });
});
