const router = require('express').Router();
const db = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { sendChatMention } = require('../services/push');

const MAX_LEN = 500;
const MIN_INTERVAL_MS = 1000; // light anti-spam: one message per second per player/channel

// Two independent chat channels:
//   - 'live'    → in-game banter; wiped when the game ends (services/chatReset).
//   - 'ranking' → pool chat on the leaderboard; persists.
const CHANNELS = new Set(['live', 'ranking']);
function channelOf(value) {
  return CHANNELS.has(value) ? value : 'live';
}

// Best-effort in-memory throttle (per process). Not a security control.
const lastPostAt = new Map();

// GET /api/chat?channel=live|ranking&since=<ISO>&limit=N — oldest → newest.
router.get('/api/chat', requireRole('player', 'admin'), async (req, res, next) => {
  try {
    const channel = channelOf(req.query.channel);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const since = req.query.since ? new Date(req.query.since) : null;
    let rows;
    if (since && !Number.isNaN(since.getTime())) {
      ({ rows } = await db.query(
        `SELECT id, player_id, name, body, created_at FROM chat_messages
          WHERE channel = $1 AND created_at > $2 ORDER BY created_at ASC LIMIT $3`,
        [channel, since.toISOString(), limit]
      ));
    } else {
      ({ rows } = await db.query(
        `SELECT id, player_id, name, body, created_at FROM (
           SELECT id, player_id, name, body, created_at FROM chat_messages
           WHERE channel = $1 ORDER BY created_at DESC LIMIT $2
         ) t ORDER BY created_at ASC`,
        [channel, limit]
      ));
    }
    res.json({ messages: rows, channel, serverTime: Date.now() });
  } catch (e) {
    next(e);
  }
});

// POST /api/chat { body, channel } — post a message as the logged-in player.
router.post('/api/chat', requireRole('player', 'admin'), async (req, res, next) => {
  try {
    const pid = req.auth.pid || null;
    const channel = channelOf(req.body && req.body.channel);
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
    if (body.length > MAX_LEN) return res.status(400).json({ error: `Message too long (max ${MAX_LEN}).` });

    const now = Date.now();
    const throttleKey = `${pid}:${channel}`;
    if (pid && now - (lastPostAt.get(throttleKey) || 0) < MIN_INTERVAL_MS) {
      return res.status(429).json({ error: 'Slow down a moment.' });
    }
    if (pid) lastPostAt.set(throttleKey, now);

    // Snapshot the player's current name so the message renders independently.
    let name = null;
    if (pid) {
      const { rows } = await db.query('SELECT name FROM players WHERE id = $1', [pid]);
      name = rows[0] ? rows[0].name : null;
    }

    const { rows } = await db.query(
      `INSERT INTO chat_messages (player_id, name, body, channel) VALUES ($1, $2, $3, $4)
       RETURNING id, player_id, name, body, created_at`,
      [pid, name, body, channel]
    );

    // Notify @mentioned players (best-effort; never blocks the post). Dedupe,
    // skip the author, cap to avoid abuse.
    const mentions = Array.isArray(req.body && req.body.mentions)
      ? [...new Set(req.body.mentions.map(String))].filter((id) => id && id !== String(pid)).slice(0, 20)
      : [];
    for (const target of mentions) {
      try { await sendChatMention(target, name, body); } catch { /* ignore push errors */ }
    }

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
