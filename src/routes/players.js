const router = require('express').Router();
const db = require('../db/pool');
const { requireRole, optionalAuth } = require('../middleware/auth');
const { emit } = require('../services/eventBus');
const { isPastDeadline } = require('../services/deadline');

// US phone: must be exactly 10 digits (after stripping a leading 1 / formatting).
function normalizeUsPhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return null;
  const pretty = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return { digits: d, pretty };
}

// Roster read. PUBLIC, but phone numbers are PRIVATE: they're only included for
// an authenticated admin (for contact/verification). Everyone else gets just the
// id/name/picks the app actually renders — no phone numbers exposed.
router.get('/api/players', optionalAuth, async (req, res, next) => {
  try {
    const isAdmin = req.auth && req.auth.role === 'admin';
    const { rows } = await db.query(
      `SELECT id, name, ${isAdmin ? 'phone, phone_digits,' : ''} picks, locked, updated_at FROM players`
    );
    res.json({ players: Object.fromEntries(rows.map((r) => [r.id, r])) });
  } catch (e) {
    next(e);
  }
});

// Public self-registration. No admin token required, but defensive:
//  - name + phone + picks required (phone is a US 10-digit number);
//  - registration closes at the configured deadline (423 after kickoff);
//  - a player locks on creation; a locked player cannot be overwritten by the
//    public endpoint (returns 409) — only admin can edit afterwards;
//  - name and phone are each unique to stop duplicate signups.
router.post('/api/register', async (req, res, next) => {
  try {
    // Registration window: closed once the picks deadline passes.
    if (await isPastDeadline()) {
      return res.status(423).json({ error: 'Registration is closed — the tournament has started.' });
    }

    const { name, phone, picks } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    if (!picks || typeof picks !== 'object') return res.status(400).json({ error: 'picks required' });
    const ph = normalizeUsPhone(phone);
    if (!ph) return res.status(400).json({ error: 'A valid US phone number is required' });

    const cleanName = String(name).trim().slice(0, 80);

    // Match an existing record by phone first (more reliable), then by name.
    const existing = await db.query(
      'SELECT id, locked, phone_digits FROM players WHERE phone_digits = $1 OR LOWER(name) = LOWER($2) ORDER BY (phone_digits = $1) DESC LIMIT 1',
      [ph.digits, cleanName]
    );
    const ex = existing.rows[0];
    // Only refuse when the match is a DIFFERENT, already-locked person who holds
    // a different phone. A locked player who has no phone yet (e.g. pre-added by
    // the admin) or who holds THIS same phone is just claiming/refreshing their
    // own entry — attach the phone and let them in instead of blocking.
    if (ex && ex.locked && ex.phone_digits && ex.phone_digits !== ph.digits) {
      return res.status(409).json({ error: 'This name is already taken by another player. Try your full name.' });
    }

    const id = ex ? ex.id : `p_${Date.now()}`;
    await emit(
      'player.register',
      { actor: 'public', entity: 'player', entityId: id, data: { name: cleanName } },
      async (client) => {
        await client.query(
          `INSERT INTO players (id, name, phone, phone_digits, picks, locked, updated_at)
           VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, phone = EXCLUDED.phone, phone_digits = EXCLUDED.phone_digits,
             picks = EXCLUDED.picks, locked = TRUE, updated_at = NOW()`,
          [id, cleanName, ph.pretty, ph.digits, JSON.stringify(picks)]
        );
      }
    );
    res.json({ ok: true, id, locked: true });
  } catch (e) {
    // Unique-violation on name or phone index → friendly 409.
    if (e.code === '23505') {
      return res.status(409).json({ error: 'This name or phone is already taken.' });
    }
    next(e);
  }
});

router.post('/api/players', requireRole('admin'), async (req, res, next) => {
  try {
    const { id, name, picks, phone } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    // Optional phone update (admin support tool: re-attach a player to the
    // number they actually type at the gate). Validated as US 10-digit.
    let ph = null;
    if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
      ph = normalizeUsPhone(phone);
      if (!ph) return res.status(400).json({ error: 'A valid US phone number is required' });
    }
    await emit(
      'player.save',
      { actor: req.auth.role, entity: 'player', entityId: id, data: { name, phone: ph ? ph.digits : undefined } },
      async (client) => {
        // Admin save can also (un)lock a player when `locked` is provided.
        const locked = typeof req.body.locked === 'boolean' ? req.body.locked : null;
        await client.query(
          `INSERT INTO players (id, name, picks, locked, phone, phone_digits, updated_at)
           VALUES ($1, $2, $3, COALESCE($4, FALSE), $5, $6, NOW())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, picks = EXCLUDED.picks,
             locked = COALESCE($4, players.locked),
             -- phone only changes when explicitly provided
             phone = COALESCE($5, players.phone),
             phone_digits = COALESCE($6, players.phone_digits),
             updated_at = NOW()`,
          [id, name || null, picks ? JSON.stringify(picks) : '{}', locked,
            ph ? ph.pretty : null, ph ? ph.digits : null]
        );
      }
    );
    res.json({ ok: true, id, phone: ph ? ph.pretty : undefined });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'That phone is already attached to another player.' });
    }
    next(e);
  }
});

router.delete('/api/players/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    let removed = 0;
    await emit(
      'player.delete',
      { actor: req.auth.role, entity: 'player', entityId: id },
      async (client) => {
        // Purge the player everywhere so they can't linger on the leaderboard or
        // resurrect via stale picks/subscriptions.
        await client.query('DELETE FROM score_picks WHERE player_id = $1', [id]);
        await client.query('DELETE FROM phase_submissions WHERE player_id = $1', [id]);
        await client.query('DELETE FROM award_picks WHERE player_id = $1', [id]);
        await client.query('DELETE FROM push_subscriptions WHERE player_id = $1', [id]);
        const r = await client.query('DELETE FROM players WHERE id = $1', [id]);
        removed = r.rowCount || 0;
      }
    );
    // 404 if there was no such player (so the UI can tell "already gone" from a
    // real delete instead of silently assuming success).
    if (!removed) return res.status(404).json({ error: 'player not found', deleted: id });
    res.json({ ok: true, deleted: id });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
