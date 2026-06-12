// Append-only migrations.
//
// RULES (see CLAUDE.md):
//   - Never edit a migration that has shipped to main. Only add new entries
//     with the next sequential version number.
//   - Every migration must be idempotent (IF NOT EXISTS on CREATE).
//   - Each migration runs inside its own BEGIN/COMMIT (see migrate.js).
//
// The `audit_log` table (v2) is wipe-immune — never include it in any WIPE_PLAN.

const MIGRATIONS = [
  {
    version: 1,
    name: 'create_core_tables',
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS matches (
          id            BIGINT PRIMARY KEY,
          utc_date      TIMESTAMPTZ,
          status        TEXT,
          stage         TEXT,
          group_name    TEXT,
          home_team     TEXT,
          away_team     TEXT,
          home_score    INTEGER,
          away_score    INTEGER,
          winner        TEXT,
          last_updated  TIMESTAMPTZ,
          raw           JSONB,
          synced_at     TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS players (
          id          TEXT PRIMARY KEY,
          name        TEXT,
          picks       JSONB DEFAULT '{}'::jsonb,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          updated_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS phases (
          team_name   TEXT PRIMARY KEY,
          phase       TEXT NOT NULL,
          updated_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS standings (
          group_name  TEXT PRIMARY KEY,
          first_team  TEXT,
          second_team TEXT,
          updated_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS sync_state (
          key         TEXT PRIMARY KEY,
          value       JSONB,
          updated_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    },
  },
  {
    version: 2,
    name: 'create_audit_log',
    up: async (client) => {
      // Wipe-immune: never delete from or truncate this table in a wipe.
      await client.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id          BIGSERIAL PRIMARY KEY,
          event       TEXT NOT NULL,
          actor       TEXT,
          entity      TEXT,
          entity_id   TEXT,
          data        JSONB,
          created_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(
        'CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)'
      );
      await client.query(
        'CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event)'
      );
    },
  },
  {
    version: 3,
    name: 'index_matches_utc_date',
    up: async (client) => {
      await client.query(
        'CREATE INDEX IF NOT EXISTS idx_matches_utc_date ON matches(utc_date)'
      );
    },
  },
  {
    version: 4,
    name: 'matches_upset_flag',
    up: async (client) => {
      // Admin-set flag: awards the upset bonus when the picked team wins.
      await client.query(
        'ALTER TABLE matches ADD COLUMN IF NOT EXISTS upset BOOLEAN NOT NULL DEFAULT FALSE'
      );
    },
  },
  {
    version: 5,
    name: 'players_lock_and_name_key',
    up: async (client) => {
      // Public self-registration: a player locks on first submit so it can't be
      // silently overwritten by another public request. created_at already
      // exists from v1.
      await client.query(
        'ALTER TABLE players ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE'
      );
      // Case-insensitive uniqueness on name to prevent duplicate public signups.
      await client.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_players_name_lower ON players (LOWER(name))'
      );
    },
  },
  {
    version: 6,
    name: 'players_phone_and_config',
    up: async (client) => {
      // Phone for better player verification (US format stored as 10 digits).
      await client.query(
        'ALTER TABLE players ADD COLUMN IF NOT EXISTS phone TEXT'
      );
      await client.query(
        'ALTER TABLE players ADD COLUMN IF NOT EXISTS phone_digits TEXT'
      );
      // Unique on the bare digits (when present) — one signup per phone.
      await client.query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_players_phone_digits ON players (phone_digits) WHERE phone_digits IS NOT NULL AND phone_digits <> ''"
      );
      // Key/value config (registration deadline, etc.).
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_config (
          key         TEXT PRIMARY KEY,
          value       JSONB,
          updated_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Default picks deadline = the 2026 opener kickoff (Mexico v South Africa).
      await client.query(
        `INSERT INTO app_config (key, value) VALUES ('picks_deadline', $1)
         ON CONFLICT (key) DO NOTHING`,
        [JSON.stringify('2026-06-11T19:00:00.000Z')]
      );
    },
  },
  {
    version: 7,
    name: 'score_picks',
    up: async (client) => {
      // Per-player, per-match scoreline prediction (the new pick model).
      // Locked once the match kicks off (enforced in the route, not the schema).
      await client.query(`
        CREATE TABLE IF NOT EXISTS score_picks (
          player_id   TEXT NOT NULL,
          match_id    BIGINT NOT NULL,
          pred_home   INTEGER NOT NULL,
          pred_away   INTEGER NOT NULL,
          phase       TEXT,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          updated_at  TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (player_id, match_id)
        )
      `);
      await client.query(
        'CREATE INDEX IF NOT EXISTS idx_score_picks_match ON score_picks(match_id)'
      );
      await client.query(
        'CREATE INDEX IF NOT EXISTS idx_score_picks_player ON score_picks(player_id)'
      );
    },
  },
  {
    version: 8,
    name: 'phase_submissions',
    up: async (client) => {
      // Once a player submits a whole phase (e.g. all group matches in one shot),
      // that phase is locked for them — picks can't be changed. Admin can clear a
      // row here to let a player resubmit.
      await client.query(`
        CREATE TABLE IF NOT EXISTS phase_submissions (
          player_id    TEXT NOT NULL,
          phase        TEXT NOT NULL,
          submitted_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (player_id, phase)
        )
      `);
    },
  },
  {
    version: 9,
    name: 'award_picks',
    up: async (client) => {
      // Tournament-wide award bets chosen with the first (group) submission:
      //   kind = 'golden_boot' (top scorer) | 'best_player' (player of the cup).
      // One pick per kind per player; set once when the group phase is locked.
      await client.query(`
        CREATE TABLE IF NOT EXISTS award_picks (
          player_id   TEXT NOT NULL,
          kind        TEXT NOT NULL,
          pick        TEXT NOT NULL,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (player_id, kind)
        )
      `);
    },
  },
  {
    version: 10,
    name: 'push_subscriptions_and_notified_matches',
    up: async (client) => {
      // Web-push subscriptions, one row per browser endpoint, tied to a player.
      await client.query(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint    TEXT PRIMARY KEY,
          player_id   TEXT NOT NULL,
          p256dh      TEXT NOT NULL,
          auth        TEXT NOT NULL,
          created_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query(
        'CREATE INDEX IF NOT EXISTS idx_push_subs_player ON push_subscriptions(player_id)'
      );
      // Remembers which finished matches we've already sent point alerts for, so
      // every match notifies each player exactly once.
      await client.query(`
        CREATE TABLE IF NOT EXISTS notified_matches (
          match_id    BIGINT PRIMARY KEY,
          notified_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    },
  },
  {
    version: 11,
    name: 'push_subscription_lang',
    up: async (client) => {
      // Each subscription remembers the language it was created in, so the
      // notification text matches what the player chose in the app.
      await client.query(
        "ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'en'"
      );
    },
  },
  {
    version: 12,
    name: 'match_progress',
    up: async (client) => {
      // Per-match state we've already seen + announced, so the live-event sweep
      // can detect transitions (kickoff / goal / half-time / full-time) between
      // syncs and notify each one exactly once. Goals are detected by comparing
      // the stored score to the freshly-synced score.
      await client.query(`
        CREATE TABLE IF NOT EXISTS match_progress (
          match_id     BIGINT PRIMARY KEY,
          status       TEXT,
          home_score   INTEGER,
          away_score   INTEGER,
          kickoff_sent BOOLEAN NOT NULL DEFAULT FALSE,
          half_sent    BOOLEAN NOT NULL DEFAULT FALSE,
          full_sent    BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at   TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    },
  },
  {
    version: 13,
    name: 'matches_manual_score',
    up: async (client) => {
      // Admin-entered live scores. When TRUE, the football-data sync must NOT
      // overwrite this match's score/status — the admin is the source of truth
      // (e.g. when the provider isn't pushing live in-play updates).
      await client.query(
        'ALTER TABLE matches ADD COLUMN IF NOT EXISTS manual_score BOOLEAN NOT NULL DEFAULT FALSE'
      );
    },
  },
  {
    version: 14,
    name: 'matches_live_events',
    up: async (client) => {
      // ESPN key events for a match: goals (scorer + minute), cards, and the
      // penalty-shootout result. Shape: { events: [...], pens: {...}|null }.
      await client.query(
        'ALTER TABLE matches ADD COLUMN IF NOT EXISTS live_events JSONB'
      );
    },
  },
  {
    version: 15,
    name: 'matches_lineups',
    up: async (client) => {
      // ESPN event id (to fetch the per-match summary) + parsed lineups:
      // { home: { formation, coach, starters:[...], subs:[...] }, away: {...} }.
      await client.query('ALTER TABLE matches ADD COLUMN IF NOT EXISTS espn_id TEXT');
      await client.query('ALTER TABLE matches ADD COLUMN IF NOT EXISTS lineups JSONB');
    },
  },
  {
    version: 16,
    name: 'matches_commentary',
    up: async (client) => {
      // ESPN play-by-play commentary: [{ minute, text }], most recent kept.
      await client.query('ALTER TABLE matches ADD COLUMN IF NOT EXISTS commentary JSONB');
    },
  },
  {
    version: 17,
    name: 'chat_messages',
    up: async (client) => {
      // Pool chat: one row per message. `name` is denormalized (a snapshot of the
      // player's name at post time) so messages still render if a player is later
      // renamed or removed.
      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id          BIGSERIAL PRIMARY KEY,
          player_id   TEXT,
          name        TEXT,
          body        TEXT NOT NULL,
          created_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await client.query('CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at)');
    },
  },
];

module.exports = { MIGRATIONS };
