import { createHash } from 'node:crypto';
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
    count(r.user_id) FILTER (WHERE r.reaction='hug')::integer AS hug,
    count(r.user_id) FILTER (WHERE r.reaction='laugh')::integer AS laugh,
    max(r.reaction) FILTER (WHERE r.user_id=$2::uuid) AS selected
    FROM club_messages m LEFT JOIN club_message_reactions r ON r.message_id=m.id
    WHERE m.room=$1 AND m.id=ANY($3::bigint[]) GROUP BY m.id ORDER BY m.id`, [ROOM.id, userId, ids]);
  return rows.map(row => ({ messageId: String(row.id),
    counts: { heart: row.heart, love: row.love, like: row.like, hug: row.hug, laugh: row.laugh }, selected: row.selected }));
}
const columns = `m.id, m.body, m.created_at,m.deleted_at,m.revision, m.author_id=$2::uuid AS own,
  COALESCE(NULLIF(btrim(u.profile->>'name'),''),'Участница') AS author_name,
  r.id AS reply_id, r.body AS reply_body,r.deleted_at AS reply_deleted_at,
  COALESCE(NULLIF(btrim(ru.profile->>'name'),''),'Участница') AS reply_author`;
const joins = `FROM club_messages m JOIN auth_users u ON u.id=m.author_id
  LEFT JOIN club_messages r ON r.room=m.room AND r.id=m.reply_to_id
  LEFT JOIN auth_users ru ON ru.id=r.author_id`;
const format = (row, owner = false) => ({ id: String(row.id), text: row.deleted_at == null ? row.body : null,
  revision: String(row.revision), deleted: row.deleted_at != null,
  createdAt: new Date(row.created_at).toISOString(), own: row.own,
  canDelete: row.deleted_at == null && (row.own || owner), author: { name: row.author_name },
  reply: row.reply_id == null ? null : { id: String(row.reply_id),
    text: row.reply_deleted_at == null ? row.reply_body : null, deleted: row.reply_deleted_at != null, authorName: row.reply_author } });
const fingerprint = (text, replyTo) => createHash('sha256').update(JSON.stringify([text, replyTo])).digest('hex');
const cursorId = value => value === '0' || messageId(value);

export function createClubChat({ pool, service, courseChecks, store, ownerUserId = null, clock = Date.now }) {
  if (ownerUserId !== null && !uuid(ownerUserId)) throw new Error('Invalid Club owner');
  async function access(token, expectedAccountId, required, action, sending = false) {
    const user = await service.session(token);
    if (!user) throw signedOut();
    if (expectedAccountId !== undefined && (!uuid(expectedAccountId) || expectedAccountId !== user.id)) throw changed();
    if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы открыть чат.');
    const owner = ownerUserId !== null && user.id === ownerUserId.toLowerCase();
    let check, products;
    try {
      if (!courseChecks) throw unavailable();
      check = await courseChecks.requireCurrent(user.id);
      const now = clock(), end = Date.parse(check?.expiresAt), start = Date.parse(check?.checkedAt);
      if (!Number.isFinite(end) || !Number.isFinite(start) || start > now || end <= now || end <= start || end - start > 300_000) throw unavailable();
      products = activeCourseProducts(COURSES, check, now);
    } catch (error) {
      if (!owner || sending) throw error;
      check = { checkedAt: new Date(clock()).toISOString(), expiresAt: new Date(clock() + 60_000).toISOString() };
      products = [];
    }
    const canSend = products.length > 0, allowed = canSend || owner;
    if ((required && !allowed) || (sending && !canSend)) throw denied();
    let validUntil = canSend ? Math.max(...products.map(p => p.validUntil)) : Date.parse(check.expiresAt);
    if (owner) validUntil = Math.min(validUntil, clock() + 60_000);
    if (required) await store.rateLimit('club_read_or_send', user.id, 180);
    return transaction(pool, async client => {
      const { rows: [session] } = await client.query(`SELECT s.user_id,s.expires_at,u.profile
        FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 FOR SHARE OF s,u`,
      [hashToken(token), new Date(clock())]);
      if (!session) throw signedOut();
      if (session.user_id !== user.id) throw changed();
      if (!session.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы открыть чат.');
      if (clock() >= validUntil) throw unavailable();
      const result = await action(client, user.id, allowed, owner);
      if (clock() >= +new Date(session.expires_at)) throw signedOut();
      if (clock() >= validUntil) throw unavailable();
      return { ...result, accountId: user.id, serverTime: new Date(clock()).toISOString(),
        checkedAt: check.checkedAt, validUntil: new Date(validUntil).toISOString(), canSend, canModerate: owner };
    });
  }
  async function state(client, write = false) {
    const { rows: [row] } = await client.query(`SELECT revision FROM club_state WHERE room=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`, [ROOM.id]);
    if (!row) throw unavailable();
    return String(row.revision);
  }
  async function nextRevision(client) {
    const { rows: [row] } = await client.query('UPDATE club_state SET revision=revision+1 WHERE room=$1 RETURNING revision', [ROOM.id]);
    return String(row.revision);
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
      return access(token, expectedAccountId, true, async (client, userId, _, owner) => {
        const changeCursor = await state(client);
        const forward = direction === 'after';
        const condition = direction === 'latest' ? '' : ` AND m.id${forward ? '>' : '<'}$3::bigint`;
        const params = [ROOM.id, userId, ...(direction === 'latest' ? [] : [cursor])];
        const { rows } = await client.query(`SELECT ${columns} ${joins} WHERE m.room=$1 AND m.deleted_at IS NULL${condition}
          ORDER BY m.id ${forward ? 'ASC' : 'DESC'} LIMIT 51`, params);
        const messages = rows.slice(0, 50).map(row => format(row, owner));
        if (!forward) messages.reverse();
        return { room: ROOM, messages, hasMore: rows.length > 50, changeCursor,
          reactions: await reactionStates(client,userId,messages.map(m=>m.id)) };
      });
    },
    async reactions(token, expectedAccountId, data) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!data || Object.keys(data).some(key => key !== 'messageIds') || !Array.isArray(data.messageIds)
        || data.messageIds.length < 1 || data.messageIds.length > 100 || !data.messageIds.every(messageId)
        || new Set(data.messageIds).size !== data.messageIds.length) throw badReaction();
      return access(token, expectedAccountId, true, async (client, userId) => {
        await state(client);
        const reactions = await reactionStates(client, userId, data.messageIds);
        if (reactions.length !== data.messageIds.length) throw reactionMissing();
        return { reactions };
      });
    },
    async react(token, expectedAccountId, data) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!data || Object.keys(data).some(key => !['messageId', 'reaction'].includes(key))
        || !messageId(data.messageId) || ![null, 'heart', 'love', 'like', 'hug', 'laugh'].includes(data.reaction)) throw badReaction();
      return access(token, expectedAccountId, true, async (client, userId) => {
        // Serialize with deletion, preserving paid posting/reaction permissions.
        await state(client, true);
        const { rows } = await client.query('SELECT id FROM club_messages WHERE room=$1 AND id=$2::bigint AND deleted_at IS NULL', [ROOM.id, data.messageId]);
        if (!rows.length) throw reactionMissing();
        // Set the requested state instead of toggling: a lost acknowledgement can be retried safely.
        if (data.reaction === null) {
          await client.query('DELETE FROM club_message_reactions WHERE message_id=$1 AND user_id=$2', [data.messageId, userId]);
        } else {
          await client.query(`INSERT INTO club_message_reactions(message_id,user_id,reaction) VALUES($1,$2,$3)
            ON CONFLICT(message_id,user_id) DO UPDATE SET reaction=excluded.reaction`, [data.messageId, userId, data.reaction]);
        }
        return { reactions: await reactionStates(client, userId, [data.messageId]) };
      }, true);
    },
    async send(token, expectedAccountId, data) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).some(key => !['requestId', 'text', 'replyTo'].includes(key))
        || !uuid(data.requestId) || typeof data.text !== 'string'
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(data.text)) throw bad();
      const text = data.text.replace(/\r\n?/g, '\n').trim(), replyTo = data.replyTo ?? null;
      if (!text || text.length > 2000 || (replyTo !== null && !messageId(replyTo))) throw bad();
      return access(token, expectedAccountId, true, async (client, userId, _, owner) => {
        await state(client, true);
        const digest = fingerprint(text, replyTo);
        const { rows: [existing] } = await client.query(`SELECT ${columns},m.reply_to_id,m.request_digest ${joins}
          WHERE m.room=$1 AND m.author_id=$2 AND m.request_id=$3`, [ROOM.id, userId, data.requestId]);
        if (existing) {
          if ((existing.request_digest && existing.request_digest !== digest)
            || (!existing.request_digest && (existing.body !== text || String(existing.reply_to_id ?? '') !== String(replyTo ?? '')))) {
            throw new AuthError(409, 'chat_request_reused', 'Сообщение изменилось. Отправьте его ещё раз.');
          }
          return { message: format(existing, owner), duplicate: true,
            reactions: existing.deleted_at ? [] : await reactionStates(client,userId,[String(existing.id)]) };
        }
        if (replyTo !== null) {
          const { rows } = await client.query('SELECT id FROM club_messages WHERE room=$1 AND id=$2::bigint AND deleted_at IS NULL', [ROOM.id, replyTo]);
          if (!rows.length) throw new AuthError(400, 'reply_not_found', 'Сообщение для ответа удалено или не найдено.');
        }
        const revision = await nextRevision(client);
        await client.query(`INSERT INTO club_messages(room,author_id,request_id,body,reply_to_id,revision,request_digest)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [ROOM.id,userId,data.requestId,text,replyTo,revision,digest]);
        const { rows: [saved] } = await client.query(`SELECT ${columns} ${joins}
          WHERE m.room=$1 AND m.author_id=$2 AND m.request_id=$3`, [ROOM.id, userId, data.requestId]);
        return { message: format(saved, owner), duplicate: false, reactions: await reactionStates(client,userId,[String(saved.id)]) };
      }, true);
    },
    async changes(token, expectedAccountId, cursor) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!cursorId(cursor)) throw bad();
      return access(token, expectedAccountId, true, async (client, userId, _, owner) => {
        const latest = await state(client);
        if (BigInt(cursor) > BigInt(latest)) throw new AuthError(409,'chat_resync_required','Подключитесь к чату ещё раз.');
        const { rows } = await client.query(`SELECT ${columns} ${joins}
          WHERE m.room=$1 AND m.revision>$3::bigint AND m.revision<=$4::bigint ORDER BY m.revision ASC LIMIT 51`,
        [ROOM.id,userId,cursor,latest]);
        const messages = rows.slice(0,50).map(row => format(row, owner));
        return { room: ROOM, messages, hasMore: rows.length > 50,
          changeCursor: rows.length > 50 ? messages.at(-1).revision : latest,
          reactions: await reactionStates(client,userId,messages.filter(m=>!m.deleted).map(m=>m.id)) };
      });
    },
    async deleteMessage(token, expectedAccountId, id, data = {}) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!messageId(id) || !data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length) throw bad();
      return access(token, expectedAccountId, true, async (client, userId, _, owner) => {
        await state(client, true);
        const { rows: [message] } = await client.query('SELECT * FROM club_messages WHERE room=$1 AND id=$2::bigint FOR UPDATE', [ROOM.id,id]);
        if (!message) throw new AuthError(404,'chat_message_not_found','Сообщение не найдено.');
        if (message.author_id !== userId && !owner) throw new AuthError(403,'chat_delete_forbidden','Можно удалить только своё сообщение.');
        if (message.deleted_at) return { deletedId: id, duplicate: true };
        const revision = await nextRevision(client);
        await client.query('DELETE FROM club_message_reactions WHERE message_id=$1',[id]);
        await client.query(`UPDATE club_messages SET body='',deleted_at=$3,revision=$4,request_digest=COALESCE(request_digest,$5)
          WHERE room=$1 AND id=$2::bigint`, [ROOM.id,id,new Date(clock()),revision,
          fingerprint(message.body,message.reply_to_id == null ? null : String(message.reply_to_id))]);
        return { deletedId: id, duplicate: false };
      });
    },
  });
}
