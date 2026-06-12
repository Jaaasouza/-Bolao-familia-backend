jest.mock('../src/db/pool');

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

describe('POST /api/players (admin) phone update', () => {
  test('attaches a normalized phone to the player', async () => {
    const res = await request(app).post('/api/players').set('Authorization', adminBearer)
      .send({ id: 'p_1', name: 'João', phone: '703-475-0304' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 'p_1', phone: '(703) 475-0304' });
  });

  test('rejects an invalid phone', async () => {
    const res = await request(app).post('/api/players').set('Authorization', adminBearer)
      .send({ id: 'p_1', name: 'João', phone: '123' });
    expect(res.status).toBe(400);
  });

  test('omitting phone keeps the stored one (no validation error)', async () => {
    const res = await request(app).post('/api/players').set('Authorization', adminBearer)
      .send({ id: 'p_1', name: 'João' });
    expect(res.status).toBe(200);
  });
});
