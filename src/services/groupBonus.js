// Group-qualifier bonus.
//
// On top of the per-match points, players earn a bonus for predicting each
// group's top two (derived from their group-match scorelines, exactly like the
// "predicted group winners" card on the app):
//   +2  both 1st AND 2nd correct, in the right order
//   +1  both qualifiers correct but the order is swapped
//    0  otherwise
// Only scored once the REAL group has been decided (standings carry a 1st/2nd).

// "GROUP_A" → "A"; null when there's no group (knockout match).
function groupKey(g) {
  if (!g) return null;
  return String(g).replace(/^GROUP[_ ]?/i, '').trim() || null;
}

// Predicted 1st/2nd per group from a player's scorelines.
// picks: [{ match_id, pred_home, pred_away }]
// matchesById: { [id]: { home_team, away_team, group_name|group, stage } }
// → { [letter]: { first, second, complete } }
function predictedGroupTables(picks, matchesById) {
  const groups = {}; // letter → { team → { team, pts, gf, ga, played } }
  const counts = {}; // letter → number of group matches in the fixtures

  for (const id of Object.keys(matchesById || {})) {
    const m = matchesById[id];
    if (m.stage && m.stage !== 'GROUP_STAGE') continue;
    const g = groupKey(m.group_name || m.group);
    if (!g) continue;
    counts[g] = (counts[g] || 0) + 1;
  }

  for (const p of picks || []) {
    const m = matchesById[p.match_id];
    if (!m) continue;
    if (m.stage && m.stage !== 'GROUP_STAGE') continue;
    const g = groupKey(m.group_name || m.group);
    if (!g) continue;
    const h = Number(p.pred_home);
    const a = Number(p.pred_away);
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue;

    const tbl = groups[g] || (groups[g] = {});
    const H = tbl[m.home_team] || (tbl[m.home_team] = { team: m.home_team, pts: 0, gf: 0, ga: 0, played: 0 });
    const A = tbl[m.away_team] || (tbl[m.away_team] = { team: m.away_team, pts: 0, gf: 0, ga: 0, played: 0 });
    H.played += 1; A.played += 1;
    H.gf += h; H.ga += a; A.gf += a; A.ga += h;
    if (h > a) H.pts += 3;
    else if (h < a) A.pts += 3;
    else { H.pts += 1; A.pts += 1; }
  }

  const out = {};
  for (const g of Object.keys(groups)) {
    const rows = Object.values(groups[g])
      .map((r) => ({ ...r, gd: r.gf - r.ga }))
      .sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.team.localeCompare(y.team));
    const playedAll = rows.reduce((s, r) => s + r.played, 0);
    out[g] = {
      first: rows[0] ? rows[0].team : null,
      second: rows[1] ? rows[1].team : null,
      complete: counts[g] != null && playedAll === counts[g] * 2,
    };
  }
  return out;
}

// Groups that are actually DECIDED — every group-stage match FINISHED. The
// bonus must only count these, so it can never fire before a group has finished
// (e.g. if the standings table carries seed/placeholder 1st-2nd before kickoff).
// matchesById: { [id]: { status, stage, group_name|group } } → Set of letters.
function decidedGroups(matchesById) {
  const byGroup = {};
  for (const id of Object.keys(matchesById || {})) {
    const m = matchesById[id];
    if (m.stage && m.stage !== 'GROUP_STAGE') continue;
    const g = groupKey(m.group_name || m.group);
    if (!g) continue;
    (byGroup[g] = byGroup[g] || []).push(m.status);
  }
  const decided = new Set();
  for (const g of Object.keys(byGroup)) {
    const sts = byGroup[g];
    if (sts.length > 0 && sts.every((s) => s === 'FINISHED')) decided.add(g);
  }
  return decided;
}

// Bonus for one player's predicted tables vs the actual decided standings.
// actualByGroup: { [letter]: { first, second } }
// decided: optional Set of group letters that have actually finished; when
// provided, only those groups can score (defensive against premature standings).
// → { bonus, perGroup: { [letter]: pts } }
function groupBonusForPlayer(predTables, actualByGroup, decided = null) {
  let bonus = 0;
  const perGroup = {};
  for (const g of Object.keys(actualByGroup || {})) {
    if (decided && !decided.has(g)) continue; // group not finished yet → no bonus
    const act = actualByGroup[g];
    if (!act || !act.first || !act.second) continue; // group not decided yet
    const pred = predTables[g];
    if (!pred || !pred.first || !pred.second) { perGroup[g] = 0; continue; }
    let pts = 0;
    if (pred.first === act.first && pred.second === act.second) pts = 2;
    else if (pred.first === act.second && pred.second === act.first) pts = 1;
    perGroup[g] = pts;
    bonus += pts;
  }
  return { bonus, perGroup };
}

module.exports = { predictedGroupTables, groupBonusForPlayer, decidedGroups, groupKey };
