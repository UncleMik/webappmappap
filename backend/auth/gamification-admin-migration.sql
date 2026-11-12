CREATE TABLE IF NOT EXISTS gamification_settings (
 id integer PRIMARY KEY CHECK(id=1), value jsonb NOT NULL DEFAULT '{}',
 medical_approved boolean NOT NULL DEFAULT false, ai_budget_approved boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO gamification_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS gamification_content (
 id text PRIMARY KEY, kind text NOT NULL, body jsonb NOT NULL, medical boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved')),
 updated_by uuid REFERENCES auth_users(id), updated_at timestamptz NOT NULL,
 approved_by uuid REFERENCES auth_users(id), approved_at timestamptz, evidence text,
 CHECK(status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND evidence IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS gamification_audit (
 id bigserial PRIMARY KEY, actor_id uuid NOT NULL REFERENCES auth_users(id), action text NOT NULL,
 target text NOT NULL, before_value jsonb, after_value jsonb, reason text NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS gamification_notification_preferences (
 user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
 value jsonb NOT NULL DEFAULT '{}', last_visit_at timestamptz
);
CREATE TABLE IF NOT EXISTS gamification_notifications (
 id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 event_key text NOT NULL, type text NOT NULL, title text NOT NULL, body text NOT NULL,
 url text NOT NULL, baby_related boolean NOT NULL DEFAULT false, medical boolean NOT NULL DEFAULT false,
 priority integer NOT NULL, available_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
 read_at timestamptz, push_state text NOT NULL DEFAULT 'pending' CHECK(push_state IN ('pending','sent','suppressed','ambiguous')),
 UNIQUE(user_id,event_key)
);
CREATE INDEX IF NOT EXISTS gamification_notifications_queue ON gamification_notifications(user_id,available_at) WHERE push_state='pending';
CREATE TABLE IF NOT EXISTS gamification_push_subscriptions (
 user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
 endpoint text NOT NULL UNIQUE, subscription jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS gamification_push_days (
 user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 local_day text NOT NULL, notification_id bigint REFERENCES gamification_notifications(id),
 state text NOT NULL CHECK(state IN ('reserved','sent','failed','ambiguous')), created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,local_day)
);
CREATE TABLE IF NOT EXISTS gamification_presentations (
 user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('hint','celebration')), period text NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,kind,period)
);

-- Revision binding prevents edited or revoked text being sent from an old queue.
ALTER TABLE gamification_notifications ADD COLUMN IF NOT EXISTS content_id text REFERENCES gamification_content(id);
ALTER TABLE gamification_notifications ADD COLUMN IF NOT EXISTS content_revision integer;
ALTER TABLE gamification_push_subscriptions ADD COLUMN IF NOT EXISTS session_hash text;
-- Old subscriptions have no session proof and require a fresh explicit opt-in.
CREATE TABLE IF NOT EXISTS auth_gamification_visits (
 user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 moscow_day date NOT NULL, PRIMARY KEY(user_id,moscow_day)
);
CREATE TABLE IF NOT EXISTS auth_stars_legacy_reviews (
 user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
 preserved_weeks integer[] NOT NULL DEFAULT '{}',
 resolved_by uuid NOT NULL REFERENCES auth_users(id), resolved_at timestamptz NOT NULL, evidence text NOT NULL
);
