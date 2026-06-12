jest.mock('../src/db/pool');
const db = require('../src/db/pool');
const { settleStaleMatches } = require('../src/services/syncMatches');

beforeEach(() => jest.clearAllMocks());

describe('settleStaleMatches', () => {
  test('force-finishes scored matches kicked off 3h+ ago (not manual, not finished)', async () => {
    db.query.mockResolvedValue({ rowCount: 2 });
    const r = await settleStaleMatches();
    expect(r).toEqual({ settled: 2 });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/SET status = 'FINISHED'/);
    expect(sql).toMatch(/manual_score = FALSE/);
    expect(sql).toMatch(/status <> 'FINISHED'/);
    expect(sql).toMatch(/home_score IS NOT NULL AND away_score IS NOT NULL/);
    expect(sql).toMatch(/INTERVAL '3 hours'/);
  });
});
