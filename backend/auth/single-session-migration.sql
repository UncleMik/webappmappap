-- Run in a transaction as the schema owner, before starting the new auth service.
CREATE TABLE IF NOT EXISTS auth_multi_session_users (
  user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE
);

-- Block concurrent session writes while normalizing existing logins.
LOCK TABLE auth_sessions IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS multi_session_user_id uuid
  REFERENCES auth_multi_session_users(user_id) ON DELETE CASCADE
  CONSTRAINT auth_sessions_multi_session_identity CHECK (multi_session_user_id = user_id);
UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
  WHERE revoked_at IS NULL AND expires_at <= CURRENT_TIMESTAMP;
WITH ranked AS (
  SELECT token_hash, row_number() OVER (
    PARTITION BY user_id
    ORDER BY (expires_at > CURRENT_TIMESTAMP) DESC, created_at DESC, token_hash DESC
  ) AS position
  FROM auth_sessions WHERE revoked_at IS NULL AND multi_session_user_id IS NULL
)
UPDATE auth_sessions s SET revoked_at = CURRENT_TIMESTAMP
FROM ranked r WHERE s.token_hash = r.token_hash AND r.position > 1;
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_one_active_standard_user
  ON auth_sessions(user_id) WHERE revoked_at IS NULL AND multi_session_user_id IS NULL;
DROP INDEX IF EXISTS auth_sessions_one_active_user;
