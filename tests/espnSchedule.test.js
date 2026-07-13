// Stub the DB-backed upsert so we can test the ESPN seeder's fetch + mapping in
// isolation (no Postgres / event bus needed).
jest.mock('../src/services/syncMatches', () => ({
  upsertMatches: jest.fn(async (matches) => ({ count: matches.length })),
}));

const { upsertMatches } = require('../src/services/syncMatches');
const {
  syncEspnSchedule, mapScheduleEvent, stageGroupFrom, scheduleStatus,
  datesFromCalendar, buildWindowDates, scheduleDates, reconcileThirdPlace,
} = require('../src/services/espnSchedule');

const groupEvent = {
  id: '704001', date: '2026-06-11T16:00Z', name: 'Brazil vs Croatia', shortName: 'BRA VS CRO',
  status: { type: { state: 'pre', name: 'STATUS_SCHEDULED' } },
  competitions: [{
    notes: [{ type: 'event', headline: 'Group A' }],
    status: { type: { state: 'pre' } },
    competitors: [
      { homeAway: 'home', team: { id: '1', displayName: 'Brazil' }, score: '' },
      { homeAway: 'away', team: { id: '2', displayName: 'Croatia' }, score: '' },
    ],
  }],
};

const koEvent = {
  id: '704050', date: '2026-07-01T20:00Z', name: 'France vs Spain', shortName: 'FRA VS ESP',
  status: { type: { state: 'post', name: 'STATUS_FULL_TIME' } },
  competitions: [{
    notes: [{ type: 'event', headline: 'Round of 16' }],
    status: { type: { state: 'post' } },
    competitors: [
      { homeAway: 'home', team: { id: '3', displayName: 'France' }, score: '2' },
      { homeAway: 'away', team: { id: '4', displayName: 'Spain' }, score: '1' },
    ],
  }],
};

describe('stageGroupFrom', () => {
  test('classifies group + round labels', () => {
    expect(stageGroupFrom('Group A')).toEqual({ stage: 'GROUP_STAGE', group_name: 'GROUP_A' });
    expect(stageGroupFrom('FIFA World Cup - Group L')).toEqual({ stage: 'GROUP_STAGE', group_name: 'GROUP_L' });
    expect(stageGroupFrom('Round of 32')).toMatchObject({ stage: 'LAST_32' });
    expect(stageGroupFrom('Round of 16')).toMatchObject({ stage: 'LAST_16' });
    expect(stageGroupFrom('Quarterfinal')).toMatchObject({ stage: 'QUARTER_FINALS' });
    expect(stageGroupFrom('Semifinal')).toMatchObject({ stage: 'SEMI_FINALS' });
    expect(stageGroupFrom('Third Place')).toMatchObject({ stage: 'THIRD_PLACE' });
    expect(stageGroupFrom('Final')).toMatchObject({ stage: 'FINAL' });
    expect(stageGroupFrom('whatever')).toBeNull();
  });
});

describe('scheduleStatus', () => {
  test('maps ESPN states to our statuses', () => {
    expect(scheduleStatus({ state: 'pre', name: 'STATUS_SCHEDULED' })).toBe('TIMED');
    expect(scheduleStatus({ state: 'in' })).toBe('IN_PLAY');
    expect(scheduleStatus({ state: 'post' })).toBe('FINISHED');
    expect(scheduleStatus({ name: 'STATUS_HALFTIME', state: 'in' })).toBe('PAUSED');
  });
});

describe('mapScheduleEvent', () => {
  test('maps a scheduled group game', () => {
    expect(mapScheduleEvent(groupEvent)).toMatchObject({
      id: 704001, espn_id: '704001', utc_date: '2026-06-11T16:00Z', status: 'TIMED',
      stage: 'GROUP_STAGE', group_name: 'GROUP_A', home_team: 'Brazil', away_team: 'Croatia',
      home_score: null, away_score: null, winner: null,
    });
  });

  test('maps a finished knockout game with a winner', () => {
    expect(mapScheduleEvent(koEvent)).toMatchObject({
      id: 704050, status: 'FINISHED', stage: 'LAST_16',
      home_team: 'France', away_team: 'Spain', home_score: 2, away_score: 1, winner: 'HOME_TEAM',
    });
  });

  test('derives the group from the draw when ESPN gives no label', () => {
    const unlabeled = {
      id: '704002', date: '2026-06-12T16:00Z',
      status: { type: { state: 'pre' } },
      competitions: [{
        notes: [],
        competitors: [
          { homeAway: 'home', team: { displayName: 'Mexico' }, score: '' },
          { homeAway: 'away', team: { displayName: 'South Africa' }, score: '' },
        ],
      }],
    };
    expect(mapScheduleEvent(unlabeled)).toMatchObject({
      stage: 'GROUP_STAGE', group_name: 'GROUP_A', home_team: 'Mexico', away_team: 'South Africa',
    });
  });

  test('returns null for a non-numeric id or missing competitors', () => {
    expect(mapScheduleEvent({ id: 'abc', competitions: [{ competitors: [] }] })).toBeNull();
    expect(mapScheduleEvent({ id: '5', competitions: [] })).toBeNull();
  });
});

describe('date helpers', () => {
  test('datesFromCalendar handles ISO strings and objects', () => {
    expect(datesFromCalendar({ leagues: [{ calendar: ['2026-06-11T16:00Z', '2026-06-12T16:00Z'] }] }))
      .toEqual(['20260611', '20260612']);
    expect(datesFromCalendar({ leagues: [{ calendar: [{ startDate: '2026-07-19T18:00Z' }] }] }))
      .toEqual(['20260719']);
    expect(datesFromCalendar({})).toEqual([]);
  });

  test('datesFromCalendar expands a startDate…endDate range to every day it spans', () => {
    expect(datesFromCalendar({ leagues: [{ calendar: [{ startDate: '2026-07-09T00:00Z', endDate: '2026-07-11T00:00Z' }] }] }))
      .toEqual(['20260709', '20260710', '20260711']);
  });

  test('buildWindowDates is inclusive day-by-day', () => {
    expect(buildWindowDates('20260611', '20260613')).toEqual(['20260611', '20260612', '20260613']);
    expect(buildWindowDates('20260613', '20260611')).toEqual([]);
  });

  test('scheduleDates always sweeps the full window, even when the calendar is sparse', () => {
    // ESPN calendar lists only opening day, but the knockout days must still be
    // fetched — otherwise a QF sitting on a day the calendar omits is dropped.
    const dates = scheduleDates({ leagues: [{ calendar: ['2026-06-11T16:00Z'] }] });
    expect(dates).toContain('20260611'); // group opener
    expect(dates).toContain('20260710'); // a quarter-final day the calendar never listed
    expect(dates).toContain('20260719'); // the final
  });
});

describe('reconcileThirdPlace', () => {
  const semi = (id, date) => ({ id, stage: 'SEMI_FINALS', group_name: null, utc_date: date });

  test('reclassifies the later of three semi-labelled fixtures as the third-place match', () => {
    const ms = [
      semi(1, '2026-07-14T18:00Z'), // real semi 1
      semi(2, '2026-07-15T18:00Z'), // real semi 2
      semi(3, '2026-07-18T18:00Z'), // third-place play-off (latest)
    ];
    reconcileThirdPlace(ms);
    expect(ms.find((m) => m.id === 3).stage).toBe('THIRD_PLACE');
    expect(ms.filter((m) => m.stage === 'SEMI_FINALS').map((m) => m.id).sort()).toEqual([1, 2]);
  });

  test('leaves a correctly-labelled bracket (exactly two semis) untouched', () => {
    const ms = [semi(1, '2026-07-14T18:00Z'), semi(2, '2026-07-15T18:00Z')];
    reconcileThirdPlace(ms);
    expect(ms.every((m) => m.stage === 'SEMI_FINALS')).toBe(true);
  });

  test('does nothing when a semi has no date (can not order safely)', () => {
    const ms = [semi(1, '2026-07-14T18:00Z'), semi(2, null), semi(3, '2026-07-18T18:00Z')];
    reconcileThirdPlace(ms);
    expect(ms.every((m) => m.stage === 'SEMI_FINALS')).toBe(true);
  });
});

describe('syncEspnSchedule', () => {
  afterEach(() => { delete global.fetch; jest.clearAllMocks(); });

  test('fetches the schedule and upserts the de-duplicated fixtures', async () => {
    const base = { leagues: [{ calendar: ['2026-06-11T16:00Z'] }], events: [groupEvent] };
    const day = { events: [groupEvent, koEvent] }; // groupEvent repeats → de-duped by id
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      json: async () => (String(url).includes('dates=') ? day : base),
    }));

    const res = await syncEspnSchedule('test');
    expect(res.count).toBe(2);
    expect(upsertMatches).toHaveBeenCalledTimes(1);
    const [rows] = upsertMatches.mock.calls[0];
    expect(rows.map((r) => r.id).sort()).toEqual([704001, 704050]);
  });

  test('captures a quarter-final on a day ESPN calendar never lists (regression)', async () => {
    // The calendar only names opening day; the QF sits on July 10. The old
    // calendar-only logic never fetched July 10 and dropped the fixture. Now the
    // full window is always swept, so the QF is seeded.
    const qf = {
      id: '704099', date: '2026-07-10T18:00Z', name: 'Argentina vs England',
      status: { type: { state: 'pre', name: 'STATUS_SCHEDULED' } },
      competitions: [{
        notes: [{ headline: 'Quarterfinal' }],
        competitors: [
          { homeAway: 'home', team: { displayName: 'Argentina' }, score: '' },
          { homeAway: 'away', team: { displayName: 'England' }, score: '' },
        ],
      }],
    };
    const base = { leagues: [{ calendar: ['2026-06-11T16:00Z'] }], events: [] };
    global.fetch = jest.fn(async (url) => {
      const m = /dates=(\d{8})/.exec(String(url));
      if (m && m[1] === '20260710') return { ok: true, json: async () => ({ events: [qf] }) };
      return { ok: true, json: async () => (m ? { events: [] } : base) };
    });

    await syncEspnSchedule('test');
    const [rows] = upsertMatches.mock.calls[0];
    expect(rows.map((r) => r.id)).toContain(704099);
    expect(rows.find((r) => r.id === 704099)).toMatchObject({ stage: 'QUARTER_FINALS' });
  });
});
