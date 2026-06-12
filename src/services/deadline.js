const db = require('../db/pool');

// Reads the picks registration deadline from app_config. Returns an ISO string
// or null (no deadline set). Cached briefly to avoid a query per register.
let cache = { at: 0, value: undefined };

async function getDeadline() {
  if (Date.now() - cache.at < 10_000 && cache.value !== undefined) return cache.value;
  const { rows } = await db.query("SELECT value FROM app_config WHERE key = 'picks_deadline'");
  const value = rows[0] ? rows[0].value : null;
  cache = { at: Date.now(), value };
  return value;
}

// True when the deadline has passed (registration should be closed).
async function isPastDeadline() {
  const dl = await getDeadline();
  if (!dl) return false;
  const t = new Date(dl).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() >= t;
}

function clearCache() {
  cache = { at: 0, value: undefined };
}

module.exports = { getDeadline, isPastDeadline, clearCache };
