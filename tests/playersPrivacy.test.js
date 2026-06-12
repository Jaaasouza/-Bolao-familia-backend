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

describe('GET /api/players phone privacy', () => {
  test('public request never SELECTs phone columns', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'p1', name: 'João', picks: {}, locked: true }] });
    const res = await request(app).get('/api/players');
    expect(res.status).toBe(200);
    const sql = db.query.mock.calls[0][0];
    expect(sql).not.toMatch(/phone/);
  });

  test('a player token is still treated as public (no phones)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await request(app).get('/api/players').set('Authorization', playerBearer);
    expect(db.query.mock.calls[0][0]).not.toMatch(/phone/);
  });

  test('admin request includes phone columns', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'p1', name: 'João', phone: '(415) 555-1234', phone_digits: '4155551234', picks: {}, locked: true }] });
    const res = await request(app).get('/api/players').set('Authorization', adminBearer);
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[0][0]).toMatch(/phone, phone_digits/);
  });
});
