import { activeCourseProducts } from '../course-entitlements.mjs';
import { AuthError, hashToken } from './security.mjs';
import { transaction } from './store.mjs';

const ROOM = Object.freeze({ id: 'pregnancy-students', title: 'Лёгкие роды · Чат участниц' });
// The approved main course products, not bonus lessons or the Telegram group product.
const COURSES = [
  { productId: 4302509, trainingId: 935386893, type: 'training' },
  { productId: 4309095, trainingId: 935397478, type: 'training' },
];
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const messageId = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const bad = () => new AuthError(400, 'invalid_chat_message', 'Проверьте сообщение.');
const signedOut = () => new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
const changed = () => new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
const denied = () => new AuthError(403, 'club_course_required', 'Чат доступен при действующем доступе к курсу «Лёгкие роды».');
const unavailable = () => new AuthError(503, 'club_unavailable', 'Чат временно недоступен. Попробуйте ещё раз.');
const badReaction = () => new AuthError(400, 'invalid_chat_reaction', 'Выберите одну из доступных реакций.');
const reactionMissing = () => new AuthError(404, 'reaction_message_not_found', 'Сообщение для реакции не найдено.');
async function reactionStates(client, userId, ids) {
  if (!ids.length) return [];
  const { rows } = await client.query(`SELECT m.id,
    count(r.user_id) FILTER (WHERE r.reaction='heart')::integer AS heart,
    count(r.user_id) FILTER (WHERE r.reaction='love')::integer AS love,
    count(r.user_id) FILTER (WHERE r.reaction='like')::integer AS like,
    max(r.reaction) FILTER (WHERE r.user_id=$2::uuid) AS selected
    FROM club_messages m LEFT JOIN club_message_reactions r ON r.message_id=m.id
    WHERE m.room=$1 AND m.id=ANY($3::bigint[]) GROUP BY m.id ORDER BY m.id`, [ROOM.id, userId, ids]);
  return rows.map(row => ({ messageId: String(row.id),
    counts: { heart: row.heart, love: row.love, like: row.like }, selected: row.selected }));
}
const columns = `m.id, m.body, m.created_at, m.author_id=$2::uuid AS own,
  COALESCE(NULLIF(btrim(u.profile->>'name'),''),'Участница') AS author_name,
  r.id AS reply_id, r.body AS reply_body,
  COALESCE(NULLIF(btrim(ru.profile->>'name'),''),'Участница') AS reply_author`;
const joins = `FROM club_messages m JOIN auth_users u ON u.id=m.author_id
  LEFT JOIN club_messages r ON r.room=m.room AND r.id=m.reply_to_id
  LEFT JOIN auth_users ru ON ru.id=r.author_id`;
const format = row => ({ id: String(row.id), text: row.body, createdAt: new Date(row.created_at).toISOString(),
  own: row.own, author: { name: row.author_name }, reply: row.reply_id == null ? null
    : { id: String(row.reply_id), text: row.reply_body, authorName: row.reply_author } });

export function createClubChat({ pool, service, courseChecks, store, clock = Date.now }) {
  async function access(token, expectedAccountId, required, action) {
    const user = await service.session(token);
    if (!user) throw signedOut();
    if (expectedAccountId !== undefined && (!uuid(expectedAccountId) || expectedAccountId !== user.id)) throw changed();
    if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы открыть чат.');
    if (!courseChecks) throw unavailable();
    const check = await courseChecks.requireCurrent(user.id);
    const now = clock(), expiresAt = Date.parse(check?.expiresAt), checkedAt = Date.parse(check?.checkedAt);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(checkedAt) || checkedAt > now || expiresAt <= now
      || expiresAt <= checkedAt || expiresAt - checkedAt > 300_000) throw unavailable();
    const products = activeCourseProducts(COURSES, check, now);
    const allowed = products.length > 0;
    if (required && !allowed) throw denied();
    const validUntil = allowed ? Math.max(...products.map(p => p.validUntil)) : expiresAt;
    if (required) await store.rateLimit('club_read_or_send', user.id, 180);
    return transaction(pool, async client => {
      // Recheck after the external access lookup; login/revocation cannot race the read/write.
      const { rows: [session] } = await client.query(`SELECT s.user_id,s.expires_at,u.profile
        FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 FOR SHARE OF s,u`,
      [hashToken(token), new Date(clock())]);
      if (!session) throw signedOut();
      if (session.user_id !== user.id) throw changed();
      if (!session.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы открыть чат.');
      if (clock() >= validUntil) throw unavailable();
      const result = await action(client, user.id, allowed);
      if (clock() >= +new Date(session.expires_at)) throw signedOut();
      if (clock() >= validUntil) throw unavailable();
      return { ...result, accountId: user.id, serverTime: new Date(clock()).toISOString(),
        checkedAt: check.checkedAt, validUntil: new Date(validUntil).toISOString() };
    });
  }
  return Object.freeze({
    info(token, expectedAccountId) {
      return access(token, expectedAccountId, false, async (_, __, allowed) => ({ room: ROOM,
        access: allowed ? 'available' : 'purchase_required' }));
    },
    async messages(token, expectedAccountId, direction = 'latest', cursor) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!['latest', 'before', 'after'].includes(direction)
        || (direction !== 'latest' && !messageId(cursor) && !(direction === 'after' && cursor === '0'))) throw bad();
      return access(token, expectedAccountId, true, async (client, userId) => {
        const forward = direction === 'after';
        const condition = direction === 'latest' ? '' : ` AND m.id${forward ? '>' : '<'}$3::bigint`;
        const params = [ROOM.id, userId, ...(direction === 'latest' ? [] : [cursor])];
        const { rows } = await client.query(`SELECT ${columns} ${joins} WHERE m.room=$1${condition}
          ORDER BY m.id ${forward ? 'ASC' : 'DESC'} LIMIT 51`, params);
        const messages = rows.slice(0, 50).map(format);
        if (!forward) messages.reverse();
        return { room: ROOM, messages, hasMore: rows.length > 50,
          reactions: await reactionStates(client, userId, messages.map(message => message.id)) };
      });
    },
    async reactions(token, expectedAccountId, data) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!data || Object.keys(data).some(key => key !== 'messageIds') || !Array.isArray(data.messageIds)
        || data.messageIds.length < 1 || data.messageIds.length > 100 || !data.messageIds.every(messageId)
        || new Set(data.messageIds).size !== data.messageIds.length) throw badReaction();
      return access(token, expectedAccountId, true, async (client, userId) => {
        const reactions = await reactionStates(client, userId, data.messageIds);
        if (reactions.length !== data.messageIds.length) throw reactionMissing();
        return { reactions };
      });
    },
    async react(token, expectedAccountId, data) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!data || Object.keys(data).some(key => !['messageId', 'reaction'].includes(key))
        || !messageId(data.messageId) || ![null, 'heart', 'love', 'like'].includes(data.reaction)) throw badReaction();
      return access(token, expectedAccountId, true, async (client, userId) => {
        // Existing chat permissions allow reading messages; only reaction rows are modified.
        const { rows } = await client.query('SELECT id FROM club_messages WHERE room=$1 AND id=$2::bigint', [ROOM.id, data.messageId]);
        if (!rows.length) throw reactionMissing();
        // Set the requested state instead of toggling: a lost acknowledgement can be retried safely.
        if (data.reaction === null) {
          await client.query('DELETE FROM club_message_reactions WHERE message_id=$1 AND user_id=$2', [data.messageId, userId]);
        } else {
          await client.query(`INSERT INTO club_message_reactions(message_id,user_id,reaction) VALUES($1,$2,$3)
            ON CONFLICT(message_id,user_id) DO UPDATE SET reaction=excluded.reaction`, [data.messageId, userId, data.reaction]);
        }
        return { reactions: await reactionStates(client, userId, [data.messageId]) };
      });
    },
    async send(token, expectedAccountId, data) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).some(key => !['requestId', 'text', 'replyTo'].includes(key))
        || !uuid(data.requestId) || typeof data.text !== 'string'
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(data.text)) throw bad();
      const text = data.text.replace(/\r\n?/g, '\n').trim(), replyTo = data.replyTo ?? null;
      if (!text || text.length > 2000 || (replyTo !== null && !messageId(replyTo))) throw bad();
      return access(token, expectedAccountId, true, async (client, userId) => {
        if (replyTo !== null) {
          const { rows } = await client.query('SELECT id FROM club_messages WHERE room=$1 AND id=$2::bigint', [ROOM.id, replyTo]);
          if (!rows.length) throw new AuthError(400, 'reply_not_found', 'Сообщение для ответа не найдено.');
        }
        const { rows } = await client.query(`INSERT INTO club_messages(room,author_id,request_id,body,reply_to_id)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(author_id,request_id) DO NOTHING RETURNING id`,
        [ROOM.id, userId, data.requestId, text, replyTo]);
        const { rows: [saved] } = await client.query(`SELECT ${columns},m.reply_to_id ${joins}
          WHERE m.room=$1 AND m.author_id=$2 AND m.request_id=$3`, [ROOM.id, userId, data.requestId]);
        if (!saved || saved.body !== text || String(saved.reply_to_id ?? '') !== String(replyTo ?? '')) {
          throw new AuthError(409, 'chat_request_reused', 'Сообщение изменилось. Отправьте его ещё раз.');
        }
        return { message: format(saved), duplicate: rows.length === 0,
          reactions: await reactionStates(client, userId, [String(saved.id)]) };
      });
    },
  });
}
