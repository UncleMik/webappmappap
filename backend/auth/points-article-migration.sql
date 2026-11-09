ALTER TABLE auth_points_ledger ADD COLUMN IF NOT EXISTS article_id text;
ALTER TABLE auth_points_ledger ALTER COLUMN source_message_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='auth_points_ledger'::regclass
      AND conname='auth_points_ledger_one_source') THEN
    ALTER TABLE auth_points_ledger ADD CONSTRAINT auth_points_ledger_one_source
      CHECK ((source_message_id IS NOT NULL) <> (article_id IS NOT NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS auth_points_ledger_club_day
  ON auth_points_ledger(user_id, moscow_day) WHERE source_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_points_ledger_article_once
  ON auth_points_ledger(user_id, article_id) WHERE article_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_points_ledger_user_day ON auth_points_ledger(user_id, moscow_day);
ALTER TABLE auth_points_ledger DROP CONSTRAINT IF EXISTS auth_points_ledger_user_id_moscow_day_key;

CREATE TABLE IF NOT EXISTS auth_points_article_reads (
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  article_id text NOT NULL,
  session_hash text NOT NULL REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  last_seen_at timestamptz NOT NULL,
  required_ms integer NOT NULL CHECK (required_ms >= 30000),
  active_ms integer NOT NULL CHECK (active_ms >= 0 AND active_ms <= required_ms),
  awarded_amount smallint CHECK (awarded_amount BETWEEN 0 AND 20),
  limited_by text CHECK (limited_by IN ('day','week')),
  PRIMARY KEY (user_id, article_id)
);
CREATE INDEX IF NOT EXISTS auth_points_article_reads_session ON auth_points_article_reads(session_hash);
