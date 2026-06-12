// Stub the DB-backed upsert so we can test the ESPN seeder's fetch + mapping in
// isolation (no Postgres / event bus needed).
jest.mock('../src/services/syncMatches', () => ({
  upsertMatches: jest.fn(async (matches) => ({ count: matches.length })),
}));

const { upsertMatches } = require('../src/services/syncMatches');
const {
  syncEspnSchedule, mapScheduleEvent, stageGroupFrom, scheduleStatus,
  datesFromCalendar, buildWindowDates,
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

  test('buildWindowDates is inclusive day-by-day', () => {
    expect(buildWindowDates('20260611', '20260613')).toEqual(['20260611', '20260612', '20260613']);
    expect(buildWindowDates('20260613', '20260611')).toEqual([]);
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
});
