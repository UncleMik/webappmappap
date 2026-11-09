CREATE TABLE IF NOT EXISTS auth_points_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  source_message_id bigint NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  moscow_day date NOT NULL,
  amount smallint NOT NULL CHECK (amount > 0),
  UNIQUE (user_id, moscow_day)
);
CREATE INDEX IF NOT EXISTS auth_points_ledger_user_history ON auth_points_ledger(user_id, id DESC);
