-- One current reaction per account and message; chat history is preserved.
CREATE TABLE IF NOT EXISTS club_message_reactions (
  message_id bigint NOT NULL REFERENCES club_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  reaction text NOT NULL CHECK (reaction IN ('heart', 'love', 'like')),
  PRIMARY KEY (message_id, user_id)
);
