CREATE TABLE IF NOT EXISTS ai_chat_conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  title_expires_at timestamptz,
  legacy boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(user_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_conversations_legacy ON ai_chat_conversations(user_id) WHERE legacy;
CREATE INDEX IF NOT EXISTS ai_chat_conversations_list ON ai_chat_conversations(user_id,updated_at DESC,id DESC);
ALTER TABLE ai_chat_requests ADD COLUMN IF NOT EXISTS conversation_id uuid;
-- Only metadata is inspected; previous questions and answers are not rewritten.
INSERT INTO ai_chat_conversations(id,user_id,title,legacy,created_at,updated_at)
  SELECT gen_random_uuid(),user_id,'Предыдущая переписка',true,min(accepted_at),max(accepted_at)
  FROM ai_chat_requests WHERE conversation_id IS NULL GROUP BY user_id
  ON CONFLICT(user_id) WHERE legacy DO NOTHING;
UPDATE ai_chat_requests r SET conversation_id=c.id FROM ai_chat_conversations c
  WHERE r.user_id=c.user_id AND c.legacy AND r.conversation_id IS NULL;
ALTER TABLE ai_chat_requests ALTER COLUMN conversation_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_chat_requests_conversation_owner'
    AND conrelid='ai_chat_requests'::regclass) THEN
    ALTER TABLE ai_chat_requests ADD CONSTRAINT ai_chat_requests_conversation_owner
      FOREIGN KEY(user_id,conversation_id) REFERENCES ai_chat_conversations(user_id,id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ai_chat_requests_conversation_history ON ai_chat_requests(user_id,conversation_id,id DESC);

-- Compatibility for already-open old clients and a code rollback during deployment.
CREATE OR REPLACE FUNCTION ai_chat_assign_legacy_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_id IS NULL THEN
    INSERT INTO ai_chat_conversations(id,user_id,title,legacy,created_at,updated_at)
      VALUES(gen_random_uuid(),NEW.user_id,'Предыдущая переписка',true,NEW.accepted_at,NEW.accepted_at)
      ON CONFLICT(user_id) WHERE legacy DO UPDATE SET
        created_at=LEAST(ai_chat_conversations.created_at,EXCLUDED.created_at),
        updated_at=GREATEST(ai_chat_conversations.updated_at,EXCLUDED.updated_at)
      RETURNING id INTO NEW.conversation_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_chat_assign_legacy_conversation ON ai_chat_requests;
CREATE TRIGGER ai_chat_assign_legacy_conversation BEFORE INSERT ON ai_chat_requests
  FOR EACH ROW EXECUTE FUNCTION ai_chat_assign_legacy_conversation();
