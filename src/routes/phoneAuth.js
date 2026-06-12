const router = require('express').Router();
const db = require('../db/pool');
const { signToken } = require('../middleware/auth');
const { normalizePhone } = require('../services/phone');

// Phone login for returning players: no name needed for later phases — the
// phone finds the existing player and issues a player-scoped token used to
// attach score picks. (First-time players still register on the Join form.)
router.post('/api/auth/phone', async (req, res, next) => {
  try {
    const ph = normalizePhone(req.body && req.body.phone);
    const digits = ph && ph.digits;
    if (!digits) return res.status(400).json({ error: 'A valid phone number is required' });

    // Find the returning player by their normalized 10-digit number. Match the
    // canonical `phone_digits` first, but also fall back to the digits of the
    // free-form `phone` text, so a player whose phone_digits was never stored
    // (or stored in another format) still logs straight in — no re-registering.
    const { rows } = await db.query(
      `SELECT id, name, phone_digits FROM players
         WHERE phone_digits = $1
            OR right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = $1
       LIMIT 1`,
      [digits]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'No player found for that phone. Register first.' });
    }
    const player = rows[0];
    // Self-heal: backfill/normalize phone_digits so the next login matches directly.
    if (player.phone_digits !== digits) {
      db.query('UPDATE players SET phone_digits = $1 WHERE id = $2', [digits, player.id]).catch(() => {});
    }
    const token = signToken({ role: 'player', pid: player.id });
    res.json({ token, player: { id: player.id, name: player.name } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
