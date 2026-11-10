BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

DO $replace_poll$
DECLARE
  replaced weekly_polls%ROWTYPE;
  opened_at timestamptz;
BEGIN
  SELECT * INTO STRICT replaced FROM weekly_polls WHERE id = '2026-11-09' FOR UPDATE;
  opened_at := clock_timestamp();
  IF replaced.question <> 'Какая тема вам сейчас полезнее?'
    OR replaced.settled_at IS NOT NULL OR replaced.opens_at >= opened_at
    OR replaced.closes_at <> timestamptz '2026-11-15 18:00+03'
    OR replaced.closes_at <= opened_at
    OR EXISTS (SELECT FROM weekly_polls WHERE opens_at > replaced.opens_at AND opens_at < replaced.closes_at)
  THEN
    RAISE EXCEPTION 'Expected original poll is no longer active or a replacement already exists';
  END IF;

  UPDATE weekly_polls SET closes_at = opened_at WHERE id = replaced.id;
  INSERT INTO weekly_polls (id, question, options, opens_at, closes_at)
  VALUES (
    '2026-11-09-help',
    'Должен ли муж помогать беременной жене, если он пришёл домой уставшим с работы?',
    ARRAY['Да, должен', 'Нет, не должен', 'Должен по желанию'],
    opened_at,
    replaced.closes_at
  );
END
$replace_poll$;

COMMIT;
