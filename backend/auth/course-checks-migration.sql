-- Latest read-only GetCourse evidence; this table does not grant course rights.
CREATE TABLE IF NOT EXISTS course_access_checks (
  user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  getcourse_id bigint NOT NULL CHECK (getcourse_id > 0),
  snapshot jsonb,
  checked_at timestamptz,
  expires_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  CHECK ((snapshot IS NULL AND checked_at IS NULL AND expires_at IS NULL)
    OR (snapshot IS NOT NULL AND checked_at IS NOT NULL AND expires_at IS NOT NULL
      AND expires_at > checked_at AND expires_at <= checked_at + interval '5 minutes'))
);
