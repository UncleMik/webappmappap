-- Apply after points, points-article, points-video and weekly-poll migrations.
ALTER TABLE auth_points_ledger ADD COLUMN IF NOT EXISTS event_code text;
ALTER TABLE auth_points_ledger ADD COLUMN IF NOT EXISTS event_ref text;
ALTER TABLE auth_points_ledger ADD COLUMN IF NOT EXISTS capped boolean NOT NULL DEFAULT true;
ALTER TABLE auth_points_ledger ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE auth_points_article_reads DROP CONSTRAINT IF EXISTS auth_points_article_reads_awarded_amount_check;
ALTER TABLE auth_points_article_reads ADD CONSTRAINT auth_points_article_reads_awarded_amount_check CHECK(awarded_amount BETWEEN 0 AND 32767);
ALTER TABLE auth_points_ledger DROP CONSTRAINT IF EXISTS auth_points_ledger_amount_check;
ALTER TABLE auth_points_ledger DROP CONSTRAINT IF EXISTS auth_points_ledger_one_source;
ALTER TABLE auth_points_ledger ADD CONSTRAINT auth_points_ledger_one_source CHECK (
  (event_code IS NOT NULL AND event_ref IS NOT NULL AND num_nonnulls(source_message_id,article_id,video_id,poll_id)=0)
  OR (event_code IS NULL AND event_ref IS NULL AND num_nonnulls(source_message_id,article_id,video_id,poll_id)=1));
UPDATE auth_points_ledger SET capped=false WHERE poll_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_stars_event_once ON auth_points_ledger(user_id,event_code,event_ref) WHERE event_code IS NOT NULL;
CREATE TABLE IF NOT EXISTS auth_stars_wallet (
 user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
 legacy boolean NOT NULL DEFAULT false, joined_week integer, last_week integer,
 preserved_weeks integer[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE auth_stars_wallet ADD COLUMN IF NOT EXISTS preserved_weeks integer[] NOT NULL DEFAULT '{}';
-- Preserve unknown historical access. No opening-balance ledger operation.
CREATE TABLE IF NOT EXISTS auth_stars_launch (id integer PRIMARY KEY CHECK(id=1), launched_at timestamptz NOT NULL);
INSERT INTO auth_stars_launch VALUES(1,now()) ON CONFLICT DO NOTHING;
INSERT INTO auth_stars_wallet(user_id,legacy) SELECT u.id,true FROM auth_users u,auth_stars_launch l WHERE u.created_at<=l.launched_at ON CONFLICT DO NOTHING;
-- Legacy bonus boundary is the launch week, not a delayed first visit.
UPDATE auth_stars_wallet w SET joined_week=GREATEST(1,LEAST(42,FLOOR((280+
 ((l.launched_at AT TIME ZONE 'Europe/Moscow')::date-(u.profile->>'dueDate')::date))/7.0)::integer))
 FROM auth_users u,auth_stars_launch l WHERE w.user_id=u.id AND w.legacy AND w.joined_week IS NULL
 AND u.created_at<=l.launched_at AND u.profile->>'stage'='pregnancy'
 AND u.profile->>'completedAt' IS NOT NULL AND u.profile->>'dueDate' ~ '^\d{4}-\d{2}-\d{2}$';
UPDATE auth_stars_wallet SET last_week=joined_week WHERE legacy AND last_week IS NULL AND joined_week IS NOT NULL;
CREATE TABLE IF NOT EXISTS auth_stars_material_progress (
 user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 kind text NOT NULL, material_id text NOT NULL, week integer,
 completed_at timestamptz NOT NULL, reward_eligible boolean NOT NULL DEFAULT false,
 PRIMARY KEY(user_id,kind,material_id)
);
INSERT INTO auth_stars_material_progress(user_id,kind,material_id,completed_at)
 SELECT user_id,'article',article_id,occurred_at FROM auth_points_ledger WHERE article_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO auth_stars_material_progress(user_id,kind,material_id,completed_at)
 SELECT user_id,'video',video_id,occurred_at FROM auth_points_ledger WHERE video_id IS NOT NULL ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF to_regclass('auth_personal_records') IS NOT NULL THEN
  INSERT INTO auth_stars_material_progress(user_id,kind,material_id,completed_at)
   SELECT user_id,'article',record_id,created_at FROM auth_personal_records WHERE kind='article' ON CONFLICT DO NOTHING;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS auth_stars_weeks (
 user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, week integer NOT NULL CHECK(week BETWEEN 1 AND 42),
 completed_at timestamptz NOT NULL, released_at timestamptz, letter boolean NOT NULL DEFAULT false,
 PRIMARY KEY(user_id,week)
);
CREATE TABLE IF NOT EXISTS auth_stars_week_purchases (
 user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, week integer NOT NULL CHECK(week BETWEEN 1 AND 42),
 request_id text NOT NULL, purchased_at timestamptz NOT NULL, PRIMARY KEY(user_id,week), UNIQUE(user_id,request_id)
);
CREATE TABLE IF NOT EXISTS auth_stars_ai_credits (
 user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE, balance integer NOT NULL DEFAULT 0 CHECK(balance>=0)
);
CREATE TABLE IF NOT EXISTS auth_stars_course_views (
 user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, lesson_id text NOT NULL, video_key text NOT NULL,
 session_hash text NOT NULL, attempt_id uuid NOT NULL, last_seen_at timestamptz NOT NULL, duration_ms integer NOT NULL,
 watched jsonb NOT NULL DEFAULT '[]', PRIMARY KEY(user_id,lesson_id,video_key)
);
ALTER TABLE auth_stars_course_views ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE weekly_poll_votes DROP CONSTRAINT IF EXISTS weekly_poll_votes_points_check;
ALTER TABLE weekly_poll_votes ADD CONSTRAINT weekly_poll_votes_points_check CHECK(points BETWEEN 0 AND 65534);
