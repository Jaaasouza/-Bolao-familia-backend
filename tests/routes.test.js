jest.mock('../src/db/pool');

process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = 'secret123';

const request = require('supertest');
const db = require('../src/db/pool');
const { signToken } = require('../src/middleware/auth');
const { buildApp } = require('../src/app');

const app = buildApp();
const bearer = () => `Bearer ${signToken({ role: 'admin' })}`;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('health', () => {
  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});

describe('public reads', () => {
  test('GET /api/state aggregates matches/phases/standings', async () => {
    db.query.mockImplementation((sql) => {
      if (/FROM matches/.test(sql)) return Promise.resolve({ rows: [{ id: 1, home_team: 'A' }] });
      if (/FROM phases/.test(sql)) return Promise.resolve({ rows: [{ team_name: 'Brazil', phase: 'group' }] });
      if (/FROM standings/.test(sql)) return Promise.resolve({ rows: [{ group_name: 'A', first_team: 'Brazil', second_team: 'Mexico' }] });
      if (/sync_state/.test(sql)) return Promise.resolve({ rows: [{ value: { at: 1, count: 1 } }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get('/api/state');
    expect(res.status).toBe(200);
    expect(res.body.phases).toEqual({ Brazil: 'group' });
    expect(res.body.standings).toEqual({ A: { first: 'Brazil', second: 'Mexico' } });
    expect(res.body.matches).toHaveLength(1);
  });
});

describe('auth', () => {
  test('login rejects a bad password', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'nope' });
    expect(res.status).toBe(401);
  });

  test('login issues an admin token', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'secret123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.role).toBe('admin');
  });

  test('mutating endpoint is rejected without a token', async () => {
    const res = await request(app).post('/api/phases').send({ Brazil: 'r16' });
    expect(res.status).toBe(401);
  });

  test('mutating endpoint is rejected with a bad token', async () => {
    const res = await request(app)
      .post('/api/phases')
      .set('Authorization', 'Bearer garbage')
      .send({ Brazil: 'r16' });
    expect(res.status).toBe(401);
  });
});

describe('mutations go through the event bus', () => {
  test('POST /api/phases writes phases + audit inside a transaction', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.getClient.mockResolvedValue(client);

    const res = await request(app)
      .post('/api/phases')
      .set('Authorization', bearer())
      .send({ Brazil: 'r16' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 1 });

    const queries = client.query.mock.calls.map((c) => c[0]);
    expect(queries[0]).toBe('BEGIN');
    expect(queries.some((q) => q.includes('INSERT INTO phases'))).toBe(true);
    expect(queries.some((q) => q.includes('audit_log'))).toBe(true);
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });

  test('POST /api/players requires an id', async () => {
    const res = await request(app)
      .post('/api/players')
      .set('Authorization', bearer())
      .send({ name: 'no id' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/my-score-picks — session validity', () => {
  const playerBearer = (pid) => `Bearer ${signToken({ role: 'player', pid })}`;

  test('401 when the player no longer exists (deleted by admin)', async () => {
    db.query.mockImplementation((sql) => {
      if (/FROM players WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app)
      .get('/api/my-score-picks')
      .set('Authorization', playerBearer('p_gone'));
    expect(res.status).toBe(401);
  });

  test('200 when the player still exists', async () => {
    db.query.mockImplementation((sql) => {
      if (/FROM players WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app)
      .get('/api/my-score-picks')
      .set('Authorization', playerBearer('p_ok'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('picks');
  });
});
