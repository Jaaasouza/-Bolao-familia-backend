// World Cup 2026 group draw — canonical team names, identical to the frontend's
// web/src/data/teams.js and to teamAliases' CANONICAL list. Used to derive a
// match's group when the upstream feed (ESPN) doesn't label it.
const GROUPS = {
  A: ['Mexico', 'South Korea', 'South Africa', 'Czechia'],
  B: ['Canada', 'Switzerland', 'Qatar', 'Bosnia-Herzegovina'],
  C: ['Brazil', 'Morocco', 'Scotland', 'Haiti'],
  D: ['USA', 'Paraguay', 'Australia', 'Türkiye'],
  E: ['Germany', 'Ecuador', 'Ivory Coast', 'Curaçao'],
  F: ['Netherlands', 'Japan', 'Tunisia', 'Sweden'],
  G: ['Belgium', 'Iran', 'Egypt', 'New Zealand'],
  H: ['Spain', 'Uruguay', 'Saudi Arabia', 'Cape Verde'],
  I: ['France', 'Senegal', 'Norway', 'Iraq'],
  J: ['Argentina', 'Austria', 'Algeria', 'Jordan'],
  K: ['Portugal', 'Colombia', 'Uzbekistan', 'DR Congo'],
  L: ['England', 'Croatia', 'Panama', 'Ghana'],
};

const GROUP_KEYS = Object.keys(GROUPS);

// Canonical team name → group letter (e.g. 'Mexico' → 'A').
const TEAM_TO_GROUP = Object.fromEntries(
  GROUP_KEYS.flatMap((g) => GROUPS[g].map((t) => [t, g]))
);

module.exports = { GROUPS, GROUP_KEYS, TEAM_TO_GROUP };
