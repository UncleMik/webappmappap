-- First Club release: the single, approved Light Births student room.
CREATE TABLE IF NOT EXISTS club_messages (
  id bigserial PRIMARY KEY,
  room text NOT NULL CHECK (room = 'pregnancy-students'),
  author_id uuid NOT NULL REFERENCES auth_users(id),
  request_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000 AND length(btrim(body)) > 0),
  reply_to_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (author_id, request_id),
  UNIQUE (room, id),
  FOREIGN KEY (room, reply_to_id) REFERENCES club_messages(room, id)
);
CREATE INDEX IF NOT EXISTS club_messages_room_id ON club_messages(room, id);
