const db = require('../db/pool');

// Per-game banter: the chat is wiped when the live game(s) end, so every match
// starts fresh. We detect the "a game just ended" transition by remembering, in
// sync_state, whether anything was live on the previous scheduler tick.
//
//   live now + wasn't before  → remember that a game is live
//   nothing live + was before → a game just finished → DELETE all messages
//
// Messages still persist for the whole duration of a game (and across refreshes,
// since they live in Postgres) — they only clear once the game is over.
async function clearChatOnGameEnd() {
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS n FROM matches WHERE status IN ('IN_PLAY','PAUSED','LIVE')"
  );
  const liveNow = (rows[0] ? rows[0].n : 0) > 0;

  const { rows: fr } = await db.query("SELECT value FROM sync_state WHERE key = 'chat_live_flag'");
  const hadLive = fr[0] ? fr[0].value === true : false;

  const setFlag = (v) => db.query(
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('chat_live_flag', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(v)]
  );

  if (liveNow) {
    if (!hadLive) await setFlag(true);
    return { live: true };
  }
  if (hadLive) {
    const res = await db.query("DELETE FROM chat_messages WHERE channel = 'live'");
    await setFlag(false);
    return { cleared: res.rowCount || 0 };
  }
  return { idle: true };
}

module.exports = { clearChatOnGameEnd };
