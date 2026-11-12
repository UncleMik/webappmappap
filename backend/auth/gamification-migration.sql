CREATE TABLE IF NOT EXISTS auth_gamification_state (
 user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
 first_day date NOT NULL,
 data jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_gamification_actions (
 user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 request_id text NOT NULL,
 payload jsonb NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,request_id)
);
CREATE TABLE IF NOT EXISTS auth_gamification_launch (
 id integer PRIMARY KEY CHECK(id=1), launched_at timestamptz NOT NULL
);
