jest.mock('../src/db/pool');

process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const db = require('../src/db/pool');
const { buildApp } = require('../src/app');

const app = buildApp();
beforeEach(() => { jest.clearAllMocks(); });

describe('POST /api/auth/phone', () => {
  test('rejects an invalid phone', async () => {
    const res = await request(app).post('/api/auth/phone').send({ phone: '123' });
    expect(res.status).toBe(400);
  });

  test('returns a token for a returning player (matched by phone_digits)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'João Silva', phone_digits: '4155551234' }] });
    const res = await request(app).post('/api/auth/phone').send({ phone: '(415) 555-1234' });
    expect(res.status).toBe(200);
    expect(res.body.player).toEqual({ id: 'p1', name: 'João Silva' });
    expect(res.body.token).toBeTruthy();
    // no backfill needed (phone_digits already canonical)
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('self-heals phone_digits when it was missing/different', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'p2', name: 'Ana', phone_digits: null }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }); // UPDATE backfill
    const res = await request(app).post('/api/auth/phone').send({ phone: '14155559999' });
    expect(res.status).toBe(200);
    // second call is the backfill UPDATE with the canonical 10 digits
    const update = db.query.mock.calls[1];
    expect(update[0]).toMatch(/UPDATE players SET phone_digits/);
    expect(update[1]).toEqual(['4155559999', 'p2']);
  });

  test('404 when no player matches', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/api/auth/phone').send({ phone: '(212) 000-0000' });
    expect(res.status).toBe(404);
  });
});
