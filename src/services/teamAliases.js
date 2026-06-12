// Canonical team names (the 48 WC2026 teams, matching the frontend) plus a
// normalizer that maps football-data.org's naming to ours. football-data uses
// names like "Korea Republic", "IR Iran", "Côte d'Ivoire" — we resolve those to
// the canonical names the pool's picks/phases/standings use.

const CANONICAL = [
  'Mexico', 'South Korea', 'South Africa', 'Czechia',
  'Canada', 'Switzerland', 'Qatar', 'Bosnia-Herzegovina',
  'Brazil', 'Morocco', 'Scotland', 'Haiti',
  'USA', 'Paraguay', 'Australia', 'Türkiye',
  'Germany', 'Ecuador', 'Ivory Coast', 'Curaçao',
  'Netherlands', 'Japan', 'Tunisia', 'Sweden',
  'Belgium', 'Iran', 'Egypt', 'New Zealand',
  'Spain', 'Uruguay', 'Saudi Arabia', 'Cape Verde',
  'France', 'Senegal', 'Norway', 'Iraq',
  'Argentina', 'Austria', 'Algeria', 'Jordan',
  'Portugal', 'Colombia', 'Uzbekistan', 'DR Congo',
  'England', 'Croatia', 'Panama', 'Ghana',
];

// canonical -> list of alternative names seen from the API / common variants.
const ALIASES = {
  'South Korea': ['Korea Republic', 'Republic of Korea', 'Korea', 'KOR'],
  'Iran': ['IR Iran', 'Islamic Republic of Iran'],
  'Ivory Coast': ["Côte d'Ivoire", "Cote d'Ivoire", 'Cote dIvoire'],
  'USA': ['United States', 'United States of America', 'US'],
  'Türkiye': ['Turkey', 'Turkiye'],
  'Czechia': ['Czech Republic'],
  'Bosnia-Herzegovina': ['Bosnia and Herzegovina', 'Bosnia & Herzegovina', 'Bosnia'],
  'DR Congo': ['Congo DR', 'Democratic Republic of Congo', 'DR Congo', 'Congo'],
  'Cape Verde': ['Cabo Verde'],
  'Curaçao': ['Curacao'],
  'Saudi Arabia': ['KSA'],
  'Netherlands': ['Holland'],
};

function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // strip punctuation/spaces
}

// Build a normalized lookup: every canonical name + every alias → canonical.
const LOOKUP = new Map();
for (const team of CANONICAL) LOOKUP.set(normalize(team), team);
for (const [canonical, aliases] of Object.entries(ALIASES)) {
  for (const a of aliases) LOOKUP.set(normalize(a), canonical);
}

// Resolve any incoming team name to our canonical name. Falls back to the
// original string when there's no known mapping (so unknown teams still display).
function resolveTeamName(name) {
  if (!name) return name;
  return LOOKUP.get(normalize(name)) || name;
}

module.exports = { CANONICAL, resolveTeamName, normalize };
