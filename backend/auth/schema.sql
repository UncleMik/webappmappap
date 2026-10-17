-- Separate PostgreSQL database. This migration never touches articles.sqlite.
CREATE TABLE IF NOT EXISTS auth_users (
  id uuid PRIMARY KEY,
  email text UNIQUE NOT NULL,
  getcourse_id bigint UNIQUE NOT NULL CHECK (getcourse_id > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_email_state (
  email_key text PRIMARY KEY,
  last_sent_at timestamptz,
  failures integer NOT NULL DEFAULT 0,
  failure_window timestamptz
);
CREATE TABLE IF NOT EXISTS auth_mail_events (
  id bigserial PRIMARY KEY,
  email_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_mail_events_email_time ON auth_mail_events(email_key, created_at);
CREATE TABLE IF NOT EXISTS auth_challenges (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  code_mac text NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_challenges_email ON auth_challenges(email);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_gc_jobs (
  email text PRIMARY KEY,
  getcourse_id bigint,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_gc_jobs_due ON auth_gc_jobs(next_attempt_at) WHERE completed_at IS NULL;
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket text PRIMARY KEY,
  hits integer NOT NULL,
  expires_at timestamptz NOT NULL
);
