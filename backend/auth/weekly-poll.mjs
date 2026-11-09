import { AuthError, hashToken } from './security.mjs';
import { transaction } from './store.mjs';

export function createWeeklyPoll(pool) {
  return {
    async read(userId) {
      const { rows: [poll] } = await pool.query(`
        SELECT p.id, p.question, p.options, p.closes_at AS "closesAt",
               p.closes_at > now() AS open, v.choice, v.points,
               CASE WHEN p.settled_at IS NOT NULL THEN ARRAY(
                 SELECT count(w.choice)::integer
                 FROM generate_subscripts(p.options, 1) AS option
                 LEFT JOIN weekly_poll_votes w ON w.poll_id = p.id AND w.choice = option - 1
                 GROUP BY option ORDER BY option
               ) END AS counts
        FROM weekly_polls p
        LEFT JOIN weekly_poll_votes v ON v.poll_id = p.id AND v.user_id = $1
        WHERE p.opens_at <= now()
        ORDER BY p.opens_at DESC LIMIT 1
      `, [userId]);
      const { rows: [total] } = await pool.query(`
        SELECT coalesce(sum(points), 0)::integer AS points
        FROM weekly_poll_votes WHERE user_id = $1
      `, [userId]);
      return { poll: poll ?? null, points: total.points, accountId: userId };
    },
    vote(token, accountId, { pollId, choice }) {
      if (typeof pollId !== 'string' || !Number.isInteger(choice) || choice < 0) {
        throw new AuthError(400, 'invalid_vote', 'Выберите вариант ответа.');
      }
      return transaction(pool, async client => {
        const { rows: [session] } = await client.query(`
          SELECT user_id FROM auth_sessions WHERE token_hash = $1
          AND revoked_at IS NULL AND expires_at > now() FOR SHARE
        `, [hashToken(token || '')]);
        if (!session) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
        if (session.user_id !== accountId) {
          throw new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
        }
        const { rows: [poll] } = await client.query(`
          SELECT options FROM weekly_polls WHERE id = $1 FOR SHARE
        `, [pollId]);
        if (!poll || choice >= poll.options.length) {
          throw new AuthError(400, 'invalid_vote', 'Выберите вариант ответа.');
        }
        await client.query(`
          INSERT INTO weekly_poll_votes (poll_id, user_id, choice)
          SELECT id, $2, $3 FROM weekly_polls WHERE id = $1
            AND opens_at <= clock_timestamp() AND closes_at > clock_timestamp()
          ON CONFLICT (poll_id, user_id) DO NOTHING
        `, [pollId, session.user_id, choice]);
        const { rows: [vote] } = await client.query(`
          SELECT choice FROM weekly_poll_votes WHERE poll_id = $1 AND user_id = $2
        `, [pollId, session.user_id]);
        if (!vote) throw new AuthError(409, 'poll_closed', 'Голосование уже завершилось.');
        return vote;
      });
    },
    settle() {
      return transaction(pool, async client => {
        const { rows: polls } = await client.query(`
          SELECT id FROM weekly_polls WHERE settled_at IS NULL AND closes_at <= now()
          ORDER BY id FOR UPDATE
        `);
        for (const { id } of polls) {
          await client.query(`
            WITH counts AS (
              SELECT choice, count(*) AS votes FROM weekly_poll_votes
              WHERE poll_id = $1 GROUP BY choice
            )
            UPDATE weekly_poll_votes v
            SET points = CASE WHEN c.votes = (SELECT max(votes) FROM counts) THEN 100 ELSE 50 END
            FROM counts c WHERE v.poll_id = $1 AND v.choice = c.choice
          `, [id]);
          await client.query(`
            INSERT INTO auth_points_ledger (user_id, poll_id, occurred_at, moscow_day, amount)
            SELECT v.user_id, v.poll_id, p.closes_at, (p.closes_at AT TIME ZONE 'Europe/Moscow')::date, v.points
            FROM weekly_poll_votes v JOIN weekly_polls p ON p.id = v.poll_id WHERE v.poll_id = $1
            ON CONFLICT DO NOTHING
          `, [id]);
          await client.query('UPDATE weekly_polls SET settled_at = now() WHERE id = $1', [id]);
        }
      });
    }
  };
}
