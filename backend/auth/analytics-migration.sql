-- Behavioural telemetry contains identifiers/codes only, never request text or health data.
CREATE TABLE IF NOT EXISTS auth_analytics_state (
  id integer PRIMARY KEY CHECK(id=1),
  collection_started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO auth_analytics_state(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS auth_analytics_exclusions (
  user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS auth_analytics_events (
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  type text NOT NULL,
  page text NOT NULL,
  resource_type text,
  resource_id varchar(120),
  action text,
  active_ms integer NOT NULL DEFAULT 0 CHECK(active_ms BETWEEN 0 AND 60000),
  progress smallint CHECK(progress IN (25,50,75,90,100)),
  from_page text,
  format text,
  outcome text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,event_id),
  CHECK((resource_type IS NULL)=(resource_id IS NULL))
);
CREATE INDEX IF NOT EXISTS auth_analytics_events_time ON auth_analytics_events(recorded_at);
