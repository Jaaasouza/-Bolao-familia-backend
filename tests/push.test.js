jest.mock('../src/db/pool');

process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const db = require('../src/db/pool');
const { signToken } = require('../src/middleware/auth');
const { buildApp } = require('../src/app');

const app = buildApp();
const playerBearer = (pid) => `Bearer ${signToken({ role: 'player', pid })}`;

beforeEach(() => { jest.clearAllMocks(); });

describe('push routes', () => {
  test('GET /api/push/key returns enabled flag + key', async () => {
    const res = await request(app).get('/api/push/key');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('enabled');
    expect(res.body).toHaveProperty('publicKey');
  });

  test('POST /api/push/subscribe rejects an invalid subscription', async () => {
    const res = await request(app)
      .post('/api/push/subscribe')
      .set('Authorization', playerBearer('p1'))
      .send({ subscription: { endpoint: 'x' } }); // missing keys
    expect(res.status).toBe(400);
  });

  test('POST /api/push/subscribe stores a valid subscription', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post('/api/push/subscribe')
      .set('Authorization', playerBearer('p1'))
      .send({ subscription: { endpoint: 'https://e', keys: { p256dh: 'a', auth: 'b' } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('subscribe requires auth', async () => {
    const res = await request(app)
      .post('/api/push/subscribe')
      .send({ subscription: { endpoint: 'https://e', keys: { p256dh: 'a', auth: 'b' } } });
    expect(res.status).toBe(401);
  });
});
