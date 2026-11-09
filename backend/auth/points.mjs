import { AuthError, hashToken, isUuid } from './security.mjs';
import { transaction } from './store.mjs';

const CLUB_MESSAGE_POINTS = 5;
const PAGE_SIZE = 20;
const signedOut = () => new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
export const isPointsCursor = value => typeof value === 'string' &&
  /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

export function createPoints({ pool, userIds, forAll = false, clock = Date.now }) {
  const allowed = new Set(userIds);
  const includes = userId => forAll || allowed.has(userId);
  return {
    includes,
    async awardClubMessage(client, userId, messageId) {
      await client.query(`INSERT INTO auth_points_ledger(user_id,source_message_id,occurred_at,moscow_day,amount)
        SELECT author_id,id,created_at,(created_at AT TIME ZONE 'Europe/Moscow')::date,$3
        FROM club_messages WHERE id=$1 AND author_id=$2
        ON CONFLICT DO NOTHING`, [messageId, userId, CLUB_MESSAGE_POINTS]);
    },
    async read(token, expectedAccountId, before) {
      if (!token) throw signedOut();
      return transaction(pool, async client => {
        const { rows: [session] } = await client.query(`SELECT user_id,expires_at FROM auth_sessions
          WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>$2 FOR SHARE`, [hashToken(token), new Date(clock())]);
        if (!session || +session.expires_at <= clock()) throw signedOut();
        const userId = session.user_id;
        if (!isUuid(expectedAccountId) || expectedAccountId !== userId) {
          throw new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
        }
        if (!includes(userId)) return { accountId: userId, enabled: false };
        const { rows } = await client.query(`SELECT totals.balance,page.id,page.amount,page.occurred_at
          FROM (SELECT COALESCE(sum(amount),0) AS balance FROM auth_points_ledger WHERE user_id=$1) totals
          LEFT JOIN LATERAL (
            SELECT id,amount,occurred_at FROM auth_points_ledger
            WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2::bigint)
            ORDER BY id DESC LIMIT $3
          ) page ON true
          ORDER BY page.id DESC`, [userId, before ?? null, PAGE_SIZE + 1]);
        if (+session.expires_at <= clock()) throw signedOut();
        const history = rows.filter(row => row.id !== null).slice(0, PAGE_SIZE).map(row => ({
          id: String(row.id), kind: 'club_message', amount: row.amount, occurredAt: row.occurred_at.toISOString(),
        }));
        return { accountId: userId, enabled: true, balance: Number(rows[0].balance), history,
          nextCursor: rows.length > PAGE_SIZE ? history.at(-1).id : null };
      });
    },
  };
}
