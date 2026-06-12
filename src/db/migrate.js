const db = require('./pool');
const { MIGRATIONS } = require('./migrations');

async function migrate() {
  const client = await db.getClient();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
    for (const m of ordered) {
      if (applied.has(m.version)) continue;
      console.log(`[migrate] applying ${m.version}: ${m.name}`);
      await client.query('BEGIN');
      try {
        await m.up(client);
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [m.version, m.name]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('[migrate] up to date');
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => db.getPool().end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed:', err);
      process.exit(1);
    });
}

module.exports = { migrate };
