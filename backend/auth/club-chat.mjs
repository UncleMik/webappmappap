import { containsClubLink, maskClubProfanity } from './club-message-filter.mjs';
import { createHash } from 'node:crypto';
import { AuthError, hashToken, isUuid as uuid } from './security.mjs';
import { transaction } from './store.mjs';
import { decodePhoto } from './profile-photo.mjs';

export const CLUB_ROOMS = Object.freeze([
  ...[1, 2, 3].map(n => Object.freeze({ id: `pregnancy-trimester-${n}`, title: `Беременность — ${n} триместр`, kind: 'participants' })),
  Object.freeze({ id: 'mother-0-6', title: 'Я мама — от 0 до 6 месяцев', kind: 'participants' }),
  Object.freeze({ id: 'mother-6-plus', title: 'Я мама — от 6 месяцев', kind: 'participants' }),
  Object.freeze({ id: 'experts-birth', title: 'По родам', kind: 'experts' }),
  Object.freeze({ id: 'experts-motherhood', title: 'По материнству', kind: 'experts' }),
]);
const activityRoom = Object.freeze({ id: 'weekly-activity', title: 'Активности недели', kind: 'participants' });
const messageId = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const bad = () => new AuthError(400, 'invalid_chat_message', 'Проверьте сообщение.');
const signedOut = () => new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
const changed = () => new AuthError(409, 'account_changed', 'Аккаунт изменился. Обновите страницу.');
const denied = () => new AuthError(403, 'club_course_required', 'Экспертный чат доступен при действующей покупке курса школы.');
const unavailable = () => new AuthError(503, 'club_unavailable', 'Чат временно недоступен. Попробуйте ещё раз.');
const badReaction = () => new AuthError(400, 'invalid_chat_reaction', 'Выберите одну из доступных реакций.');
const reactionMissing = () => new AuthError(404, 'reaction_message_not_found', 'Сообщение для реакции не найдено.');
const missing = () => new AuthError(404, 'chat_message_not_found', 'Сообщение не найдено.');
const badSearch = () => new AuthError(400, 'invalid_chat_search', 'Введите от 2 до 100 символов для поиска.');
async function roomReactionStates(client, userId, ids, ROOM) {
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
const columns = `m.id, m.body, m.created_at,m.deleted_at,m.revision, m.screenshot IS NOT NULL AS has_screenshot, m.author_id=$2::uuid AS own,
  COALESCE(NULLIF(btrim(u.profile->>'name'),''),'Участница') AS author_name,
  r.id AS reply_id, r.body AS reply_body,r.deleted_at AS reply_deleted_at,
  COALESCE(NULLIF(btrim(ru.profile->>'name'),''),'Участница') AS reply_author`;
const joins = `FROM club_messages m JOIN auth_users u ON u.id=m.author_id
  LEFT JOIN club_messages r ON r.room=m.room AND r.id=m.reply_to_id
  LEFT JOIN auth_users ru ON ru.id=r.author_id`;
const format = (row, owner = false) => ({ id: String(row.id), text: row.deleted_at == null ? maskClubProfanity(row.body) : null,
  ...(row.has_screenshot && !row.deleted_at ? { hasScreenshot: true } : {}),
  revision: String(row.revision), deleted: row.deleted_at != null,
  createdAt: new Date(row.created_at).toISOString(), own: row.own,
  canDelete: row.deleted_at == null && (row.own || owner), author: { name: row.author_name },
  reply: row.reply_id == null ? null : { id: String(row.reply_id),
    text: row.reply_deleted_at == null ? maskClubProfanity(row.reply_body) : null, deleted: row.reply_deleted_at != null, authorName: row.reply_author } });
const fingerprint = (text, replyTo, screenshot) => createHash('sha256')
  .update(JSON.stringify(screenshot ? [text, replyTo, screenshot] : [text, replyTo])).digest('hex');
const cursorId = value => value === '0' || messageId(value);

function createRoomChat({ pool, service, courseMaterials, store, points, ownerUserId = null, clock = Date.now }, ROOM) {
  const reactionStates = (client, userId, ids) => roomReactionStates(client, userId, ids, ROOM);
  if (ownerUserId !== null && !uuid(ownerUserId)) throw new Error('Invalid Club owner');
  async function access(token, expectedAccountId, required, action, sending = false) {
    const user = await service.session(token);
    if (!user) throw signedOut();
    if (expectedAccountId !== undefined && (!uuid(expectedAccountId) || expectedAccountId !== user.id)) throw changed();
    if (!user.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы открыть чат.');
    const owner = ownerUserId !== null && user.id === ownerUserId.toLowerCase();
    const pollRoom = ROOM.kind === 'poll';
    const free = pollRoom || ROOM.kind === 'participants';
    let check = { checkedAt: new Date(clock()).toISOString(), expiresAt: new Date(clock() + 60_000).toISOString() };
    let canSend = free, validUntil = Date.parse(check.expiresAt);
    if (!free) {
      try {
        if (!courseMaterials) throw unavailable();
        const rights = await courseMaterials.list(user.id);
        const now = clock(), end = Date.parse(rights.expiresAt), start = Date.parse(rights.checkedAt);
        validUntil = Date.parse(rights.validUntil);
        if (!Number.isFinite(end) || !Number.isFinite(start) || !Number.isFinite(validUntil)
          || start > now || end <= now || end <= start || end - start > 300_000
          || validUntil > end || validUntil <= now || !Array.isArray(rights.courses)) throw unavailable();
        check = rights;
        canSend = rights.courses.length > 0;
      } catch (error) {
        if (!owner || sending) throw unavailable();
        check = { checkedAt: new Date(clock()).toISOString(), expiresAt: new Date(clock() + 60_000).toISOString() };
        validUntil = Date.parse(check.expiresAt);
      }
    }
    const allowed = canSend || owner;
    if ((required && !allowed) || (sending && !canSend)) throw denied();
    if (owner && !free) validUntil = Math.min(validUntil, clock() + 60_000);
    if (required) await store.rateLimit('club_read_or_send', user.id, 180);
    return transaction(pool, async client => {
      const { rows: [session] } = await client.query(`SELECT s.user_id,s.expires_at,u.profile
        FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 FOR SHARE OF s,u`,
      [hashToken(token), new Date(clock())]);
      if (!session) throw signedOut();
      if (session.user_id !== user.id) throw changed();
      if (!session.profile?.completedAt) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы открыть чат.');
      let room = ROOM;
      if (pollRoom) {
        const { rows: [poll] } = await client.query(`
          SELECT p.question, p.closes_at, v.user_id IS NOT NULL AS voted
          FROM weekly_polls p
          LEFT JOIN weekly_poll_votes v ON v.poll_id = p.id AND v.user_id = $2
          WHERE p.id = $1 AND p.opens_at <= clock_timestamp() AND p.closes_at > clock_timestamp()
          FOR SHARE OF p
        `, [ROOM.pollId, user.id]);
        if (!poll) throw new AuthError(410, 'poll_chat_closed', 'Обсуждение завершилось.');
        if (!poll.voted) throw new AuthError(403, 'poll_vote_required', 'Проголосуйте, чтобы открыть обсуждение.');
        validUntil = Math.min(validUntil, +new Date(poll.closes_at));
        room = { id: ROOM.id, kind: ROOM.kind, title: poll.question };
        await client.query(`
          INSERT INTO club_state(room, revision)
          SELECT $1, 0 WHERE NOT EXISTS (SELECT 1 FROM club_state WHERE room = $1)
          ON CONFLICT (room) DO NOTHING
        `, [ROOM.id]);
      }
      validUntil = Math.min(validUntil, +new Date(session.expires_at));
      if (clock() >= validUntil) throw unavailable();
      const result = await action(client, user.id, allowed, owner);
      if (clock() >= +new Date(session.expires_at)) throw signedOut();
      if (clock() >= validUntil) throw unavailable();
      return { ...result, room, accountId: user.id, serverTime: new Date(clock()).toISOString(),
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
  // Call only while holding the room state lock: the cursor and message snapshot agree.
  async function readState(client, userId) {
    const { rows: [position] } = await client.query('SELECT last_read_id FROM club_reading WHERE user_id=$1 AND room=$2', [userId, ROOM.id]);
    if (!position) return { initialized: false, lastReadId: '0', unreadCount: 0, firstUnreadId: null };
    const { rows: [unread] } = await client.query(`SELECT count(*)::integer AS count,min(id) AS first
      FROM club_messages WHERE room=$1 AND id>$2::bigint AND author_id<>$3 AND deleted_at IS NULL`,
    [ROOM.id, position.last_read_id, userId]);
    return { initialized: true, lastReadId: String(position.last_read_id), unreadCount: unread.count,
      firstUnreadId: unread.first == null ? null : String(unread.first) };
  }
  async function page(client, userId, messages, changeCursor) {
    const first = messages[0]?.id, last = messages.at(-1)?.id;
    const { rows: [edges] } = await client.query(`SELECT
      EXISTS(SELECT 1 FROM club_messages WHERE room=$1 AND deleted_at IS NULL AND id<$2::bigint) AS before,
      EXISTS(SELECT 1 FROM club_messages WHERE room=$1 AND deleted_at IS NULL AND id>$3::bigint) AS after`,
    [ROOM.id, first ?? '0', last ?? '9223372036854775807']);
    return { room: ROOM, messages, hasBefore: edges.before, hasAfter: edges.after, changeCursor,
      readState: await readState(client, userId), reactions: await reactionStates(client, userId, messages.map(m => m.id)) };
  }
  return Object.freeze({
    info(token, expectedAccountId) {
      return access(token, expectedAccountId, false, async (client, userId, allowed) => {
        if (allowed) await state(client);
        return { room: ROOM, access: allowed ? 'available' : 'purchase_required',
          readState: allowed ? await readState(client, userId)
            : { initialized: false, lastReadId: '0', unreadCount: 0, firstUnreadId: null } };
      });
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
        const result = await page(client, userId, messages, changeCursor);
        // An exhausted directional page still describes the opposite side of its boundary.
        if (!messages.length && direction !== 'latest') {
          const { rows: [edge] } = await client.query(`SELECT EXISTS(SELECT 1 FROM club_messages
            WHERE room=$1 AND deleted_at IS NULL AND id${forward ? '<=' : '>='}$2::bigint) AS present`, [ROOM.id, cursor]);
          if (forward) result.hasBefore = edge.present; else result.hasAfter = edge.present;
        }
        return { ...result, hasMore: rows.length > 50 };
      });
    },
    async markRead(token, expectedAccountId, data) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).some(key => key !== 'messageId') || !cursorId(data.messageId)) throw bad();
      return access(token, expectedAccountId, true, async (client, userId) => {
        await state(client, true);
        // A deleted message remains a valid historical position. Zero initializes an empty room only.
        const { rows: [valid] } = await client.query(data.messageId === '0'
          ? 'SELECT NOT EXISTS(SELECT 1 FROM club_messages WHERE room=$1 AND deleted_at IS NULL) AS ok'
          : 'SELECT EXISTS(SELECT 1 FROM club_messages WHERE room=$1 AND id=$2::bigint) AS ok',
        data.messageId === '0' ? [ROOM.id] : [ROOM.id, data.messageId]);
        if (!valid.ok) throw missing();
        await client.query(`INSERT INTO club_reading(user_id,room,last_read_id) VALUES($1,$2,$3)
          ON CONFLICT(user_id,room) DO UPDATE SET last_read_id=GREATEST(club_reading.last_read_id,excluded.last_read_id)`,
        [userId, ROOM.id, data.messageId]);
        return { room: ROOM, readState: await readState(client, userId) };
      });
    },
    async around(token, expectedAccountId, id) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!messageId(id)) throw bad();
      return access(token, expectedAccountId, true, async (client, userId, _, owner) => {
        const changeCursor = await state(client);
        const { rows: target } = await client.query(`SELECT ${columns} ${joins}
          WHERE m.room=$1 AND m.id=$3::bigint AND m.deleted_at IS NULL`, [ROOM.id, userId, id]);
        if (!target.length) throw missing();
        const { rows: older } = await client.query(`SELECT ${columns} ${joins}
          WHERE m.room=$1 AND m.id<$3::bigint AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 25`, [ROOM.id, userId, id]);
        const { rows: newer } = await client.query(`SELECT ${columns} ${joins}
          WHERE m.room=$1 AND m.id>$3::bigint AND m.deleted_at IS NULL ORDER BY m.id ASC LIMIT 24`, [ROOM.id, userId, id]);
        const result = await page(client, userId, [...older.reverse(), ...target, ...newer].map(row => format(row, owner)), changeCursor);
        return { ...result, hasMore: result.hasBefore };
      });
    },
    async search(token, expectedAccountId, data) {
      if (!uuid(expectedAccountId)) throw changed();
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).some(key => !['query', 'before'].includes(key))
        || typeof data.query !== 'string' || [...data.query.trim()].length < 2 || [...data.query.trim()].length > 100
        || /[\u0000-\u001f\u007f]/u.test(data.query)
        || (data.before !== undefined && !messageId(data.before))) throw badSearch();
      const pattern = '%' + data.query.trim().replace(/[\\%_]/g, value => '\\' + value) + '%';
      return access(token, expectedAccountId, true, async (client, userId, _, owner) => {
        const changeCursor = await state(client);
        const { rows } = await client.query(`SELECT ${columns} ${joins}
          WHERE m.room=$1 AND m.deleted_at IS NULL AND m.body ILIKE $3 ESCAPE E'\\\\'
          ${data.before === undefined ? '' : 'AND m.id<$4::bigint'} ORDER BY m.id DESC LIMIT 31`,
        [ROOM.id, userId, pattern, ...(data.before === undefined ? [] : [data.before])]);
        const messages = rows.slice(0, 30).map(row => format(row, owner)), hasMore = rows.length > 30;
        return { room: ROOM, messages, hasMore, nextBefore: hasMore ? messages.at(-1).id : null, changeCursor,
          readState: await readState(client, userId), reactions: await reactionStates(client, userId, messages.map(m => m.id)) };
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
        || Object.keys(data).some(key => !['requestId', 'text', 'replyTo', 'screenshot'].includes(key))
        || !uuid(data.requestId) || typeof data.text !== 'string'
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(data.text)) throw bad();
      const text = data.text.replace(/\r\n?/g, '\n').trim(), replyTo = data.replyTo ?? null;
      if ((!text && data.screenshot === undefined) || text.length > 2000 || (replyTo !== null && !messageId(replyTo))) throw bad();
      return access(token, expectedAccountId, true, async (client, userId, _, owner) => {
        await state(client, true);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId + ':' + data.requestId]);
        const { rows: reused } = await client.query('SELECT room FROM club_messages WHERE author_id=$1 AND request_id=$2', [userId, data.requestId]);
        if (reused.length && reused[0].room !== ROOM.id) throw new AuthError(409, 'chat_request_reused', 'Сообщение изменилось. Отправьте его ещё раз.');
        const screenshot = data.screenshot === undefined ? null : decodePhoto(data.screenshot, {
          maxDimension: 1400, invalidPhoto: () => new AuthError(400, 'invalid_screenshot', 'Выберите изображение размером до 350 КБ.')
        });
        const digest = fingerprint(text, replyTo, data.screenshot);
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
        if (containsClubLink(text)) {
          throw new AuthError(400, 'chat_links_forbidden', 'В чатах Клуба нельзя отправлять ссылки. Удалите ссылку и отправьте сообщение снова.');
        }
        if (replyTo !== null) {
          const { rows } = await client.query('SELECT id FROM club_messages WHERE room=$1 AND id=$2::bigint AND deleted_at IS NULL', [ROOM.id, replyTo]);
          if (!rows.length) throw new AuthError(400, 'reply_not_found', 'Сообщение для ответа удалено или не найдено.');
        }
        const eligibleForPoints = points?.includes(userId);
        if (eligibleForPoints) await points.lockAccount(client, userId);
        const createdAt = eligibleForPoints ? new Date(clock()) : null;
        const revision = await nextRevision(client);
        await client.query(`INSERT INTO club_messages(room,author_id,request_id,body,reply_to_id,revision,request_digest,created_at,screenshot)
          VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,now()),$9)`,
        [ROOM.id,userId,data.requestId,maskClubProfanity(text) || (ROOM === activityRoom ? 'Скриншот активности' : 'Изображение'),replyTo,revision,digest,createdAt,screenshot]);
        const { rows: [saved] } = await client.query(`SELECT ${columns} ${joins}
          WHERE m.room=$1 AND m.author_id=$2 AND m.request_id=$3`, [ROOM.id, userId, data.requestId]);
        if (eligibleForPoints) await points.awardClubMessage(client, userId, saved.id, createdAt);
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
          readState: await readState(client, userId),
          reactions: await reactionStates(client,userId,messages.filter(m=>!m.deleted).map(m=>m.id)) };
      });
    },
    async screenshot(token, id) {
      if (!messageId(id)) throw missing();
      const { bytes } = await access(token, undefined, true, async client => {
        const { rows: [message] } = await client.query(
          'SELECT screenshot FROM club_messages WHERE room=$1 AND id=$2 AND deleted_at IS NULL', [ROOM.id, id]);
        if (!message?.screenshot) throw missing();
        return { bytes: message.screenshot };
      });
      return bytes;
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
        await client.query(`UPDATE club_messages SET body='',screenshot=NULL,deleted_at=$3,revision=$4,request_digest=COALESCE(request_digest,$5)
          WHERE room=$1 AND id=$2::bigint`, [ROOM.id,id,new Date(clock()),revision,
          fingerprint(message.body,message.reply_to_id == null ? null : String(message.reply_to_id))]);
        return { deletedId: id, duplicate: false };
      });
    },
  });
}

// Room choice is explicit at the API boundary; legacy room IDs are never exposed.
export function createClubChat(options) {
  const rooms = new Map([...CLUB_ROOMS, activityRoom].map(room => [room.id, createRoomChat(options, room)]));
  const selected = id => {
    const room = rooms.get(id);
    if (room) return room;
    const poll = typeof id === 'string' && /^weekly-poll:([a-zA-Z0-9_-]+)$/.exec(id);
    if (poll) return createRoomChat(options, { id, kind: 'poll', pollId: poll[1] });
    throw new AuthError(404, 'club_room_not_found', 'Чат не найден.');
  };
  const methods = {};
  const arity = { messages: 4, markRead: 3, around: 3, search: 3, reactions: 3, react: 3, send: 3, changes: 3, screenshot: 2, deleteMessage: 4 };
  for (const [name, count] of Object.entries(arity)) methods[name] = async (...args) => selected(args[count])[name](...args.slice(0, count));
  return Object.freeze({ ...methods,
    async info(token, expectedAccountId, roomId) {
      if (roomId !== undefined) return selected(roomId).info(token, expectedAccountId);
      const entries = [];
      let accountId;
      for (const room of CLUB_ROOMS) {
        try {
          const value = await rooms.get(room.id).info(token, expectedAccountId);
          accountId = value.accountId;
          entries.push({ ...room, allowed: value.access === 'available', ...value, room: undefined,
            unreadCount: value.readState.unreadCount });
        } catch (error) {
          if (room.kind !== 'experts' || error.status !== 503) throw error;
          entries.push({ ...room, allowed: false, canSend: false, canModerate: false,
            access: 'temporarily_unavailable', unreadCount: 0, readState: null,
            serverTime: new Date((options.clock || Date.now)()).toISOString(), checkedAt: null, validUntil: null });
        }
      }
      // A slow GetCourse request must not return an already revoked session with free cards.
      let confirmed;
      for (let index = 0; index < 5; index++) {
        const room = CLUB_ROOMS[index];
        confirmed = await rooms.get(room.id).info(token, accountId);
        entries[index] = { ...room, allowed: true, ...confirmed, room: undefined, unreadCount: confirmed.readState.unreadCount };
      }
      return { accountId, rooms: entries, serverTime: confirmed.serverTime };
    },
  });
}
