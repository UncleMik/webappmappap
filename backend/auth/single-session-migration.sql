-- Run in a transaction as the schema owner, before starting the new auth service.
-- Block concurrent session writes while normalizing existing logins.
LOCK TABLE auth_sessions IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
  WHERE revoked_at IS NULL AND expires_at <= CURRENT_TIMESTAMP;
WITH ranked AS (
  SELECT token_hash, row_number() OVER (
    PARTITION BY user_id
    ORDER BY (expires_at > CURRENT_TIMESTAMP) DESC, created_at DESC, token_hash DESC
  ) AS position
  FROM auth_sessions WHERE revoked_at IS NULL
)
UPDATE auth_sessions s SET revoked_at = CURRENT_TIMESTAMP
FROM ranked r WHERE s.token_hash = r.token_hash AND r.position > 1;
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_one_active_user
  ON auth_sessions(user_id) WHERE revoked_at IS NULL;
