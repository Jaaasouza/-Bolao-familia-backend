#!/usr/bin/env node
//
// Bulk-fill knockout team assignments (R32 / R16 / QF / SF / 3rd / Final).
//
// Background: football-data leaves home_team / away_team null on knockout
// fixtures until it propagates the bracket from the group standings, and that
// can lag by hours/days after a group finishes. While we wait, players can't
// pick those games. This script accepts a JSON file describing the bracket and
// POSTs every fixture to /api/matches/:id/teams (the admin endpoint added in
// the v19 migration), which pins the names as manual_teams = TRUE so the next
// sync doesn't overwrite them.
//
// Input file shape (knockout-template.json next to this script):
//
//   {
//     "stage": "LAST_32",          // free text; only used for the printout
//     "assignments": [
//       { "id": 537417, "home": "South Africa", "away": "Canada" },
//       { "id": 537415, "home": "Germany",       "away": "Ivory Coast" },
//       ...
//     ]
//   }
//
//   - id   = the match id from GET /api/matches (don't guess; copy from the API)
//   - home = canonical team name (the names listed in services/teamAliases.js
//            CANONICAL — e.g. "USA", "Türkiye", "Czechia"; check there first)
//   - away = canonical team name
//
// Usage:
//
//   BACKEND=https://<backend>.up.railway.app \
//   ADMIN_TOKEN=<JWT from /api/auth/login> \
//   node scripts/fill-knockout-teams.js scripts/knockout-template.json
//
//   # Dry-run (no POST) — prints the plan:
//   node scripts/fill-knockout-teams.js scripts/knockout-template.json --dry
//
// The script will SKIP any fixture whose teams already match the request
// (idempotent — safe to re-run). On 4xx/5xx it stops and reports the failure;
// nothing it already wrote is rolled back, but every change is audit-logged.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY = args.includes('--dry') || args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('usage: node scripts/fill-knockout-teams.js <bracket.json> [--dry]');
  process.exit(2);
}

const BACKEND = process.env.BACKEND || process.env.BACKEND_URL;
const TOKEN = process.env.ADMIN_TOKEN;
if (!BACKEND) {
  console.error('Missing BACKEND env var (e.g. https://<your>.up.railway.app)');
  process.exit(2);
}
if (!DRY && !TOKEN) {
  console.error('Missing ADMIN_TOKEN env var (admin JWT). Get one with:');
  console.error("  curl -s -X POST $BACKEND/api/auth/login \\");
  console.error('    -H "Content-Type: application/json" -d \'{"password":"<your-pin>"}\' | jq -r .token');
  process.exit(2);
}

const bracket = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
if (!Array.isArray(bracket.assignments) || !bracket.assignments.length) {
  console.error('No assignments in input file.');
  process.exit(2);
}

async function fetchMatch(id) {
  const res = await fetch(`${BACKEND}/api/matches`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /api/matches → ${res.status}`);
  const { matches } = await res.json();
  return matches.find((m) => String(m.id) === String(id)) || null;
}

async function setTeams(id, home, away) {
  const res = await fetch(`${BACKEND}/api/matches/${id}/teams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ home, away, manual: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`POST /api/matches/${id}/teams → ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

(async () => {
  console.log(`Mode: ${DRY ? 'DRY-RUN' : 'APPLY'}`);
  console.log(`Stage: ${bracket.stage || '(unspecified)'}`);
  console.log(`Backend: ${BACKEND}`);
  console.log(`Assignments: ${bracket.assignments.length}`);
  console.log('');

  let setCount = 0;
  let skipCount = 0;
  for (const a of bracket.assignments) {
    const current = await fetchMatch(a.id);
    if (!current) {
      console.log(`  [MISS] id=${a.id} not in /api/matches — skipping`);
      skipCount += 1;
      continue;
    }
    const already = current.home_team === a.home && current.away_team === a.away;
    if (already) {
      console.log(`  [SKIP] id=${a.id} already ${a.home} vs ${a.away}`);
      skipCount += 1;
      continue;
    }
    console.log(`  [${DRY ? 'PLAN' : ' SET'}] id=${a.id}  ${current.home_team || '?'} vs ${current.away_team || '?'}  →  ${a.home} vs ${a.away}`);
    if (!DRY) {
      try {
        await setTeams(a.id, a.home, a.away);
        setCount += 1;
      } catch (e) {
        console.error(`  [ERR] ${e.message}`);
        process.exit(1);
      }
    } else {
      setCount += 1;
    }
  }

  console.log('');
  console.log('Summary');
  console.log('  set     :', setCount);
  console.log('  skipped :', skipCount);
  if (DRY) console.log('\nDry-run — no changes made. Drop --dry to commit.');
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
