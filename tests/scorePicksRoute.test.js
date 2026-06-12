jest.mock('../src/db/pool');

process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const db = require('../src/db/pool');
const { signToken } = require('../src/middleware/auth');
const { buildApp } = require('../src/app');

const app = buildApp();
const playerBearer = `Bearer ${signToken({ role: 'player', pid: 'p_1' })}`;
const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

function mockMatches(rows) {
  db.query.mockImplementation((sql) => {
    if (/FROM matches/.test(sql)) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.getClient.mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() });
});

describe('POST /api/score-picks (família — per-match, rolling)', () => {
  test('saves picks for open matches and skips ones that already kicked off', async () => {
    mockMatches([
      { id: 1, utc_date: future, status: 'TIMED', stage: 'GROUP_STAGE' },
      { id: 2, utc_date: past, status: 'TIMED', stage: 'GROUP_STAGE' },
    ]);
    const res = await request(app).post('/api/score-picks').set('Authorization', playerBearer)
      .send({ picks: [{ matchId: 1, home: 2, away: 1 }, { matchId: 2, home: 0, away: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, saved: 1, skipped: 1 });
  });

  test('accepts a partial submission (no need to cover a whole phase)', async () => {
    mockMatches([
      { id: 1, utc_date: future, status: 'TIMED', stage: 'GROUP_STAGE' },
      { id: 2, utc_date: future, status: 'TIMED', stage: 'GROUP_STAGE' },
    ]);
    const res = await request(app).post('/api/score-picks').set('Authorization', playerBearer)
      .send({ picks: [{ matchId: 1, home: 3, away: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, saved: 1 });
  });

  test('423 when every submitted match has already started', async () => {
    mockMatches([{ id: 2, utc_date: past, status: 'TIMED', stage: 'GROUP_STAGE' }]);
    const res = await request(app).post('/api/score-picks').set('Authorization', playerBearer)
      .send({ picks: [{ matchId: 2, home: 0, away: 0 }] });
    expect(res.status).toBe(423);
  });

  test('400 on an invalid scoreline', async () => {
    mockMatches([{ id: 1, utc_date: future, status: 'TIMED', stage: 'GROUP_STAGE' }]);
    const res = await request(app).post('/api/score-picks').set('Authorization', playerBearer)
      .send({ picks: [{ matchId: 1, home: -1, away: 0 }] });
    expect(res.status).toBe(400);
  });
});
