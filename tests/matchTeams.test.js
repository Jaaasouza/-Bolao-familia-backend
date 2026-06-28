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
  db.query.mockResolvedValue({ rows: [{ id: 537415, home_team: 'Germany', away_team: null }] });
  db.getClient.mockResolvedValue({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  });
});

describe('POST /api/matches/:id/teams', () => {
  test('requires admin', async () => {
    const res = await request(app).post('/api/matches/537415/teams').send({ home: 'Germany', away: 'Brazil' });
    expect(res.status).toBe(401);
  });

  test('sets both teams and pins manual_teams=true', async () => {
    const res = await request(app)
      .post('/api/matches/537415/teams')
      .set('Authorization', adminBearer)
      .send({ home: 'Germany', away: 'Brazil' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true, id: 537415, home_team: 'Germany', away_team: 'Brazil', manual: true,
    });

    const client = await db.getClient.mock.results[0].value;
    const calls = client.query.mock.calls.map((c) => c[0]);
    expect(calls.some((sql) => /UPDATE matches/i.test(sql) && /manual_teams = \$4/.test(sql))).toBe(true);
    // bound params: [id, home, away, manual]
    const upd = client.query.mock.calls.find((c) => /UPDATE matches/.test(c[0]));
    expect(upd[1]).toEqual([537415, 'Germany', 'Brazil', true]);
  });

  test('preserves the existing side when only one is provided', async () => {
    // Existing row: Germany vs null. We pass only `away`; home stays.
    const res = await request(app)
      .post('/api/matches/537415/teams')
      .set('Authorization', adminBearer)
      .send({ away: 'Brazil' });
    expect(res.status).toBe(200);
    expect(res.body.home_team).toBe('Germany');
    expect(res.body.away_team).toBe('Brazil');

    const client = await db.getClient.mock.results[0].value;
    const upd = client.query.mock.calls.find((c) => /UPDATE matches/.test(c[0]));
    expect(upd[1].slice(0, 3)).toEqual([537415, 'Germany', 'Brazil']);
  });

  test('clears a side when explicitly passed empty string + manual=false', async () => {
    const res = await request(app)
      .post('/api/matches/537415/teams')
      .set('Authorization', adminBearer)
      .send({ away: 'Brazil', manual: false });
    expect(res.body.manual).toBe(false);
  });

  test('rejects when neither team is provided', async () => {
    const res = await request(app)
      .post('/api/matches/537415/teams')
      .set('Authorization', adminBearer)
      .send({});
    expect(res.status).toBe(400);
  });

  test('404 when the match does not exist', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post('/api/matches/999/teams')
      .set('Authorization', adminBearer)
      .send({ home: 'Brazil', away: 'Japan' });
    expect(res.status).toBe(404);
  });

  test('records via the event bus (audit_log)', async () => {
    await request(app)
      .post('/api/matches/537415/teams')
      .set('Authorization', adminBearer)
      .send({ home: 'Germany', away: 'Brazil' });
    const client = await db.getClient.mock.results[0].value;
    const calls = client.query.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe('BEGIN');
    expect(calls.some((q) => q.includes('audit_log'))).toBe(true);
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });
});
