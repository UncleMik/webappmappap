import { createHash } from 'node:crypto';
import { AuthError } from './security.mjs';
import { CLUB_ROOMS } from './club-chat.mjs';

const rooms = [...CLUB_ROOMS, { id: 'weekly-activity', title: 'Активности недели', kind: 'participants' }];
const validId = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const bad = () => new AuthError(400, 'invalid_chat_request', 'Проверьте запрос чата.');
const missing = () => new AuthError(404, 'chat_message_not_found', 'Сообщение не найдено.');

async function room(client, id) {
  const fixed = rooms.find(value => value.id === id);
  if (fixed) return { ...fixed, closed: false };
  if (typeof id === 'string' && /^weekly-poll:[a-zA-Z0-9_-]{1,100}$/.test(id)) {
    const { rows: [poll] } = await client.query(`SELECT question,closes_at<=now() AS closed FROM weekly_polls WHERE id=$1`, [id.slice(12)]);
    if (poll) return { id, title: `${poll.question} · ${id.slice(12)}`, kind: 'poll', closed: poll.closed };
  }
  throw new AuthError(404, 'club_room_not_found', 'Чат не найден.');
}

function object(data, keys) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key))) throw bad();
}

export function createAdminChats({ read, write, audit }) {
  return {
    chats: (token, expected) => read(token, expected, async client => {
      const { rows } = await client.query(`SELECT id,question,closes_at<=now() AS closed FROM weekly_polls ORDER BY opens_at DESC,id DESC`);
      return { rooms: [...rooms.map(value => ({ ...value, closed: false })),
        ...rows.map(poll => ({ id: `weekly-poll:${poll.id}`, title: `${poll.question} · ${poll.id}`, kind: 'poll', closed: poll.closed }))] };
    }),
    chatMessages: (token, expected, data) => read(token, expected, async client => {
      object(data, ['room', 'before', 'query']);
      const selected = await room(client, data.room);
      if (data.before !== undefined && !validId(data.before)) throw bad();
      if (data.query !== undefined && (typeof data.query !== 'string' || data.query.trim().length > 200 || /\x00/.test(data.query))) throw bad();
      const query = (data.query ?? '').trim();
      const pattern = '%' + query.replace(/[\\%_]/g, value => '\\' + value) + '%';
      const { rows } = await client.query(`SELECT m.id,m.body,m.created_at,m.revision,m.screenshot IS NOT NULL AS has_screenshot,
        COALESCE(NULLIF(btrim(u.profile->>'name'),''),'Участница') AS author_name,
        r.id AS reply_id,r.body AS reply_body,r.deleted_at AS reply_deleted_at,
        COALESCE(NULLIF(btrim(ru.profile->>'name'),''),'Участница') AS reply_author
        FROM club_messages m JOIN auth_users u ON u.id=m.author_id
        LEFT JOIN club_messages r ON r.room=m.room AND r.id=m.reply_to_id
        LEFT JOIN auth_users ru ON ru.id=r.author_id
        WHERE m.room=$1 AND m.deleted_at IS NULL AND ($2::bigint IS NULL OR m.id<$2::bigint)
          AND m.body ILIKE $3 ESCAPE E'\\\\' ORDER BY m.id DESC LIMIT 51`, [selected.id, data.before ?? null, pattern]);
      const messages = rows.slice(0, 50).map(row => ({ id: String(row.id), text: row.body,
        createdAt: new Date(row.created_at).toISOString(), revision: String(row.revision), deleted: false,
        author: { name: row.author_name }, ...(row.has_screenshot ? { hasScreenshot: true } : {}),
        reply: row.reply_id == null ? null : { id: String(row.reply_id), text: row.reply_deleted_at == null ? row.reply_body : null,
          deleted: row.reply_deleted_at != null, authorName: row.reply_author } }));
      return { room: selected, messages, hasMore: rows.length > 50, nextBefore: rows.length > 50 ? messages.at(-1).id : null };
    }),
    chatPhoto: (token, expected, roomId, id) => read(token, expected, async client => {
      await room(client, roomId);
      if (!validId(id)) throw bad();
      const { rows: [message] } = await client.query('SELECT screenshot FROM club_messages WHERE room=$1 AND id=$2::bigint AND deleted_at IS NULL', [roomId, id]);
      if (!message?.screenshot) throw missing();
      return { bytes: message.screenshot };
    }),
    deleteChatMessage: (token, expected, data) => write(token, expected, async (client, user) => {
      object(data, ['room', 'id']);
      await room(client, data.room);
      if (!validId(data.id)) throw bad();
      await client.query('SELECT revision FROM club_state WHERE room=$1 FOR UPDATE', [data.room]);
      const { rows: [message] } = await client.query('SELECT * FROM club_messages WHERE room=$1 AND id=$2::bigint FOR UPDATE', [data.room, data.id]);
      if (!message) throw missing();
      if (message.deleted_at) return { deletedId: data.id, duplicate: true };
      const { rows: [state] } = await client.query('UPDATE club_state SET revision=revision+1 WHERE room=$1 RETURNING revision', [data.room]);
      if (!state) throw new AuthError(503, 'club_unavailable', 'Чат временно недоступен.');
      const digest = createHash('sha256').update(JSON.stringify([message.body, message.reply_to_id == null ? null : String(message.reply_to_id)])).digest('hex');
      await client.query('DELETE FROM club_message_reactions WHERE message_id=$1::bigint', [data.id]);
      await client.query(`UPDATE club_messages SET body='',screenshot=NULL,deleted_at=clock_timestamp(),revision=$3,request_digest=COALESCE(request_digest,$4)
        WHERE room=$1 AND id=$2::bigint`, [data.room, data.id, state.revision, digest]);
      await audit(client, user.id, 'chat_message_deleted', `${data.room}:${data.id}`);
      return { deletedId: data.id, duplicate: false };
    }),
  };
}
