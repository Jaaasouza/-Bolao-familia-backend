jest.mock('../src/db/pool');

const db = require('../src/db/pool');
const { mapEspnEvent, mapStatus, parseMinute, overlayEspnLive } = require('../src/services/espnLive');

afterEach(() => { delete global.fetch; jest.clearAllMocks(); });

// Minimal ESPN scoreboard event factory.
function espnEvent({ home, away, hs, as, state = 'in', name = 'STATUS_IN_PROGRESS', clock = "62'", details, homePen, awayPen }) {
  return {
    status: { type: { state, name }, displayClock: clock },
    competitions: [{
      details,
      competitors: [
        { homeAway: 'home', score: String(hs), team: { id: 'H', displayName: home }, ...(homePen != null ? { shootoutScore: homePen } : {}) },
        { homeAway: 'away', score: String(as), team: { id: 'A', displayName: away }, ...(awayPen != null ? { shootoutScore: awayPen } : {}) },
      ],
    }],
  };
}

describe('mapStatus / parseMinute', () => {
  test('maps ESPN states to football-data style', () => {
    expect(mapStatus({ state: 'in', name: 'STATUS_IN_PROGRESS' })).toBe('IN_PLAY');
    expect(mapStatus({ state: 'in', name: 'STATUS_HALFTIME' })).toBe('PAUSED');
    expect(mapStatus({ state: 'post', name: 'STATUS_FULL_TIME' })).toBe('FINISHED');
    expect(mapStatus({ state: 'pre', name: 'STATUS_SCHEDULED' })).toBe(null);
  });

  test("parses \"62'\" and \"45'+2\"", () => {
    expect(parseMinute("62'")).toBe(62);
    expect(parseMinute("45'+2")).toBe(45);
    expect(parseMinute('')).toBe(null);
  });
});

describe('mapEspnEvent', () => {
  test('maps a live event with canonical team names', () => {
    const ev = mapEspnEvent(espnEvent({ home: 'United States', away: 'Czech Republic', hs: 1, as: 0 }));
    expect(ev).toMatchObject({ home: 'USA', away: 'Czechia', homeScore: 1, awayScore: 0, status: 'IN_PLAY', minute: 62 });
  });

  test('keeps pre-game events with status null (to capture the ESPN id)', () => {
    const ev = mapEspnEvent({ id: '999', ...espnEvent({ home: 'Mexico', away: 'South Africa', hs: 0, as: 0, state: 'pre', name: 'STATUS_SCHEDULED' }) });
    expect(ev.status).toBe(null);
    expect(ev.espnId).toBe('999');
    expect(ev.home).toBe('Mexico');
  });

  test('parses goals + cards from details (sorted by minute, canonical teams)', () => {
    const ev = mapEspnEvent(espnEvent({
      home: 'Mexico', away: 'South Africa', hs: 1, as: 0,
      details: [
        { type: { text: 'Yellow Card' }, clock: { displayValue: "40'" }, team: { id: 'A' }, athletesInvolved: [{ displayName: 'Mokoena' }] },
        { type: { text: 'Goal' }, clock: { displayValue: "23'" }, team: { id: 'H' }, athletesInvolved: [{ displayName: 'Raúl Jiménez' }] },
        { type: { text: 'Substitution' }, clock: { displayValue: "60'" }, team: { id: 'H' } },
      ],
    }));
    expect(ev.liveEvents.events).toEqual([
      { kind: 'goal', minute: 23, team: 'Mexico', player: 'Raúl Jiménez' },
      { kind: 'yellow', minute: 40, team: 'South Africa', player: 'Mokoena' },
    ]);
  });

  test('parses a penalty shootout result', () => {
    const ev = mapEspnEvent(espnEvent({
      home: 'Brazil', away: 'Morocco', hs: 1, as: 1,
      state: 'post', name: 'STATUS_FULL_TIME', homePen: 4, awayPen: 3,
    }));
    expect(ev.liveEvents.pens).toEqual({ home: 4, away: 3, winner: 'Brazil' });
  });
});

describe('overlayEspnLive', () => {
  const liveRow = {
    id: 537327, home_team: 'Mexico', away_team: 'South Africa',
    status: 'TIMED', home_score: null, away_score: null, manual_score: false,
  };

  test('updates a matched live game (score + status)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [espnEvent({ home: 'Mexico', away: 'South Africa', hs: 1, as: 0 })] }),
    });
    db.query
      .mockResolvedValueOnce({ rows: [liveRow] }) // candidates
      .mockResolvedValue({ rows: [] });           // UPDATE
    const r = await overlayEspnLive();
    expect(r.updated).toBe(1);
    const update = db.query.mock.calls[1];
    expect(update[0]).toMatch(/UPDATE matches/);
    expect(update[1].slice(0, 7)).toEqual([537327, 'IN_PLAY', 1, 0, null, 62, null]); // no events on the scoreboard → live_events left as-is
  });

  test('never touches a manual_score match', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [espnEvent({ home: 'Mexico', away: 'South Africa', hs: 5, as: 5 })] }),
    });
    db.query.mockResolvedValueOnce({ rows: [{ ...liveRow, manual_score: true }] });
    const r = await overlayEspnLive();
    expect(r.updated).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1); // only the SELECT
  });

  test('FINISHED event derives the winner', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [espnEvent({ home: 'Mexico', away: 'South Africa', hs: 2, as: 1, state: 'post', name: 'STATUS_FULL_TIME', clock: "90'" })] }),
    });
    db.query
      .mockResolvedValueOnce({ rows: [{ ...liveRow, status: 'IN_PLAY', home_score: 1, away_score: 1 }] })
      .mockResolvedValue({ rows: [] });
    const r = await overlayEspnLive();
    expect(r.updated).toBe(1);
    expect(db.query.mock.calls[1][1].slice(0, 6)).toEqual([537327, 'FINISHED', 2, 1, 'HOME_TEAM', null]);
  });

  test('recovers a wrongly-finished game when ESPN still reports it live', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [espnEvent({ home: 'Mexico', away: 'South Africa', hs: 1, as: 1 })] }),
    });
    db.query
      .mockResolvedValueOnce({ rows: [{ ...liveRow, status: 'FINISHED', home_score: 1, away_score: 1 }] })
      .mockResolvedValue({ rows: [] });
    const r = await overlayEspnLive();
    expect(r.updated).toBe(1);
    expect(db.query.mock.calls[1][0]).toMatch(/UPDATE matches/);
    expect(db.query.mock.calls[1][1][1]).toBe('IN_PLAY'); // brought back from FINISHED
  });

  test('leaves a genuinely finished game alone (ESPN also FINISHED)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [espnEvent({ home: 'Mexico', away: 'South Africa', hs: 2, as: 1, state: 'post', name: 'STATUS_FULL_TIME' })] }),
    });
    db.query.mockResolvedValueOnce({ rows: [{ ...liveRow, status: 'FINISHED', home_score: 2, away_score: 1 }] });
    const r = await overlayEspnLive();
    expect(r.updated).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1); // SELECT only — no UPDATE
  });

  test('captures the ESPN id for a not-yet-started game (for lineups)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [{ id: 'E1', ...espnEvent({ home: 'Mexico', away: 'South Africa', hs: 0, as: 0, state: 'pre', name: 'STATUS_SCHEDULED' }) }] }),
    });
    db.query
      .mockResolvedValueOnce({ rows: [{ ...liveRow, espn_id: null }] }) // candidates
      .mockResolvedValue({ rows: [] });
    const r = await overlayEspnLive();
    expect(r.matched).toBe(1);
    expect(r.updated).toBe(0); // pre-game: no score/status change
    const upd = db.query.mock.calls[1];
    expect(upd[0]).toMatch(/SET espn_id = \$2/);
    expect(upd[1]).toEqual([537327, 'E1']);
  });

  test('espn outage is swallowed (loop keeps running)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('boom'));
    const r = await overlayEspnLive();
    expect(r.updated).toBe(0);
    expect(r.error).toBe('boom');
  });

  test('logs unmatched ESPN fixtures to sync_state (alias gap diagnostic)', async () => {
    // ESPN reports a fixture whose team names normalize to something the DB
    // doesn't have — typical when teamAliases.js is missing a country.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        events: [
          espnEvent({ home: 'Mexico', away: 'South Africa', hs: 1, as: 0 }),
          espnEvent({ home: 'Atlantis', away: 'Wakanda', hs: 2, as: 2 }), // no DB row matches
        ],
      }),
    });
    // Candidate matches: only Mexico vs South Africa is in the DB.
    db.query
      .mockResolvedValueOnce({ rows: [liveRow] }) // SELECT candidates
      .mockResolvedValue({ rows: [] });           // UPDATE + sync_state insert

    const r = await overlayEspnLive();
    expect(r.matched).toBe(1);
    expect(r.unmatched).toBe(1);

    const calls = db.query.mock.calls.map((c) => c[0]);
    const insert = calls.find((sql) => /last_unmatched_espn/.test(sql));
    expect(insert).toBeTruthy();

    // The payload should name the orphan fixture.
    const insertCall = db.query.mock.calls.find((c) => /last_unmatched_espn/.test(c[0]));
    const value = JSON.parse(insertCall[1][0]);
    expect(value.count).toBe(1);
    expect(value.fixtures[0].home).toBe('Atlantis');
    expect(value.fixtures[0].away).toBe('Wakanda');
  });

  test('does not write last_unmatched_espn when every fixture pairs', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [espnEvent({ home: 'Mexico', away: 'South Africa', hs: 1, as: 0 })] }),
    });
    db.query
      .mockResolvedValueOnce({ rows: [liveRow] })
      .mockResolvedValue({ rows: [] });

    await overlayEspnLive();

    const calls = db.query.mock.calls.map((c) => c[0]);
    expect(calls.some((sql) => /last_unmatched_espn/.test(sql))).toBe(false);
  });
});
