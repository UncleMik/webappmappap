-- Preserve IDs/reply links, but erase the deleted message text.
ALTER TABLE club_messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE club_messages ADD COLUMN IF NOT EXISTS revision bigint;
ALTER TABLE club_messages ADD COLUMN IF NOT EXISTS request_digest text;
UPDATE club_messages SET revision=id WHERE revision IS NULL;
ALTER TABLE club_messages ALTER COLUMN revision SET NOT NULL;
ALTER TABLE club_messages ALTER COLUMN revision SET DEFAULT 0;
ALTER TABLE club_messages DROP CONSTRAINT IF EXISTS club_messages_body_check;
UPDATE club_messages SET body='' WHERE deleted_at IS NOT NULL;
ALTER TABLE club_messages ALTER COLUMN body SET NOT NULL;
ALTER TABLE club_messages ADD CONSTRAINT club_messages_body_check CHECK (
  (deleted_at IS NULL AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 2000 AND length(btrim(body)) > 0)
  OR (deleted_at IS NOT NULL AND body='')
);
CREATE TABLE IF NOT EXISTS club_state (
  room text PRIMARY KEY CHECK (room='pregnancy-students'),
  revision bigint NOT NULL CHECK (revision>=0)
);
INSERT INTO club_state(room,revision)
  SELECT 'pregnancy-students',COALESCE(max(revision),0) FROM club_messages
  ON CONFLICT(room) DO UPDATE SET revision=GREATEST(club_state.revision,excluded.revision);
CREATE INDEX IF NOT EXISTS club_messages_room_revision ON club_messages(room,revision);
