const router = require('express').Router();
const db = require('../db/pool');
const { requireRole } = require('../middleware/auth');

const MAX_LEN = 500;
const MIN_INTERVAL_MS = 1000; // light anti-spam: one message per second per player

// Best-effort in-memory throttle (per process). Not a security control — just
// stops accidental double-sends / rapid spam.
const lastPostAt = new Map();

// GET /api/chat?since=<ISO>&limit=N — pool messages, oldest → newest.
//   - `since` returns only messages newer than that timestamp (incremental poll).
//   - otherwise the most recent `limit` messages (default 100, max 200).
router.get('/api/chat', requireRole('player', 'admin'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const since = req.query.since ? new Date(req.query.since) : null;
    let rows;
    if (since && !Number.isNaN(since.getTime())) {
      ({ rows } = await db.query(
        `SELECT id, player_id, name, body, created_at FROM chat_messages
          WHERE created_at > $1 ORDER BY created_at ASC LIMIT $2`,
        [since.toISOString(), limit]
      ));
    } else {
      ({ rows } = await db.query(
        `SELECT id, player_id, name, body, created_at FROM (
           SELECT id, player_id, name, body, created_at FROM chat_messages
           ORDER BY created_at DESC LIMIT $1
         ) t ORDER BY created_at ASC`,
        [limit]
      ));
    }
    res.json({ messages: rows, serverTime: Date.now() });
  } catch (e) {
    next(e);
  }
});

// POST /api/chat { body } — post a message as the logged-in player.
router.post('/api/chat', requireRole('player', 'admin'), async (req, res, next) => {
  try {
    const pid = req.auth.pid || null;
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
    if (body.length > MAX_LEN) return res.status(400).json({ error: `Message too long (max ${MAX_LEN}).` });

    const now = Date.now();
    if (pid && now - (lastPostAt.get(pid) || 0) < MIN_INTERVAL_MS) {
      return res.status(429).json({ error: 'Slow down a moment.' });
    }
    if (pid) lastPostAt.set(pid, now);

    // Snapshot the player's current name so the message renders independently.
    let name = null;
    if (pid) {
      const { rows } = await db.query('SELECT name FROM players WHERE id = $1', [pid]);
      name = rows[0] ? rows[0].name : null;
    }

    const { rows } = await db.query(
      `INSERT INTO chat_messages (player_id, name, body) VALUES ($1, $2, $3)
       RETURNING id, player_id, name, body, created_at`,
      [pid, name, body]
    );
    res.json({ ok: true, message: rows[0] });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/chat/:id — admin moderation.
router.delete('/api/chat/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    await db.query('DELETE FROM chat_messages WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
