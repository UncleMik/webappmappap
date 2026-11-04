CREATE TABLE IF NOT EXISTS ai_chat_requests (
  id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  question text NOT NULL,
  question_hash text NOT NULL,
  rights_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','completed','failed')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  answer text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS ai_chat_requests_history ON ai_chat_requests(user_id, accepted_at DESC, request_id DESC);
CREATE TABLE IF NOT EXISTS ai_chat_daily_usage (
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  day_moscow date NOT NULL,
  used integer NOT NULL CHECK (used BETWEEN 0 AND 30),
  PRIMARY KEY (user_id, day_moscow)
);
