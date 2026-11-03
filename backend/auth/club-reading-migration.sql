-- Account-level reading position survives browser sessions. Message IDs are never removed.
CREATE TABLE IF NOT EXISTS club_reading (
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  room text NOT NULL REFERENCES club_state(room),
  last_read_id bigint NOT NULL CHECK (last_read_id >= 0),
  PRIMARY KEY (user_id, room)
);
CREATE INDEX IF NOT EXISTS club_messages_room_unread ON club_messages(room,id)
  WHERE deleted_at IS NULL;
