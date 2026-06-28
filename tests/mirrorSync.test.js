jest.mock('../src/db/pool');

const db = require('../src/db/pool');
const { mirrorFromSource } = require('../src/services/mirrorSync');

function mockClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
}

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { delete global.fetch; });

test('mirrors matches + standings from the source into upserts', async () => {
  const client = mockClient();
  db.getClient.mockResolvedValue(client);

  global.fetch = jest.fn((url) => {
    if (/\/api\/matches$/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ matches: [
        { id: 1, utc_date: '2026-06-11T16:00:00Z', status: 'TIMED', stage: 'GROUP_STAGE',
          group_name: 'GROUP_A', home_team: 'MEX', away_team: 'RSA',
          home_score: null, away_score: null, winner: null, last_updated: null, raw: { x: 1 } },
      ] }) });
    }
    if (/\/api\/standings$/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ standings: { A: { first: 'MEX', second: 'RSA' } } }) });
    }
    return Promise.reject(new Error('unexpected url ' + url));
  });

  const r = await mirrorFromSource('https://source.example.com/');
  expect(r).toEqual({ count: 1 });

  const sql = client.query.mock.calls.map((c) => c[0]).join('\n');
  expect(sql).toMatch(/INSERT INTO matches/);
  expect(sql).toMatch(/INSERT INTO standings/);
  expect(sql).toMatch(/last_mirror/);

  // raw object is stringified for the jsonb column.
  const matchInsert = client.query.mock.calls.find((c) => /INSERT INTO matches/.test(c[0]));
  expect(matchInsert[1][11]).toBe(JSON.stringify({ x: 1 }));
});

test('skips when the source has no matches', async () => {
  const client = mockClient();
  db.getClient.mockResolvedValue(client);
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ matches: [] }) }));

  const r = await mirrorFromSource('https://source.example.com');
  expect(r).toEqual({ count: 0, skipped: true });
  expect(client.query).not.toHaveBeenCalled();
});

test('throws on a non-OK matches response', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) }));
  await expect(mirrorFromSource('https://source.example.com')).rejects.toThrow(/mirror fetch 502/);
});

test('upsert protects manual_score / manual_teams / nulls — same as direct sync', async () => {
  const client = mockClient();
  db.getClient.mockResolvedValue(client);
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ matches: [
    { id: 1, utc_date: '2026-06-29', status: 'TIMED', stage: 'LAST_32', group_name: null,
      home_team: 'Germany', away_team: null, home_score: null, away_score: null,
      winner: null, last_updated: null, raw: {} },
  ] }) }));

  await mirrorFromSource('https://source.example.com');
  const sql = client.query.mock.calls.find((c) => /INSERT INTO matches/.test(c[0]))[0];
  // The fix this test guards: mirror used to do home_team = EXCLUDED.home_team
  // direct, so a null from the source would erase a team. Now it's protected:
  expect(sql).toMatch(/WHEN matches\.manual_teams THEN matches\.home_team/);
  expect(sql).toMatch(/WHEN EXCLUDED\.home_team IS NULL THEN matches\.home_team/);
  expect(sql).toMatch(/WHEN matches\.manual_teams THEN matches\.away_team/);
  expect(sql).toMatch(/WHEN EXCLUDED\.away_team IS NULL THEN matches\.away_team/);
  // Same score / status protections as syncMatches:
  expect(sql).toMatch(/WHEN matches\.manual_score THEN matches\.home_score/);
  expect(sql).toMatch(/WHEN matches\.status = 'FINISHED' THEN matches\.home_score/);
});
