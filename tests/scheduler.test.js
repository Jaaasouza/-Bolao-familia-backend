jest.mock('../src/db/pool');
const db = require('../src/db/pool');
const { nextDelay } = require('../src/scheduler');

const minutes = (n) => new Date(Date.now() + n * 60_000).toISOString();

describe('adaptive scheduler nextDelay', () => {
  test('LIVE match → fast (7s)', async () => {
    db.query.mockResolvedValue({ rows: [{ status: 'IN_PLAY', utc_date: minutes(-30) }] });
    const { delay, reason } = await nextDelay();
    expect(reason).toBe('live');
    expect(delay).toBe(5_000);
  });

  test('kickoff within 15 min → soon (20s)', async () => {
    db.query.mockResolvedValue({ rows: [{ status: 'TIMED', utc_date: minutes(10) }] });
    const { delay, reason } = await nextDelay();
    expect(reason).toBe('kickoff-soon');
    expect(delay).toBe(15_000);
  });

  test('a match later today, none live → gameday (5 min)', async () => {
    db.query.mockResolvedValue({ rows: [{ status: 'TIMED', utc_date: minutes(180) }] });
    const { delay, reason } = await nextDelay();
    expect(reason).toBe('gameday');
    expect(delay).toBe(5 * 60_000);
  });

  test('no matches in the window → idle (30 min)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const { delay, reason } = await nextDelay();
    expect(reason).toBe('idle');
    expect(delay).toBe(30 * 60_000);
  });

  test('DB error → safe fallback', async () => {
    db.query.mockRejectedValue(new Error('boom'));
    const { reason } = await nextDelay();
    expect(reason).toBe('fallback');
  });
});

const { isQuiet } = require('../src/scheduler');
describe('isQuiet (secondary-sync gate)', () => {
  test('blocks standings/scorers while live or kickoff-soon', () => {
    expect(isQuiet('live')).toBe(false);
    expect(isQuiet('kickoff-soon')).toBe(false);
  });
  test('allows them when quiet', () => {
    expect(isQuiet('gameday')).toBe(true);
    expect(isQuiet('idle')).toBe(true);
    expect(isQuiet('fallback')).toBe(true);
  });
});
