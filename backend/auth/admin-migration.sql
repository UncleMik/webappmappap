CREATE TABLE IF NOT EXISTS admin_editors (
  user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_announcements (
  id uuid PRIMARY KEY,
  author_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  title text NOT NULL,
  body text NOT NULL,
  link text,
  published_at timestamptz NOT NULL DEFAULT now(),
  hidden_at timestamptz
);
CREATE INDEX IF NOT EXISTS admin_announcements_visible ON admin_announcements (published_at DESC, id)
  WHERE hidden_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE weekly_polls ADD COLUMN IF NOT EXISTS editor_revision integer NOT NULL DEFAULT 0;
