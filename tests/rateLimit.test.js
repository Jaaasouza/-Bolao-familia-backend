jest.mock('../src/db/pool');

process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = 'secret123';
// Tight bucket for tests so we can trip the limit fast.
process.env.LOGIN_RATE_MAX = '3';
process.env.LOGIN_RATE_WINDOW_MS = '60000';

const request = require('supertest');
const { createRateLimiter } = require('../src/middleware/rateLimit');

// Build a fresh app per test so the in-memory limiter state isn't shared
// between cases. The login limiter is created when ./routes/auth.js is first
// required; jest.resetModules() clears the require cache so it gets a new one.
function freshApp() {
  jest.resetModules();
  process.env.LOGIN_RATE_MAX = '3';
  process.env.LOGIN_RATE_WINDOW_MS = '60000';
  return require('../src/app').buildApp();
}

describe('login rate limit', () => {
  test('lets the first N attempts through (within window)', async () => {
    const app = freshApp();
    // 3 failed attempts → all return 401, not 429
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/auth/login').send({ password: 'wrong' });
      expect(res.status).toBe(401);
    }
  });

  test('blocks the next attempt with 429 + Retry-After', async () => {
    const app = freshApp();
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/auth/login').send({ password: 'wrong' });
    }
    const res = await request(app).post('/api/auth/login').send({ password: 'wrong' });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/too many/i);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBeTruthy();
  });

  test('a successful login resets the counter', async () => {
    const app = freshApp();
    await request(app).post('/api/auth/login').send({ password: 'wrong' });
    await request(app).post('/api/auth/login').send({ password: 'wrong' });
    // Correct login resets the bucket for this IP.
    const ok = await request(app).post('/api/auth/login').send({ password: 'secret123' });
    expect(ok.status).toBe(200);
    // Now we can fail 3 more times before hitting 429.
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/auth/login').send({ password: 'wrong' });
      expect(res.status).toBe(401);
    }
    const fourth = await request(app).post('/api/auth/login').send({ password: 'wrong' });
    expect(fourth.status).toBe(429);
  });

  test('does not block correct password before the cap', async () => {
    const app = freshApp();
    const res = await request(app).post('/api/auth/login').send({ password: 'secret123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });
});

describe('createRateLimiter (unit)', () => {
  test('respects custom keyFn', (done) => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60000, keyFn: (req) => req.headers['x-user'] });
    const req1 = { headers: { 'x-user': 'alice' }, ip: '1.1.1.1' };
    const req2 = { headers: { 'x-user': 'alice' }, ip: '2.2.2.2' };
    const res2 = { set: jest.fn(), status: jest.fn(() => res2), json: jest.fn() };

    limiter(req1, { set: jest.fn(), status: jest.fn(), json: jest.fn() }, () => {
      req1.rateLimit.recordFailure();
      limiter(req2, res2, () => {
        throw new Error('should have been blocked — same key (alice) across IPs');
      });
      expect(res2.status).toHaveBeenCalledWith(429);
      done();
    });
  });
});
