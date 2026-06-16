jest.mock('../src/db/pool');
jest.mock('../src/services/push', () => ({ sendChatMention: jest.fn().mockResolvedValue(1) }));

process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const db = require('../src/db/pool');
const { sendChatMention } = require('../src/services/push');
const { signToken } = require('../src/middleware/auth');
const { buildApp } = require('../src/app');

const app = buildApp();
const playerBearer = (pid = 'p_chat') => `Bearer ${signToken({ role: 'player', pid })}`;
const adminBearer = `Bearer ${signToken({ role: 'admin' })}`;

beforeEach(() => jest.clearAllMocks());

describe('GET /api/chat', () => {
  test('401 without a token', async () => {
    const res = await request(app).get('/api/chat');
    expect(res.status).toBe(401);
  });

  test('returns messages for a logged-in player', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 1, player_id: 'p1', name: 'Ana', body: 'oi', created_at: '2026-06-12T00:00:00Z' }] });
    const res = await request(app).get('/api/chat').set('Authorization', playerBearer());
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0]).toMatchObject({ name: 'Ana', body: 'oi' });
  });
});

describe('POST /api/chat', () => {
  test('rejects an empty message', async () => {
    const res = await request(app).post('/api/chat').set('Authorization', playerBearer('p_empty')).send({ body: '   ' });
    expect(res.status).toBe(400);
  });

  test('rejects an over-long message', async () => {
    const res = await request(app).post('/api/chat').set('Authorization', playerBearer('p_long')).send({ body: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });

  test('posts a message with the player name snapshot', async () => {
    db.query.mockImplementation((sql) => {
      if (/FROM players WHERE id/.test(sql)) return Promise.resolve({ rows: [{ name: 'João' }] });
      if (/INSERT INTO chat_messages/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 5, player_id: 'p_ok', name: 'João', body: 'olá pessoal', created_at: '2026-06-12T01:00:00Z' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).post('/api/chat').set('Authorization', playerBearer('p_ok')).send({ body: 'olá pessoal' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ name: 'João', body: 'olá pessoal' });
  });

  test('stores the chosen channel (ranking)', async () => {
    let insertParams = null;
    db.query.mockImplementation((sql, params) => {
      if (/FROM players WHERE id/.test(sql)) return Promise.resolve({ rows: [{ name: 'Ana' }] });
      if (/INSERT INTO chat_messages/.test(sql)) {
        insertParams = params;
        return Promise.resolve({ rows: [{ id: 9, player_id: 'p_r', name: 'Ana', body: 'oi rank', created_at: '2026-06-12T02:00:00Z' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).post('/api/chat').set('Authorization', playerBearer('p_r'))
      .send({ body: 'oi rank', channel: 'ranking' });
    expect(res.status).toBe(200);
    expect(insertParams[insertParams.length - 1]).toBe('ranking');
  });

  test('an unknown channel falls back to live', async () => {
    let insertParams = null;
    db.query.mockImplementation((sql, params) => {
      if (/FROM players WHERE id/.test(sql)) return Promise.resolve({ rows: [{ name: 'Bob' }] });
      if (/INSERT INTO chat_messages/.test(sql)) { insertParams = params; return Promise.resolve({ rows: [{ id: 10 }] }); }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).post('/api/chat').set('Authorization', playerBearer('p_b'))
      .send({ body: 'hey', channel: 'bogus' });
    expect(res.status).toBe(200);
    expect(insertParams[insertParams.length - 1]).toBe('live');
  });
});

describe('POST /api/chat mentions', () => {
  test('notifies mentioned players (excluding the author)', async () => {
    db.query.mockImplementation((sql) => {
      if (/FROM players WHERE id/.test(sql)) return Promise.resolve({ rows: [{ name: 'Ana' }] });
      if (/INSERT INTO chat_messages/.test(sql)) return Promise.resolve({ rows: [{ id: 1, body: 'oi @Bob' }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).post('/api/chat').set('Authorization', playerBearer('p_ana'))
      .send({ body: 'oi @Bob', mentions: ['p_bob', 'p_ana', 'p_bob'] });
    expect(res.status).toBe(200);
    // p_ana (author) excluded, p_bob deduped → one call
    expect(sendChatMention).toHaveBeenCalledTimes(1);
    expect(sendChatMention).toHaveBeenCalledWith('p_bob', 'Ana', 'oi @Bob');
  });
});

describe('GET /api/chat channel filter', () => {
  test('filters by channel param', async () => {
    let selParams = null;
    db.query.mockImplementation((sql, params) => { selParams = params; return Promise.resolve({ rows: [] }); });
    const res = await request(app).get('/api/chat?channel=ranking').set('Authorization', playerBearer());
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('ranking');
    expect(selParams[0]).toBe('ranking');
  });
});

describe('DELETE /api/chat/:id', () => {
  test('requires admin', async () => {
    const res = await request(app).delete('/api/chat/1').set('Authorization', playerBearer('p_x'));
    expect(res.status).toBe(403);
  });

  test('admin can delete', async () => {
    db.query.mockResolvedValue({ rowCount: 1 });
    const res = await request(app).delete('/api/chat/1').set('Authorization', adminBearer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});
