jest.mock('../src/db/pool');
jest.mock('../src/services/push', () => ({ notifyMatchEvents: jest.fn().mockResolvedValue({ events: 0 }) }));

process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const db = require('../src/db/pool');
const { signToken } = require('../src/middleware/auth');
const { buildApp } = require('../src/app');

const app = buildApp();
const adminBearer = `Bearer ${signToken({ role: 'admin' })}`;

beforeEach(() => {
  jest.clearAllMocks();
  db.getClient.mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() });
});

describe('POST /api/matches/:id/score', () => {
  test('requires admin', async () => {
    const res = await request(app).post('/api/matches/1/score').send({ home: 1, away: 0 });
    expect(res.status).toBe(401);
  });

  test('sets a live score (defaults status to IN_PLAY, pins manual)', async () => {
    const res = await request(app).post('/api/matches/537327/score').set('Authorization', adminBearer).send({ home: 1, away: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 537327, home: 1, away: 0, status: 'IN_PLAY', manual: true });
  });

  test('FINISHED derives the winner', async () => {
    const res = await request(app).post('/api/matches/1/score').set('Authorization', adminBearer).send({ home: 2, away: 1, status: 'FINISHED' });
    expect(res.body).toMatchObject({ status: 'FINISHED' });
  });

  test('rejects negative scores', async () => {
    const res = await request(app).post('/api/matches/1/score').set('Authorization', adminBearer).send({ home: -1, away: 0 });
    expect(res.status).toBe(400);
  });
});
