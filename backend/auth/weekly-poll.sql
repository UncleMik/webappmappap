CREATE TABLE IF NOT EXISTS weekly_polls (
  id text PRIMARY KEY,
  question text NOT NULL,
  options text[] NOT NULL CHECK (cardinality(options) >= 2),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL CHECK (closes_at > opens_at),
  settled_at timestamptz
);

CREATE TABLE IF NOT EXISTS weekly_poll_votes (
  poll_id text NOT NULL REFERENCES weekly_polls(id),
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  choice integer NOT NULL CHECK (choice >= 0),
  points integer CHECK (points IN (50, 100)),
  PRIMARY KEY (poll_id, user_id)
);

INSERT INTO weekly_polls (id, question, options, opens_at, closes_at)
VALUES ('2026-11-09', 'Какая тема вам сейчас полезнее?',
        ARRAY['Подготовка к родам', 'Восстановление после родов', 'Уход за новорождённым'],
        '2026-11-09 00:00+03', '2026-11-15 18:00+03')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE auth_points_ledger ADD COLUMN IF NOT EXISTS poll_id text REFERENCES weekly_polls(id);
ALTER TABLE auth_points_ledger DROP CONSTRAINT IF EXISTS auth_points_ledger_one_source;
ALTER TABLE auth_points_ledger ADD CONSTRAINT auth_points_ledger_one_source
  CHECK (num_nonnulls(source_message_id, article_id, video_id, poll_id) = 1);
CREATE UNIQUE INDEX IF NOT EXISTS auth_points_ledger_poll_once
  ON auth_points_ledger(user_id, poll_id) WHERE poll_id IS NOT NULL;
