// Registration deadline for the picks game.
//
// PRODUCT RULE (família pool): there is NO registration deadline — players can
// register and make picks at any time. Locking is per-match instead: a match
// closes for picks only once it kicks off (see routes/scorePicks.js). These
// helpers are kept because other modules import them, but they always report
// "open / no deadline" so nothing ever blocks on a global cutoff.

async function getDeadline() {
  return null;
}

async function isPastDeadline() {
  return false;
}

function clearCache() {
  // No-op: there is no deadline value to cache anymore.
}

module.exports = { getDeadline, isPastDeadline, clearCache };
