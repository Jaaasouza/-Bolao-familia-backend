const db = require('../db/pool');

// Central event bus. Every domain state change goes through emit(): it runs the
// caller's mutation and the audit-log insert inside a single transaction, so a
// mutation and its audit trail commit or roll back together. Don't bypass this
// for mutations (see CLAUDE.md).
//
//   await emit('player.save', { actor, entity, entityId, data }, async (client) => {
//     await client.query('INSERT ...');
//   });
async function emit(event, meta = {}, mutator) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = typeof mutator === 'function' ? await mutator(client) : undefined;
    await client.query(
      `INSERT INTO audit_log (event, actor, entity, entity_id, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event,
        meta.actor || null,
        meta.entity || null,
        meta.entityId != null ? String(meta.entityId) : null,
        meta.data != null ? JSON.stringify(meta.data) : null,
      ]
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback error, surface the original */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { emit };
