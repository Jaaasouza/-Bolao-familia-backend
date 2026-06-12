// Award bets (chosen with the first / group submission):
//   golden_boot — tournament top scorer
//   best_player — player of the tournament
// Pure helpers only; storage lives in the score-picks route transaction.
const AWARD_KINDS = ['golden_boot', 'best_player'];

// Turn the client payload { goldenBoot, bestPlayer } into validated rows
// [{ kind, pick }]. Empty / missing picks are dropped (awards are optional).
function parseAwards(input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  const map = { golden_boot: input.goldenBoot, best_player: input.bestPlayer };
  for (const kind of AWARD_KINDS) {
    const raw = map[kind];
    if (raw == null) continue;
    const pick = String(raw).trim();
    if (!pick) continue;
    out.push({ kind, pick: pick.slice(0, 80) });
  }
  return out;
}

module.exports = { AWARD_KINDS, parseAwards };
