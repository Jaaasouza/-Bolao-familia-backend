const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 10),
    });
  }
  return pool;
}

module.exports = {
  getPool,
  query: (text, params) => getPool().query(text, params),
  getClient: () => getPool().connect(),
};
