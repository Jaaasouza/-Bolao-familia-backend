jest.mock('../src/db/pool');

process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = 'secret123';

const request = require('supertest');
const db = require('../src/db/pool');
const { buildApp } = require('../src/app');
const { clearCache } = require('../src/services/deadline');

const app = buildApp();
const VALID = {
  name: 'Joao',
  phone: '(415) 555-1234',
  picks: { firsts: { A: 'Mexico' }, seconds: {}, champion: 'Brazil' },
};

beforeEach(() => {
  jest.clearAllMocks();
  clearCache(); // deadline service caches for 10s; reset between tests
  // app_config lookup (deadline) returns nothing → registration open.
  db.query.mockResolvedValue({ rows: [] });
});

describe('POST /api/register (public self-registration)', () => {
  test('requires name, phone and picks', async () => {
    let res = await request(app).post('/api/register').send({ picks: {}, phone: VALID.phone });
    expect(res.status).toBe(400);
    res = await request(app).post('/api/register').send({ name: 'Joao', phone: VALID.phone });
    expect(res.status).toBe(400);
    // missing phone
    res = await request(app).post('/api/register').send({ name: 'Joao', picks: { firsts: {} } });
    expect(res.status).toBe(400);
  });

  test('rejects an invalid US phone', async () => {
    const res = await request(app).post('/api/register').send({ ...VALID, phone: '123' });
    expect(res.status).toBe(400);
  });

  test('creates and locks a new player (no admin token needed)', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.getClient.mockResolvedValue(client);

    const res = await request(app).post('/api/register').send(VALID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, locked: true });

    const queries = client.query.mock.calls.map((c) => c[0]);
    expect(queries[0]).toBe('BEGIN');
    expect(queries.some((q) => q.includes('INSERT INTO players'))).toBe(true);
    expect(queries.some((q) => q.includes('audit_log'))).toBe(true);
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });

  test('rejects only a DIFFERENT locked player holding another phone', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'p_1', locked: true, phone_digits: '2125550000' }] });
    const res = await request(app).post('/api/register').send(VALID);
    expect(res.status).toBe(409);
  });

  test('claims a locked player that has no phone yet (admin pre-added)', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.getClient.mockResolvedValue(client);
    // existing-match lookup → a locked, phone-less player with the same name
    db.query.mockResolvedValueOnce({ rows: [] });                                  // isPastDeadline
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p_admin', locked: true, phone_digits: null }] });
    const res = await request(app).post('/api/register').send(VALID);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 'p_admin' });
  });

  test('re-registering the SAME phone refreshes instead of blocking', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.getClient.mockResolvedValue(client);
    db.query.mockResolvedValueOnce({ rows: [] });                                  // isPastDeadline
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p_me', locked: true, phone_digits: '4155551234' }] });
    const res = await request(app).post('/api/register').send(VALID);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 'p_me' });
  });
});

describe('POST /api/matches/:id/upset (admin)', () => {
  test('requires admin auth', async () => {
    const res = await request(app).post('/api/matches/1/upset').send({ upset: true });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/config', () => {
  test('returns the deadline + registrationOpen', async () => {
    db.query.mockResolvedValue({ rows: [{ value: '2099-01-01T00:00:00.000Z' }] });
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.registrationOpen).toBe(true);
    expect(res.body.picksDeadline).toBe('2099-01-01T00:00:00.000Z');
  });
});
