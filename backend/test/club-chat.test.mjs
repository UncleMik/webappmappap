import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { testPool } from './auth-pool.mjs';
import { createStore } from '../auth/store.mjs';
import { createClubChat as createRooms, CLUB_ROOMS } from '../auth/club-chat.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { activeCourseProducts } from '../course-entitlements.mjs';
import { AuthError, hashToken, randomToken } from '../auth/security.mjs';

// Keep the existing full single-room regression suite focused on one expert room.
// HTTP supplies the room explicitly and does not use these direct-call defaults.
function createClubChat(options) {
  const courseMaterials = { async list(id) {
    const check = await options.courseChecks.requireCurrent(id);
    const products = activeCourseProducts([
      { productId: 4302509, trainingId: 935386893, type: 'training' },
      { productId: 4309095, trainingId: 935397478, type: 'training' },
      { productId: 999, trainingId: 888, type: 'training' },
    ], check, options.clock());
    const now = options.clock(), start = Date.parse(check?.checkedAt), end = Date.parse(check?.expiresAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > now || end <= now || end - start > 300000) throw new AuthError(503, 'club_unavailable', 'Нет проверки');
    return { ...check, courses: products, validUntil: new Date(Math.min(end, ...products.map(p => p.validUntil))).toISOString() };
  } };
  const raw = createRooms({ ...options, courseMaterials });
  const arity = { info: 2, messages: 4, markRead: 3, around: 3, search: 3, reactions: 3, react: 3, send: 3, changes: 3, deleteMessage: 4 };
  return new Proxy({ ...raw }, { get(target, key) {
    if (key === 'raw') return raw;
    if (!(key in arity)) return target[key];
    return (...args) => {
      if (args.length <= arity[key]) {
        args.length = arity[key]; args.push('experts-birth');
      }
      return target[key](...args);
    };
  } });
}
const fetch = (input, options) => {
  const url = new URL(input);
  if (url.pathname.startsWith('/api/auth/club/') && !url.search) url.searchParams.set('room', 'experts-birth');
  return globalThis.fetch(url, options);
};

let db, pool, now, store, service, chat, checks, students, rights;
before(async () => {
  db = await testPool(); pool = db.pool;
  await pool.query(await readFile(new URL('../auth/club-chat-migration.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../auth/chat-reactions-migration.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../auth/chat-reactions-extra-migration.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../auth/club-delete-migration.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../auth/club-reading-migration.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../auth/club-rooms-migration.sql', import.meta.url), 'utf8'));
});
after(async () => { await db?.close(); });
function snapshot(productId = 4302509, trainingId = 935386893) {
  return { checkedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 299_000).toISOString(),
    snapshot: { purchases: [{ id: 1, product_id: productId, user_id: 11, is_actual: 1, is_payed: 1,
      state: null, period_type: 'limited', start_at: new Date(now - 60_000).toISOString(),
      finish_at: new Date(now + 86_400_000).toISOString() }], trainingIds: [trainingId] } };
}
beforeEach(async () => {
  await pool.query('TRUNCATE club_reading,club_message_reactions,club_messages,auth_sessions,auth_users,auth_rate_limits');
  now = Date.now();
  store = createStore(pool, { secret: 'club-test-secret-longer-than-32-bytes', clock: () => now });
  service = { session: token => store.session(token) };
  students = [];
  for (const [i, name] of ['Первая ученица', 'Вторая ученица', 'Владелец'].entries()) {
    const user = { id: randomUUID(), token: randomToken(), name };
    await pool.query('INSERT INTO auth_users(id,email,getcourse_id,profile) VALUES($1,$2,$3,$4)',
      [user.id, `club-${i}@example.invalid`, 11 + i, JSON.stringify({ name, stage: 'pregnancy', completedAt: new Date(now).toISOString() })]);
    await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',
      [hashToken(user.token), user.id, new Date(now + 86_400_000)]);
    students.push(user);
  }
  rights = new Map(students.map(user => [user.id, snapshot()]));
  checks = { requireCurrent: async id => rights.get(id) };
  chat = createClubChat({ pool, service, courseChecks: checks, store, clock: () => now });
});
const send = (text, student = students[0], extra = {}) => chat.send(student.token, student.id,
  { requestId: randomUUID(), text, ...extra });
const read = (student = students[0], direction, cursor) => chat.messages(student.token, student.id, direction, cursor);

test('only the main full and Express products open the room; bonus and missing rights do not', async () => {
  for (const [product, training] of [[4302509,935386893],[4309095,935397478]]) {
    rights.set(students[0].id, snapshot(product, training));
    assert.equal((await chat.info(students[0].token)).access, 'available');
  }
  for (const [product, training] of [[4307012,935397517],[4307003,935397507],[3317398,935397478]]) {
    rights.set(students[0].id, snapshot(product, training));
    assert.equal((await chat.info(students[0].token)).access, 'purchase_required');
    await assert.rejects(read(), error => error.code === 'club_course_required');
  }
});
test('expired, future and inactive purchases, or a missing training, close read and send', async () => {
  for (const change of [s => { s.snapshot.purchases[0].finish_at = new Date(now).toISOString(); },
    s => { s.snapshot.purchases[0].start_at = new Date(now + 1000).toISOString(); },
    s => { s.snapshot.purchases[0].is_actual = 0; }, s => { s.snapshot.trainingIds = []; }]) {
    const s = snapshot(); change(s); rights.set(students[0].id, s);
    await assert.rejects(read(), error => error.code === 'club_course_required');
    await assert.rejects(send('Закрыто'), error => error.code === 'club_course_required');
  }
});
test('upstream failure and expired verification do not become an unpaid or allowed response', async () => {
  checks.requireCurrent = async () => { throw new AuthError(503, 'course_check_unavailable', 'Нет проверки'); };
  await assert.rejects(chat.info(students[0].token), error => error.status === 503);
  checks.requireCurrent = async () => ({ ...snapshot(), expiresAt: new Date(now).toISOString() });
  await assert.rejects(read(), error => error.status === 503);
});
test('two accounts share server history and replies with correct authors, without email disclosure', async () => {
  const first = await send('<script>alert(1)</script>\nПервое сообщение');
  const second = await send('Ответ', students[1], { replyTo: first.message.id });
  const result = await read();
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].own, true);
  assert.equal(result.messages[1].own, false);
  assert.equal(result.messages[1].author.name, students[1].name);
  assert.equal(second.message.reply.id, first.message.id);
  assert.equal(second.message.reply.text, '<script>alert(1)</script>\nПервое сообщение');
  assert.ok(!JSON.stringify(result).includes('@example.invalid'));
  const reopened = createClubChat({ pool, service, courseChecks: checks, store, clock: () => now });
  assert.equal((await reopened.messages(students[1].token, students[1].id)).messages.length, 2);
});
test('an uncertain-send retry is idempotent; reusing its ID with different text is rejected', async () => {
  const requestId = randomUUID();
  const first = await send('Повтор', students[0], { requestId });
  const retry = await send('Повтор', students[0], { requestId });
  assert.equal(retry.duplicate, true); assert.equal(retry.message.id, first.message.id);
  await assert.rejects(send('Другое', students[0], { requestId }), error => error.code === 'chat_request_reused');
  assert.equal((await read()).messages.length, 1);
});
test('pagination keeps message order and retrieves gaps without skipping or duplicating messages', async () => {
  for (let i = 0; i < 55; i++) await send('Сообщение ' + i);
  const latest = await read();
  assert.equal(latest.messages.length, 50); assert.equal(latest.hasMore, true);
  assert.equal(latest.messages[0].text, 'Сообщение 5');
  const older = await read(students[0], 'before', latest.messages[0].id);
  assert.equal(older.messages.length, 5); assert.equal(older.hasMore, false);
  const newer = await read(students[1], 'after', older.messages[0].id);
  assert.equal(newer.messages.length, 50); assert.equal(newer.hasMore, true);
  assert.equal(newer.messages[0].text, 'Сообщение 1');
  const fromEmpty = await read(students[1], 'after', '0');
  assert.equal(fromEmpty.messages[0].text, 'Сообщение 0');
  assert.equal(fromEmpty.hasMore, true);
  await assert.rejects(read(students[0], 'before', '0'), error => error.code === 'invalid_chat_message');
});
test('identity and payload validation prevent changing another author or quoting unknown messages', async () => {
  await assert.rejects(chat.messages(students[0].token, students[1].id), error => error.code === 'account_changed');
  for (const data of [{ text: '' }, { text: ' '.repeat(5) }, { text: 'x'.repeat(2001) }, { text: '\0' },
    { text: 'Текст', authorId: students[1].id }, { text: 'Текст', room: 'motherhood-students' }]) {
    await assert.rejects(send('unused', students[0], data), error => error.code === 'invalid_chat_message');
  }
  await assert.rejects(send('Ответ', students[0], { replyTo: '9223372036854775807' }), error => error.code === 'reply_not_found');
  assert.equal((await read()).messages.length, 0);
});
test('revocation during the course check prevents reads and writes', async () => {
  checks.requireCurrent = async id => {
    await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1', [id, new Date(now)]);
    return rights.get(id);
  };
  await assert.rejects(send('Не должно сохраниться'), error => error.code === 'sign_in_required');
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_messages')).rows[0].n, 0);
});
test('purchase expiry bounds the response even if the verification has more time remaining', async () => {
  const s = snapshot(); s.snapshot.purchases[0].finish_at = new Date(now + 2000).toISOString();
  rights.set(students[0].id, s);
  assert.equal(Date.parse((await read()).validUntil), now + 2000);
  now += 2000;
  await assert.rejects(read(), error => error.code === 'club_course_required');
});
test('HTTP enforces session, same-origin writes, identity, cursor bounds and existing query restrictions', async () => {
  const origin = 'https://app.legkie-rody.ru';
  const server = createAuthServer({ origin, enabled: true, store, service, clubChat: chat });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: `__Host-school_session=${students[0].token}`,
    'x-webpril-account': students[0].id, 'x-webpril-chat-version':'2', origin, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/api/auth/club')).status, 401);
    assert.equal((await fetch(base + '/api/auth/club', { headers })).status, 200);
    const post = options => fetch(base + '/api/auth/club/messages', { method: 'POST',
      headers, body: JSON.stringify({ requestId: randomUUID(), text: 'Через HTTP' }), ...options });
    assert.equal((await post({ headers: { ...headers, origin: 'https://elsewhere.invalid' } })).status, 403);
    assert.equal((await post({ headers: { ...headers, 'x-webpril-account': students[1].id } })).status, 409);
    assert.equal((await post()).status, 200);
    const response = await fetch(base + '/api/auth/club/messages', { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).messages.length, 1);
    assert.equal((await fetch(base + '/api/auth/club/messages/after/9999999999999999999', { headers })).status, 400);
    assert.equal((await fetch(base + '/api/auth/club/messages?userId=other', { headers })).status, 400);
    assert.equal((await fetch(base + '/api/auth/club/messages/before/abc', { headers })).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('author deletion erases text, updates existing reply quotes and reaches old-message change cursors', async () => {
  const original = await send('Текст, который удаляем');
  const answer = await send('Ответ остаётся',students[1],{replyTo:original.message.id});
  const before = await read(students[1]);
  const removed = await chat.deleteMessage(students[0].token,students[0].id,original.message.id);
  assert.equal(removed.duplicate,false);
  const changes = await chat.changes(students[1].token,students[1].id,before.changeCursor);
  assert.equal(changes.messages.length,1);
  assert.equal(changes.messages[0].id,original.message.id);
  assert.equal(changes.messages[0].deleted,true);
  assert.equal(changes.messages[0].text,null);
  const remaining = await read(students[1]);
  assert.deepEqual(remaining.messages.map(m=>m.id),[answer.message.id]);
  assert.equal(remaining.messages[0].reply.deleted,true);
  assert.equal(remaining.messages[0].reply.text,null);
  const {rows:[stored]}=await pool.query('SELECT body,deleted_at FROM club_messages WHERE id=$1',[original.message.id]);
  assert.equal(stored.body,''); assert.ok(stored.deleted_at);
  await assert.rejects(send('Поздний ответ',students[1],{replyTo:original.message.id}),e=>e.code==='reply_not_found');
});
test('another participant cannot delete or forge owner rights in profile or request payload', async () => {
  const original = await send('Чужое сообщение');
  await pool.query("UPDATE auth_users SET profile=profile || '{\"role\":\"owner\"}'::jsonb WHERE id=$1",[students[1].id]);
  assert.equal((await chat.info(students[1].token)).canModerate,false);
  assert.equal((await read(students[1])).messages[0].canDelete,false);
  await assert.rejects(chat.deleteMessage(students[1].token,students[1].id,original.message.id),e=>e.code==='chat_delete_forbidden');
  await assert.rejects(chat.deleteMessage(students[1].token,students[1].id,original.message.id,{owner:true}),e=>e.code==='invalid_chat_message');
  assert.equal((await read()).messages[0].text,'Чужое сообщение');
});
test('only the privately configured owner can moderate without a purchase; this does not grant posting', async () => {
  const owner=students[2]; rights.set(owner.id,{...snapshot(),snapshot:{purchases:[],trainingIds:[]}});
  const moderator=createClubChat({pool,service,courseChecks:checks,store,ownerUserId:owner.id,clock:()=>now});
  const original=await send('Для модерации');
  const info=await moderator.info(owner.token);
  assert.equal(info.access,'available');assert.equal(info.canModerate,true);assert.equal(info.canSend,false);
  assert.equal((await moderator.messages(owner.token,owner.id)).messages[0].canDelete,true);
  await assert.rejects(moderator.react(owner.token,owner.id,{messageId:original.message.id,reaction:'heart'}),e=>e.code==='club_course_required');
  await assert.rejects(moderator.send(owner.token,owner.id,{requestId:randomUUID(),text:'Без покупки'}),e=>e.code==='club_course_required');
  await moderator.deleteMessage(owner.token,owner.id,original.message.id);
  assert.equal((await read()).messages.length,0);
  checks.requireCurrent=async()=>{throw new AuthError(503,'course_check_unavailable','Нет проверки');};
  assert.equal((await moderator.info(owner.token)).access,'available');
  assert.equal((await moderator.messages(owner.token,owner.id)).messages.length,0);
  await assert.rejects(chat.info(students[0].token),e=>e.status===503);
});

test('deletion also removes reaction state and wins safely against a simultaneous reaction', async () => {
  const original=await send('С реакциями');
  await react(original.message.id,'heart');
  await react(original.message.id,'like',students[1]);
  await chat.deleteMessage(students[0].token,students[0].id,original.message.id);
  const state=(await reactions([original.message.id],students[1])).reactions[0];
  assert.deepEqual(state.counts,{heart:0,love:0,like:0,hug:0,laugh:0});assert.equal(state.selected,null);
  await assert.rejects(react(original.message.id,'love'),e=>e.code==='reaction_message_not_found');
  const other=await send('Гонка реакции с удалением');
  await Promise.allSettled([react(other.message.id,'heart',students[1]),chat.deleteMessage(students[0].token,students[0].id,other.message.id)]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_message_reactions')).rows[0].n,0);
  assert.equal((await read()).messages.length,0);
});
test('delete retry and original-send retry do not restore a deleted message or create extra revisions', async () => {
  const requestId=randomUUID(), original=await send('Не восстановить',students[0],{requestId});
  await chat.deleteMessage(students[0].token,students[0].id,original.message.id);
  const revision=(await read()).changeCursor;
  assert.equal((await chat.deleteMessage(students[0].token,students[0].id,original.message.id)).duplicate,true);
  const retried=await send('Не восстановить',students[0],{requestId});
  assert.equal(retried.duplicate,true);assert.equal(retried.message.deleted,true);assert.equal(retried.message.text,null);
  await assert.rejects(send('Изменённый текст',students[0],{requestId}),e=>e.code==='chat_request_reused');
  assert.equal((await read()).changeCursor,revision);
  assert.equal((await read()).messages.length,0);
});
test('change pagination retains deletions of old history and serializes simultaneous mutations', async () => {
  const original=await send('Старая запись');
  const baseline=(await read()).changeCursor;
  for(let i=0;i<52;i++)await send('Новая '+i,students[i%2]);
  await Promise.all([chat.deleteMessage(students[0].token,students[0].id,original.message.id),send('Параллельная запись',students[1])]);
  const first=await chat.changes(students[1].token,students[1].id,baseline);
  assert.equal(first.messages.length,50);assert.equal(first.hasMore,true);
  const second=await chat.changes(students[1].token,students[1].id,first.changeCursor);
  assert.equal(second.hasMore,false);
  const all=[...first.messages,...second.messages];
  assert.equal(all.length,54);assert.equal(new Set(all.map(m=>m.id)).size,54);
  assert.ok(all.some(m=>m.id===original.message.id&&m.deleted));
  assert.ok(all.some(m=>m.text==='Параллельная запись'));
  await assert.rejects(chat.changes(students[0].token,students[0].id,'9223372036854775807'),e=>e.code==='chat_resync_required');
});
test('reapplying the migration keeps deletion and revision history intact', async () => {
  const original=await send('Удалено до миграции');
  await chat.deleteMessage(students[0].token,students[0].id,original.message.id);
  const revision=(await read()).changeCursor;
  await pool.query(await readFile(new URL('../auth/club-delete-migration.sql',import.meta.url),'utf8'));
  assert.equal((await read()).changeCursor,revision);
  assert.equal((await read()).messages.length,0);
});
test('HTTP deletion requires updated client, same origin, active session and correct account', async () => {
  const original=await send('Удаление через HTTP');
  const origin='https://app.legkie-rody.ru';
  const server=createAuthServer({origin,enabled:true,store,service,clubChat:chat});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={cookie:`__Host-school_session=${students[0].token}`,'x-webpril-account':students[0].id,
    'x-webpril-chat-version':'2',origin,'content-type':'application/json'};
  const path='/api/auth/club/messages/'+original.message.id+'/delete';
  try {
    const post=extra=>fetch(base+path,{method:'POST',headers:{...headers,...extra},body:'{}'});
    assert.equal((await post({origin:'https://elsewhere.invalid'})).status,403);
    assert.equal((await post({'x-webpril-account':students[1].id})).status,409);
    assert.equal((await post({'x-webpril-chat-version':'1'})).status,409);
    assert.equal((await fetch(base+'/api/auth/club/messages',{headers:{cookie:headers.cookie,'x-webpril-account':students[0].id}})).status,409);
    assert.equal((await post()).status,200);
    assert.equal((await post()).status,200);
    assert.equal((await fetch(base+'/api/auth/club/changes/after/0',{headers})).status,200);
    await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1',[students[0].id,new Date(now)]);
    assert.equal((await post()).status,401);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

const react = (messageId, reaction, student = students[0], extra = {}) => chat.react(student.token, student.id, { messageId, reaction, ...extra });
const reactions = (ids, student = students[0]) => chat.reactions(student.token, student.id, { messageIds: ids });

test('reactions share real totals, preserve each account selection and survive reopening', async () => {
  const { message } = await send('Сообщение с реакциями');
  assert.deepEqual((await read()).reactions, [{ messageId: message.id, counts: { heart: 0, love: 0, like: 0, hug: 0, laugh: 0 }, selected: null }]);
  await react(message.id, 'heart');
  await react(message.id, 'heart', students[1]);
  const first = (await reactions([message.id])).reactions[0];
  assert.equal(first.counts.heart, 2); assert.equal(first.selected, 'heart');
  await react(message.id, 'love');
  assert.deepEqual((await reactions([message.id])).reactions[0], {
    messageId: message.id, counts: { heart: 1, love: 1, like: 0, hug: 0, laugh: 0 }, selected: 'love',
  });
  assert.equal((await reactions([message.id], students[1])).reactions[0].selected, 'heart');
  const reopened = createClubChat({ pool, service, courseChecks: checks, store, clock: () => now });
  assert.equal((await reopened.messages(students[0].token, students[0].id)).reactions[0].selected, 'love');
  // A new login replaces the cookie, but the reaction belongs to the stable account.
  await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1', [students[0].id, new Date(now)]);
  students[0].token = randomToken();
  await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',
    [hashToken(students[0].token), students[0].id, new Date(now + 86_400_000)]);
  assert.equal((await read()).reactions[0].selected, 'love');
  await react(message.id, null);
  const removed = (await read()).reactions[0];
  assert.deepEqual(removed.counts, { heart: 1, love: 0, like: 0, hug: 0, laugh: 0 }); assert.equal(removed.selected, null);
  assert.ok(!JSON.stringify(removed).includes(students[1].id));
});

test('repeated and concurrent requests cannot duplicate a reaction or remove another account selection', async () => {
  const { message } = await send('Проверка повторов');
  await Promise.all([react(message.id, 'like'), react(message.id, 'like'), react(message.id, 'like', students[1])]);
  assert.equal((await reactions([message.id])).reactions[0].counts.like, 2);
  await Promise.all([react(message.id, null), react(message.id, null)]);
  assert.deepEqual((await reactions([message.id])).reactions[0].counts, { heart: 0, love: 0, like: 1, hug: 0, laugh: 0 });
  assert.equal((await reactions([message.id], students[1])).reactions[0].selected, 'like');
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_message_reactions')).rows[0].n, 1);
});

test('reaction input cannot forge an author, room, count or unknown message', async () => {
  const { message } = await send('Валидация');
  for (const extra of [{ reaction: 'fire' }, { reaction: '❤️' }, { reaction: undefined },
    { userId: students[1].id }, { room: 'other' }, { counts: { heart: 50 } },
    { messageId: '0' }, { messageId: '9999999999999999999' }, { messageId: Number(message.id) }]) {
    await assert.rejects(react(message.id, 'heart', students[0], extra), error => error.code === 'invalid_chat_reaction');
  }
  await assert.rejects(react('9223372036854775807', 'heart'), error => error.code === 'reaction_message_not_found');
  for (const ids of [[], [message.id, message.id], Array.from({ length: 101 }, (_, i) => String(i + 1)), ['0']]) {
    await assert.rejects(reactions(ids), error => error.code === 'invalid_chat_reaction');
  }
  await assert.rejects(reactions(['9223372036854775807']), error => error.code === 'reaction_message_not_found');
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_message_reactions')).rows[0].n, 0);
});

test('reaction reads and writes enforce paid rights, account identity and session expiry', async () => {
  const { message } = await send('Проверка доступа');
  await assert.rejects(chat.react(students[0].token, students[1].id, { messageId: message.id, reaction: 'heart' }), error => error.code === 'account_changed');
  for (const mode of ['unpaid', 'expired', 'upstream']) {
    rights.set(students[0].id, mode === 'unpaid' ? snapshot(4307012, 935397517) : snapshot());
    if (mode === 'expired') rights.get(students[0].id).snapshot.purchases[0].finish_at = new Date(now).toISOString();
    if (mode === 'upstream') checks.requireCurrent = async () => { throw new AuthError(503, 'course_check_unavailable', 'Нет проверки'); };
    for (const action of [() => react(message.id, 'heart'), () => reactions([message.id])]) {
      await assert.rejects(action(), error => error.status === (mode === 'upstream' ? 503 : 403));
    }
  }
  checks.requireCurrent = async id => rights.get(id); rights.set(students[0].id, snapshot());
  await pool.query('UPDATE auth_sessions SET expires_at=$2 WHERE user_id=$1', [students[0].id, new Date(now - 1)]);
  await assert.rejects(react(message.id, 'heart'), error => error.status === 401);
  await assert.rejects(reactions([message.id]), error => error.status === 401);
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_message_reactions')).rows[0].n, 0);
});

test('revoking a session during the access check also prevents saving a reaction', async () => {
  const { message } = await send('Отзыв сессии');
  checks.requireCurrent = async id => {
    await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1', [id, new Date(now)]);
    return rights.get(id);
  };
  await assert.rejects(react(message.id, 'heart'), error => error.status === 401);
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_message_reactions')).rows[0].n, 0);
});

test('older messages expose current reactions through history and dedicated refresh', async () => {
  const { message } = await send('Старое сообщение');
  for (let i = 0; i < 50; i++) await send('Новое ' + i);
  await react(message.id, 'love', students[1]);
  const latest = await read();
  const older = await read(students[0], 'before', latest.messages[0].id);
  assert.equal(older.reactions[0].messageId, message.id);
  assert.deepEqual(older.reactions[0].counts, { heart: 0, love: 1, like: 0, hug: 0, laugh: 0 });
  await react(message.id, 'like', students[1]);
  assert.deepEqual((await reactions([message.id])).reactions[0].counts, { heart: 0, love: 0, like: 1, hug: 0, laugh: 0 });
});

test('reaction HTTP endpoints require the session, same origin, account header and bounded JSON', async () => {
  const { message } = await send('Реакции через HTTP');
  const origin = 'https://app.legkie-rody.ru';
  const server = createAuthServer({ origin, enabled: true, store, service, clubChat: chat });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/auth/club/reactions`;
  const headers = { cookie: `__Host-school_session=${students[0].token}`,
    'x-webpril-account': students[0].id, origin, 'content-type': 'application/json' };
  const body = JSON.stringify({ messageId: message.id, reaction: 'heart' });
  const post = (path = '', extra = {}) => fetch(base + path, { method: 'POST', headers, body, ...extra });
  try {
    assert.equal((await post('', { headers: { ...headers, cookie: '' } })).status, 401);
    assert.equal((await post('', { headers: { ...headers, origin: 'https://elsewhere.invalid' } })).status, 403);
    assert.equal((await post('', { headers: { ...headers, 'x-webpril-account': students[1].id } })).status, 409);
    const noAccount = { ...headers }; delete noAccount['x-webpril-account'];
    assert.equal((await post('', { headers: noAccount })).status, 409);
    assert.equal((await post('', { body: JSON.stringify({ messageId: message.id, reaction: 'heart', userId: students[1].id }) })).status, 400);
    const saved = await post(); assert.equal(saved.status, 200);
    assert.equal(saved.headers.get('cache-control'), 'no-store');
    assert.equal((await saved.json()).reactions[0].counts.heart, 1);
    const refresh = await post('/read', { body: JSON.stringify({ messageIds: [message.id] }) });
    assert.equal(refresh.status, 200); assert.equal((await refresh.json()).reactions[0].selected, 'heart');
    for (const reaction of ['hug', 'laugh']) {
      const extra = await post('', { body: JSON.stringify({ messageId: message.id, reaction }) });
      assert.equal(extra.status, 200);
      const state = (await extra.json()).reactions[0];
      assert.equal(state.selected, reaction); assert.equal(state.counts[reaction], 1);
      assert.equal(Object.values(state.counts).reduce((sum, count) => sum + count, 0), 1);
    }
    assert.equal((await post('/read', { headers: { ...headers, cookie: '' }, body: JSON.stringify({ messageIds: [message.id] }) })).status, 401);
    assert.equal((await post('', { body: JSON.stringify({ messageId: message.id, reaction: 'x'.repeat(5000) }) })).status, 413);
    assert.equal((await post('?userId=other')).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('hugs and laughter share counts, replace old choices and survive a fresh session', async () => {
  const { message } = await send('Новые реакции');
  await react(message.id, 'hug'); await react(message.id, 'laugh', students[1]);
  assert.deepEqual((await reactions([message.id])).reactions[0], {
    messageId: message.id, counts: { heart: 0, love: 0, like: 0, hug: 1, laugh: 1 }, selected: 'hug',
  });
  await react(message.id, 'laugh'); await react(message.id, 'laugh');
  assert.deepEqual((await read()).reactions[0].counts, { heart: 0, love: 0, like: 0, hug: 0, laugh: 2 });
  await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1', [students[0].id, new Date(now)]);
  students[0].token = randomToken();
  await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',
    [hashToken(students[0].token), students[0].id, new Date(now + 86_400_000)]);
  assert.equal((await read()).reactions[0].selected, 'laugh');
  await react(message.id, null);
  assert.equal((await reactions([message.id], students[1])).reactions[0].counts.laugh, 1);
  await chat.deleteMessage(students[0].token, students[0].id, message.id);
  assert.equal((await reactions([message.id])).reactions[0].counts.laugh, 0);
});

test('expanding the old three-reaction constraint preserves existing votes and is repeatable', async () => {
  await pool.query(`ALTER TABLE club_message_reactions DROP CONSTRAINT club_message_reactions_reaction_check;
    ALTER TABLE club_message_reactions ADD CONSTRAINT club_message_reactions_reaction_check CHECK (reaction IN ('heart','love','like'));`);
  const ids = [];
  for (const choice of ['heart', 'love', 'like']) {
    const { message } = await send('Старая реакция ' + choice); ids.push(message.id); await react(message.id, choice);
  }
  const before = (await reactions(ids)).reactions;
  const migration = await readFile(new URL('../auth/chat-reactions-extra-migration.sql', import.meta.url), 'utf8');
  await pool.query(migration); await pool.query(migration);
  assert.deepEqual((await reactions(ids)).reactions, before);
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_message_reactions')).rows[0].n, 3);
  await react(ids[0], 'hug'); await react(ids[1], 'laugh');
  assert.equal((await reactions(ids)).reactions[0].selected, 'hug');
  assert.equal((await reactions(ids)).reactions[1].selected, 'laugh');
});

const markRead = (messageId, student = students[0]) => chat.markRead(student.token, student.id, { messageId });
const search = (query, before, student = students[0]) => chat.search(student.token, student.id,
  { query, ...(before === undefined ? {} : { before }) });

test('reading starts at latest without historical unread, then counts only live messages from other accounts', async () => {
  const first = await send('Существующая история', students[1]);
  const initial = { initialized: false, lastReadId: '0', unreadCount: 0, firstUnreadId: null };
  assert.deepEqual((await chat.info(students[0].token)).readState, initial);
  assert.deepEqual((await read()).readState, initial);
  await markRead(first.message.id);
  await send('Собственное сообщение');
  const erased = await send('Будет удалено', students[1]);
  const unread = await send('Первое непрочитанное', students[1]);
  await chat.deleteMessage(students[1].token, students[1].id, erased.message.id);
  const expected = { initialized: true, lastReadId: first.message.id, unreadCount: 1, firstUnreadId: unread.message.id };
  assert.deepEqual((await read()).readState, expected);
  assert.deepEqual((await chat.changes(students[0].token, students[0].id, '0')).readState, expected);
  assert.deepEqual((await chat.info(students[1].token)).readState, initial);
  // A deleted message can safely advance a position, but cannot count as unread.
  assert.equal((await markRead(erased.message.id)).readState.unreadCount, 1);
  assert.equal((await markRead(unread.message.id)).readState.unreadCount, 0);
});

test('reading positions never rewind, survive new sessions and migration, and initialize empty rooms', async () => {
  assert.deepEqual((await markRead('0')).readState, { initialized: true, lastReadId: '0', unreadCount: 0, firstUnreadId: null });
  const first = await send('Начало', students[1]), second = await send('Продолжение', students[1]);
  await Promise.all([markRead(second.message.id), markRead(first.message.id)]);
  assert.equal((await markRead(first.message.id)).readState.lastReadId, second.message.id);
  const saved = (await read()).readState;
  await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1', [students[0].id, new Date(now)]);
  students[0].token = randomToken();
  await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',
    [hashToken(students[0].token), students[0].id, new Date(now + 86_400_000)]);
  const migration = await readFile(new URL('../auth/club-reading-migration.sql', import.meta.url), 'utf8');
  await pool.query(migration); await pool.query(migration);
  assert.deepEqual((await read()).readState, saved);
  assert.equal((await read(students[1])).readState.initialized, false);
  assert.equal((await read()).messages.length, 2);
  await assert.rejects(markRead('0'), e => e.code === 'chat_message_not_found');
  await assert.rejects(markRead('9223372036854775807'), e => e.code === 'chat_message_not_found');
  for (const data of [{ messageId: first.message.id, userId: students[1].id }, { messageId: first.message.id, room: 'other' },
    { messageId: Number(first.message.id) }, { messageId: '-1' }, {}, []]) {
    await assert.rejects(chat.markRead(students[0].token, students[0].id, data), e => e.code === 'invalid_chat_message');
  }
});

test('around navigates older history with both edges, reactions and deleted targets excluded', async () => {
  const ids = [];
  for (let i = 0; i < 90; i++) ids.push((await send('История ' + i, students[i % 2])).message.id);
  await react(ids[30], 'hug', students[1]);
  const result = await chat.around(students[0].token, students[0].id, ids[30]);
  assert.deepEqual(result.messages.map(m => m.id), ids.slice(5, 55));
  assert.equal(result.hasBefore, true); assert.equal(result.hasAfter, true); assert.equal(result.hasMore, true);
  assert.equal(result.reactions.find(r => r.messageId === ids[30]).counts.hug, 1);
  assert.equal(result.readState.initialized, false);
  const start = await chat.around(students[0].token, students[0].id, ids[0]);
  assert.equal(start.hasBefore, false); assert.equal(start.hasAfter, true);
  const end = await chat.around(students[0].token, students[0].id, ids.at(-1));
  assert.equal(end.hasAfter, false); assert.equal(end.hasBefore, true);
  const latest = await read();
  assert.equal(latest.hasBefore, true); assert.equal(latest.hasAfter, false);
  const older = await read(students[0], 'before', ids[5]);
  assert.equal(older.hasBefore, false); assert.equal(older.hasAfter, true);
  const forward = await read(students[0], 'after', ids[0]);
  assert.equal(forward.hasBefore, true); assert.equal(forward.hasAfter, true); assert.equal(forward.hasMore, true);
  const empty = await read(students[0], 'after', ids.at(-1));
  assert.equal(empty.hasBefore, true); assert.equal(empty.hasAfter, false);
  await chat.deleteMessage(students[0].token, students[0].id, ids[30]);
  await assert.rejects(chat.around(students[0].token, students[0].id, ids[30]), e => e.code === 'chat_message_not_found');
  await assert.rejects(chat.around(students[0].token, students[0].id, '9223372036854775807'), e => e.code === 'chat_message_not_found');
});

test('search covers all historical text, paginates once per result and returns current quotes and reactions', async () => {
  const ids = [];
  for (let i = 0; i < 65; i++) ids.push((await send('Archive NEEDLE ' + i, students[i % 2])).message.id);
  for (let i = 0; i < 51; i++) await send('Новая лента ' + i, students[1]);
  await react(ids[60], 'laugh', students[1]);
  await chat.deleteMessage(students[0].token, students[0].id, ids[0]);
  assert.ok(!(await read()).messages.some(m => m.text.includes('NEEDLE')));
  const first = await search('needle'), second = await search('needle', first.nextBefore), third = await search('needle', second.nextBefore);
  assert.equal(first.messages.length, 30); assert.equal(first.hasMore, true);
  assert.equal(second.messages.length, 30); assert.equal(second.hasMore, true);
  assert.equal(third.messages.length, 4); assert.equal(third.hasMore, false); assert.equal(third.nextBefore, null);
  assert.deepEqual([...first.messages, ...second.messages, ...third.messages].map(m => m.id), ids.slice(1).reverse());
  assert.equal(first.reactions.find(r => r.messageId === ids[60]).counts.laugh, 1);
  assert.equal(first.readState.initialized, false);
  assert.equal(typeof first.changeCursor, 'string');
});

test('search treats wildcard syntax and SQL text literally and validates unicode length and extra fields', async () => {
  for (const text of ['Есть 50% и а_б и C:\\temp', 'Есть 500 и аХб и C:temp', "SQL ' OR 1=1 --"]) await send(text);
  for (const query of ['50%', 'а_б', 'C:\\temp', "' OR 1=1 --"]) assert.equal((await search(query)).messages.length, 1);
  assert.equal((await search('不存在')).messages.length, 0);
  assert.equal((await search('😀'.repeat(100))).messages.length, 0);
  for (const data of [{ query: '' }, { query: 'a' }, { query: ' '.repeat(2) }, { query: '😀'.repeat(101) },
    { query: 'ok\u0000' }, { query: 'ok', before: '0' }, { query: 'ok', before: 1 },
    { query: 'ok', userId: students[1].id }, { query: 'ok', room: 'other' }, null, []]) {
    await assert.rejects(chat.search(students[0].token, students[0].id, data), e => e.code === 'invalid_chat_search');
  }
});

test('reading, around and search enforce rights, account, profile and session on every call', async () => {
  const { message } = await send('Доступ');
  const actions = account => [() => chat.markRead(students[0].token, account, { messageId: message.id }),
    () => chat.around(students[0].token, account, message.id), () => chat.search(students[0].token, account, { query: 'Доступ' })];
  for (const action of actions(students[1].id)) await assert.rejects(action(), e => e.code === 'account_changed');
  rights.set(students[0].id, snapshot(4307012, 935397517));
  for (const action of actions(students[0].id)) await assert.rejects(action(), e => e.code === 'club_course_required');
  rights.set(students[0].id, snapshot());
  await pool.query("UPDATE auth_users SET profile='{}'::jsonb WHERE id=$1", [students[0].id]);
  for (const action of actions(students[0].id)) await assert.rejects(action(), e => e.code === 'onboarding_required');
  await pool.query('UPDATE auth_users SET profile=$2 WHERE id=$1', [students[0].id, { completedAt: new Date(now).toISOString() }]);
  checks.requireCurrent = async id => {
    await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1', [id, new Date(now)]);
    return rights.get(id);
  };
  for (const action of actions(students[0].id)) await assert.rejects(action(), e => e.code === 'sign_in_required');
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_reading')).rows[0].n, 0);
});

test('new HTTP navigation and read routes reject stale clients, cross origin, forged accounts and invalid bodies', async () => {
  const { message } = await send('Поиск HTTP');
  const origin = 'https://app.legkie-rody.ru';
  const server = createAuthServer({ origin, enabled: true, store, service, clubChat: chat });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/auth/club`;
  const headers = { cookie: `__Host-school_session=${students[0].token}`, 'x-webpril-account': students[0].id,
    'x-webpril-chat-version': '2', origin, 'content-type': 'application/json' };
  try {
    for (const [path, body] of [['/read', { messageId: message.id }], ['/search', { query: 'HTTP' }]]) {
      const post = (extra = {}, data = body) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data) });
      assert.equal((await post({ cookie: '' })).status, 401);
      assert.equal((await post({ origin: 'https://elsewhere.invalid' })).status, 403);
      assert.equal((await post({ 'sec-fetch-site': 'same-site' })).status, 403);
      assert.equal((await post({ 'x-webpril-chat-version': '1' })).status, 409);
      assert.equal((await post({ 'x-webpril-account': '' })).status, 409);
      assert.equal((await post({ 'x-webpril-account': students[1].id })).status, 409);
      assert.equal((await post({}, { ...body, room: 'other' })).status, 400);
      const response = await post(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).readState.initialized, true);
    }
    const path = '/messages/around/' + message.id;
    assert.equal((await fetch(base + path, { headers: { ...headers, cookie: '' } })).status, 401);
    assert.equal((await fetch(base + path, { headers: { ...headers, 'x-webpril-chat-version': '1' } })).status, 409);
    assert.equal((await fetch(base + path, { headers: { ...headers, 'x-webpril-account': students[1].id } })).status, 409);
    assert.equal((await fetch(base + path + '?room=other', { headers })).status, 404);
    const response = await fetch(base + path, { headers }); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).messages[0].id, message.id);
    rights.set(students[0].id, snapshot(4307012, 935397517));
    assert.equal((await fetch(base + path, { headers })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('all seven rooms have isolated history, replies, revisions, reactions, search and reading positions', async () => {
  const raw = chat.raw, user = students[0], other = students[1];
  const ids = [];
  for (const room of CLUB_ROOMS) {
    const initial = await raw.messages(user.token, user.id, 'latest', undefined, room.id);
    assert.equal(initial.messages.length, 0);
    const saved = await raw.send(other.token, other.id, { requestId: randomUUID(), text: 'уникально ' + room.id }, room.id);
    ids.push(saved.message.id);
    const history = await raw.messages(user.token, user.id, 'latest', undefined, room.id);
    assert.deepEqual(history.messages.map(m => m.id), [saved.message.id]);
    assert.equal(history.room.id, room.id);
    const hits = await raw.search(user.token, user.id, { query: 'уникально' }, room.id);
    assert.deepEqual(hits.messages.map(m => m.id), [saved.message.id]);
    await raw.markRead(user.token, user.id, { messageId: saved.message.id }, room.id);
    assert.equal((await raw.info(user.token, user.id, room.id)).readState.lastReadId, saved.message.id);
  }
  const source = CLUB_ROOMS[0].id, target = CLUB_ROOMS[1].id, id = ids[0];
  for (const action of [
    () => raw.around(user.token, user.id, id, target),
    () => raw.markRead(user.token, user.id, { messageId: id }, target),
    () => raw.deleteMessage(other.token, other.id, id, {}, target),
    () => raw.react(user.token, user.id, { messageId: id, reaction: 'heart' }, target),
    () => raw.reactions(user.token, user.id, { messageIds: [id] }, target),
  ]) await assert.rejects(action(), e => e.status === 404);
  await assert.rejects(raw.send(user.token, user.id, { requestId: randomUUID(), text: 'ответ', replyTo: id }, target), e => e.code === 'reply_not_found');
  const before = await raw.messages(user.token, user.id, 'latest', undefined, target);
  await raw.deleteMessage(other.token, other.id, id, {}, source);
  const changes = await raw.changes(user.token, user.id, before.changeCursor, target);
  assert.deepEqual(changes.messages, []);
});

test('free rooms remain fully usable without a purchase and during GetCourse failure', async () => {
  checks.requireCurrent = async () => { throw new AuthError(503, 'course_check_unavailable', 'Нет проверки'); };
  const raw = chat.raw, user = students[0];
  const directory = await raw.info(user.token, user.id);
  assert.equal(directory.rooms.length, 7);
  assert.deepEqual(directory.rooms.map(r => r.allowed), [true, true, true, true, true, false, false]);
  assert.equal(directory.rooms[5].access, 'temporarily_unavailable');
  for (const room of CLUB_ROOMS.slice(0, 5)) {
    const message = await raw.send(user.token, user.id, { requestId: randomUUID(), text: 'доступно' }, room.id);
    await raw.react(user.token, user.id, { messageId: message.message.id, reaction: 'heart' }, room.id);
    assert.equal((await raw.messages(user.token, user.id, 'latest', undefined, room.id)).messages.length, 1);
  }
  for (const room of CLUB_ROOMS.slice(5)) await assert.rejects(raw.messages(user.token, user.id, 'latest', undefined, room.id), e => e.status === 503);
});

test('any active catalog training purchase opens both experts; absent, bonus and expired access open neither', async () => {
  const raw = chat.raw, user = students[0];
  rights.set(user.id, snapshot(999, 888));
  for (const room of CLUB_ROOMS.slice(5)) assert.equal((await raw.info(user.token, user.id, room.id)).canSend, true);
  for (const check of [snapshot(4307012, 935397517), { ...snapshot(), snapshot: { purchases: [], trainingIds: [] } },
    (() => { const check = snapshot(999, 888); check.snapshot.purchases[0].finish_at = new Date(now).toISOString(); return check; })()]) {
    rights.set(user.id, check);
    const directory = await raw.info(user.token, user.id);
    assert.deepEqual(directory.rooms.map(r => r.allowed), [true, true, true, true, true, false, false]);
    for (const room of CLUB_ROOMS.slice(5)) await assert.rejects(raw.send(user.token, user.id, { requestId: randomUUID(), text: 'закрыто' }, room.id), e => e.code === 'club_course_required');
  }
});

test('global request UUID cannot return, duplicate or reveal a send from another room', async () => {
  const raw = chat.raw, user = students[0], requestId = randomUUID();
  const results = await Promise.allSettled(CLUB_ROOMS.slice(0, 2).map(room => raw.send(user.token, user.id, { requestId, text: 'одна попытка' }, room.id)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'chat_request_reused');
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_messages WHERE request_id=$1', [requestId])).rows[0].n, 1);
});

test('legacy room remains stored for rollback but never appears in directory or any API operation', async () => {
  const raw = chat.raw, user = students[0];
  await pool.query("INSERT INTO club_messages(room,author_id,request_id,body,revision) VALUES('pregnancy-students',$1,$2,'старый текст',1)", [user.id, randomUUID()]);
  await pool.query(await readFile(new URL('../auth/club-rooms-migration.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../auth/club-rooms-migration.sql', import.meta.url), 'utf8'));
  const directory = await raw.info(user.token, user.id);
  assert.ok(!JSON.stringify(directory).includes('pregnancy-students'));
  for (const room of CLUB_ROOMS) assert.deepEqual((await raw.messages(user.token, user.id, 'latest', undefined, room.id)).messages, []);
  await assert.rejects(raw.info(user.token, user.id, 'pregnancy-students'), e => e.status === 404);
  await assert.rejects(raw.messages(user.token, user.id, 'latest', undefined, 'pregnancy-students'), e => e.status === 404);
  assert.equal((await pool.query("SELECT body FROM club_messages WHERE room='pregnancy-students'")).rows[0].body, 'старый текст');
});

test('room query is mandatory, singular and allowlisted, while directory remains unscoped', async () => {
  const origin = 'https://app.legkie-rody.ru', user = students[0];
  const server = createAuthServer({ origin, enabled: true, store, service, clubChat: chat.raw });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: `__Host-school_session=${user.token}`, 'x-webpril-account': user.id, 'x-webpril-chat-version': '2', origin, 'content-type': 'application/json' };
  try {
    for (const path of ['/api/auth/club/messages', '/api/auth/club/messages?room=pregnancy-students', '/api/auth/club/messages?room=unknown']) {
      assert.equal((await globalThis.fetch(base + path, { headers })).status, 404);
    }
    assert.equal((await globalThis.fetch(base + '/api/auth/club/messages?room=mother-0-6&room=mother-6-plus', { headers })).status, 400);
    const directory = await globalThis.fetch(base + '/api/auth/club', { headers });
    assert.equal((await directory.json()).rooms.length, 7);
    const response = await globalThis.fetch(base + '/api/auth/club/messages?room=mother-0-6', { headers });
    assert.equal(response.status, 200); assert.equal((await response.json()).room.id, 'mother-0-6');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('every free room still requires a completed profile, current account and a live server session', async () => {
  const raw = chat.raw, user = students[0];
  for (const room of CLUB_ROOMS.slice(0, 5)) await assert.rejects(raw.messages(user.token, students[1].id, 'latest', undefined, room.id), e => e.code === 'account_changed');
  await pool.query("UPDATE auth_users SET profile='{}' WHERE id=$1", [user.id]);
  for (const room of CLUB_ROOMS.slice(0, 5)) await assert.rejects(raw.messages(user.token, user.id, 'latest', undefined, room.id), e => e.code === 'onboarding_required');
  await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1', [user.id, new Date(now)]);
  for (const room of CLUB_ROOMS.slice(0, 5)) await assert.rejects(raw.messages(user.token, user.id, 'latest', undefined, room.id), e => e.code === 'sign_in_required');
});

test('directory rechecks free session after a slow paid check revokes it', async () => {
  const user = students[0];
  checks.requireCurrent = async id => {
    await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1', [id, new Date(now)]);
    throw new AuthError(503, 'course_check_unavailable', 'Нет проверки');
  };
  await assert.rejects(chat.raw.info(user.token, user.id), e => e.code === 'sign_in_required');
});

test('activity room shares screenshots only through authenticated room access and removes them on deletion', async () => {
  const photo = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgoKC8oLzc3Nzc3N0E8QUNDQ0FBQUFDQ0NISEhVVVVISEhDQ0hIUFBVVVxfXFdXVVdfX2RkZHh4c3OMjJGsrM//xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Z';
  const [sender, reader] = students;
  const room = 'weekly-activity';
  const body = { requestId: randomUUID(), text: '', screenshot: photo };
  const saved = await chat.raw.send(sender.token, sender.id, body, room);
  assert.equal(saved.message.hasScreenshot, true);
  assert.equal((await chat.raw.send(sender.token, sender.id, body, room)).duplicate, true);
  const history = await chat.raw.messages(reader.token, reader.id, undefined, undefined, room);
  assert.equal(history.messages[0].hasScreenshot, true);
  assert.deepEqual(Buffer.from(await chat.raw.screenshot(reader.token, saved.message.id, room)), Buffer.from(photo, 'base64'));
  await assert.rejects(chat.raw.screenshot('', saved.message.id, room), { status: 401 });
  await assert.rejects(chat.raw.screenshot(reader.token, saved.message.id, 'experts-birth'), { status: 404 });
  await assert.rejects(chat.raw.send(sender.token, sender.id, { ...body, requestId: randomUUID() }, 'experts-birth'), { status: 400 });
  await chat.raw.deleteMessage(sender.token, sender.id, saved.message.id, {}, room);
  await assert.rejects(chat.raw.screenshot(reader.token, saved.message.id, room), { status: 404 });
  const { rows: [row] } = await pool.query('SELECT screenshot FROM club_messages WHERE id=$1', [saved.message.id]);
  assert.equal(row.screenshot, null);
});
