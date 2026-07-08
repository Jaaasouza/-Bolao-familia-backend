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

  test('uses a longer window (4h30) before finishing a still-live match', async () => {
    db.query.mockResolvedValue({ rowCount: 0 });
    await settleStaleMatches();
    const sql = db.query.mock.calls[0][0];
    // A live/half-time match isn't force-finished until 4h30 (avoids settling a
    // game during a long stoppage); stuck non-live ones still settle at 3h.
    expect(sql).toMatch(/INTERVAL '4 hours 30 minutes'/);
    expect(sql).toMatch(/IN_PLAY/);
  });

  test('never force-writes DRAW on a knockout stage (shootout self-heal preserved)', async () => {
    db.query.mockResolvedValue({ rowCount: 0 });
    await settleStaleMatches();
    const sql = db.query.mock.calls[0][0];
    // Knockout stages must get winner=NULL when scores are level (so the
    // upsert's DRAW→decisive branch can later heal it once pens land).
    expect(sql).toMatch(/WHEN stage IN \('LAST_32','LAST_16','QUARTER_FINALS','SEMI_FINALS','THIRD_PLACE','FINAL'\) THEN NULL/);
    // Group stage still legitimately settles to DRAW.
    expect(sql).toMatch(/ELSE 'DRAW'/);
  });
});
