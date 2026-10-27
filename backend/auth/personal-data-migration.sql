-- Account-bound personal records. The owner is always read from auth_sessions.
CREATE TABLE IF NOT EXISTS auth_personal_records (
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('weight','pressure','wellbeing','baby','movement','article','favorite')),
  record_id text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, record_id)
);
CREATE INDEX IF NOT EXISTS auth_personal_records_user_kind ON auth_personal_records(user_id, kind);
