-- Add rooms without moving or removing legacy history, reactions, replies or readings.
ALTER TABLE club_messages DROP CONSTRAINT IF EXISTS club_messages_room_check;
ALTER TABLE club_messages ADD CONSTRAINT club_messages_room_check CHECK (room IN ('pregnancy-students', 'pregnancy-trimester-1', 'pregnancy-trimester-2', 'pregnancy-trimester-3', 'mother-0-6', 'mother-6-plus', 'experts-birth', 'experts-motherhood', 'weekly-activity'));
ALTER TABLE club_state DROP CONSTRAINT IF EXISTS club_state_room_check;
ALTER TABLE club_state ADD CONSTRAINT club_state_room_check CHECK (room IN ('pregnancy-students', 'pregnancy-trimester-1', 'pregnancy-trimester-2', 'pregnancy-trimester-3', 'mother-0-6', 'mother-6-plus', 'experts-birth', 'experts-motherhood', 'weekly-activity'));
INSERT INTO club_state(room,revision) VALUES
  ('pregnancy-trimester-1',0),('pregnancy-trimester-2',0),('pregnancy-trimester-3',0),
  ('mother-0-6',0),('mother-6-plus',0),('experts-birth',0),('experts-motherhood',0),('weekly-activity',0)
  ON CONFLICT(room) DO NOTHING;

ALTER TABLE club_messages ADD COLUMN IF NOT EXISTS screenshot bytea;
