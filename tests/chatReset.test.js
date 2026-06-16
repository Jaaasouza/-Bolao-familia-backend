jest.mock('../src/db/pool');

const db = require('../src/db/pool');
const { clearChatOnGameEnd } = require('../src/services/chatReset');

// Drive the helper by faking the two reads it does: the live-match count and the
// stored chat_live_flag. Captures whether DELETE / flag writes happened.
function setup({ liveCount, hadLive }) {
  const calls = { deleted: false, deleteSql: '', flag: undefined };
  db.query.mockImplementation((sql, params) => {
    if (/FROM matches WHERE status/.test(sql)) return Promise.resolve({ rows: [{ n: liveCount }] });
    if (/SELECT value FROM sync_state/.test(sql)) return Promise.resolve({ rows: hadLive === null ? [] : [{ value: hadLive }] });
    if (/DELETE FROM chat_messages/.test(sql)) { calls.deleted = true; calls.deleteSql = sql; return Promise.resolve({ rowCount: 3 }); }
    if (/INSERT INTO sync_state/.test(sql)) { calls.flag = JSON.parse(params[0]); return Promise.resolve({ rows: [] }); }
    return Promise.resolve({ rows: [] });
  });
  return calls;
}

beforeEach(() => jest.clearAllMocks());

describe('clearChatOnGameEnd', () => {
  test('marks live when a game kicks off (no wipe)', async () => {
    const calls = setup({ liveCount: 1, hadLive: false });
    const r = await clearChatOnGameEnd();
    expect(r).toEqual({ live: true });
    expect(calls.deleted).toBe(false);
    expect(calls.flag).toBe(true);
  });

  test('wipes the chat when the last live game ends', async () => {
    const calls = setup({ liveCount: 0, hadLive: true });
    const r = await clearChatOnGameEnd();
    expect(r).toEqual({ cleared: 3 });
    expect(calls.deleted).toBe(true);
    expect(calls.deleteSql).toMatch(/channel = 'live'/); // only the live channel
    expect(calls.flag).toBe(false);
  });

  test('does nothing when idle (no live, none was live)', async () => {
    const calls = setup({ liveCount: 0, hadLive: false });
    const r = await clearChatOnGameEnd();
    expect(r).toEqual({ idle: true });
    expect(calls.deleted).toBe(false);
  });

  test('stays live without re-writing the flag', async () => {
    const calls = setup({ liveCount: 2, hadLive: true });
    const r = await clearChatOnGameEnd();
    expect(r).toEqual({ live: true });
    expect(calls.deleted).toBe(false);
    expect(calls.flag).toBeUndefined();
  });
});
