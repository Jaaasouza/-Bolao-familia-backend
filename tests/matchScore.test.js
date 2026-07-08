jest.mock('../src/db/pool');
jest.mock('../src/services/push', () => ({ notifyMatchEvents: jest.fn().mockResolvedValue({ events: 0 }) }));

process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const db = require('../src/db/pool');
const { signToken } = require('../src/middleware/auth');
const { buildApp } = require('../src/app');

const app = buildApp();
const adminBearer = `Bearer ${signToken({ role: 'admin' })}`;

// Endpoint now looks up the match's stage before deciding the winner. Return a
// stage stub per test via db.query.mockResolvedValue([...]).
function stubStage(stage) {
  db.query.mockResolvedValue({ rows: [{ stage }] });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.getClient.mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() });
  stubStage('GROUP_STAGE');
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

  test('FINISHED derives the winner from a decisive scoreline', async () => {
    const res = await request(app).post('/api/matches/1/score').set('Authorization', adminBearer).send({ home: 2, away: 1, status: 'FINISHED' });
    expect(res.body).toMatchObject({ status: 'FINISHED', winner: 'HOME_TEAM' });
  });

  test('group stage 0-0 FINISHED → DRAW', async () => {
    stubStage('GROUP_STAGE');
    const res = await request(app).post('/api/matches/1/score').set('Authorization', adminBearer).send({ home: 0, away: 0, status: 'FINISHED' });
    expect(res.body.winner).toBe('DRAW');
  });

  test('knockout 0-0 FINISHED without winner override → winner NULL (never DRAW)', async () => {
    stubStage('LAST_16');
    const res = await request(app).post('/api/matches/1/score').set('Authorization', adminBearer).send({ home: 0, away: 0, status: 'FINISHED' });
    expect(res.body.winner).toBeNull();
  });

  test('knockout 0-0 FINISHED with winner=HOME_TEAM override pins the shootout winner', async () => {
    stubStage('QUARTER_FINALS');
    const res = await request(app).post('/api/matches/1/score').set('Authorization', adminBearer)
      .send({ home: 0, away: 0, status: 'FINISHED', winner: 'HOME_TEAM' });
    expect(res.body.winner).toBe('HOME_TEAM');
  });

  test('knockout 0-0 FINISHED with winner=DRAW override is refused (stays NULL)', async () => {
    stubStage('SEMI_FINALS');
    const res = await request(app).post('/api/matches/1/score').set('Authorization', adminBearer)
      .send({ home: 0, away: 0, status: 'FINISHED', winner: 'DRAW' });
    expect(res.body.winner).toBeNull();
  });

  test('winner override that contradicts the scoreline is ignored (falls back to scoreline)', async () => {
    stubStage('LAST_16');
    // 2-1 with an AWAY_TEAM override would be inconsistent → ignore override,
    // fall back to HOME_TEAM from the scoreline.
    const res = await request(app).post('/api/matches/1/score').set('Authorization', adminBearer)
      .send({ home: 2, away: 1, status: 'FINISHED', winner: 'AWAY_TEAM' });
    expect(res.body.winner).toBe('HOME_TEAM');
  });

  test('rejects negative scores', async () => {
    const res = await request(app).post('/api/matches/1/score').set('Authorization', adminBearer).send({ home: -1, away: 0 });
    expect(res.status).toBe(400);
  });
});
