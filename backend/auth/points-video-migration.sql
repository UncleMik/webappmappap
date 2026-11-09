ALTER TABLE auth_points_ledger ADD COLUMN IF NOT EXISTS video_id text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'auth_points_ledger'::regclass
      AND attname = 'poll_id' AND NOT attisdropped) THEN
    ALTER TABLE auth_points_ledger DROP CONSTRAINT IF EXISTS auth_points_ledger_one_source;
    ALTER TABLE auth_points_ledger ADD CONSTRAINT auth_points_ledger_one_source
      CHECK (num_nonnulls(source_message_id, article_id, video_id) = 1);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS auth_points_ledger_video_once
  ON auth_points_ledger(user_id, video_id) WHERE video_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS auth_points_video_views (
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  video_id text NOT NULL,
  session_hash text NOT NULL,
  attempt_id uuid NOT NULL,
  last_seen_at timestamptz NOT NULL,
  watched jsonb NOT NULL,
  limited_by text CHECK (limited_by IN ('day','week')),
  PRIMARY KEY(user_id, video_id)
);
