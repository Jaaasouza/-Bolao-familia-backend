jest.mock('../src/db/pool');

process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const db = require('../src/db/pool');
const { signToken } = require('../src/middleware/auth');
const { buildApp } = require('../src/app');

const app = buildApp();
const adminBearer = `Bearer ${signToken({ role: 'admin' })}`;
const playerBearer = `Bearer ${signToken({ role: 'player', pid: 'p1' })}`;

beforeEach(() => { jest.clearAllMocks(); });

describe('DELETE /api/players/:id', () => {
  test('requires admin', async () => {
    const res = await request(app).delete('/api/players/p1').set('Authorization', playerBearer);
    expect(res.status).toBe(403);
  });

  test('cascades to picks/subs and reports success', async () => {
    const client = {
      query: jest.fn().mockImplementation((sql) => {
        if (/DELETE FROM players/.test(sql)) return { rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };
    db.getClient.mockResolvedValue(client);

    const res = await request(app).delete('/api/players/pX').set('Authorization', adminBearer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 'pX' });

    const deletes = client.query.mock.calls.map((c) => c[0]).filter((s) => /DELETE FROM/.test(s));
    expect(deletes.some((s) => /score_picks/.test(s))).toBe(true);
    expect(deletes.some((s) => /phase_submissions/.test(s))).toBe(true);
    expect(deletes.some((s) => /award_picks/.test(s))).toBe(true);
    expect(deletes.some((s) => /push_subscriptions/.test(s))).toBe(true);
    expect(deletes.some((s) => /players/.test(s))).toBe(true);
  });

  test('returns 404 when the player does not exist', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: jest.fn(),
    };
    db.getClient.mockResolvedValue(client);

    const res = await request(app).delete('/api/players/ghost').set('Authorization', adminBearer);
    expect(res.status).toBe(404);
  });
});
