import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { testPool } from './auth-pool.mjs';
import { createStore } from '../auth/store.mjs';
import { createClubChat } from '../auth/club-chat.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { AuthError, hashToken, randomToken } from '../auth/security.mjs';

let db, pool, now, store, service, chat, checks, students, rights;
before(async () => {
  db = await testPool(); pool = db.pool;
  await pool.query(await readFile(new URL('../auth/club-chat-migration.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../auth/chat-reactions-migration.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../auth/club-delete-migration.sql', import.meta.url), 'utf8'));
});
after(async () => { await db?.close(); });
function snapshot(productId = 4302509, trainingId = 935386893) {
  return { checkedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 299_000).toISOString(),
    snapshot: { purchases: [{ id: 1, product_id: productId, user_id: 11, is_actual: 1, is_payed: 1,
      state: null, period_type: 'limited', start_at: new Date(now - 60_000).toISOString(),
      finish_at: new Date(now + 86_400_000).toISOString() }], trainingIds: [trainingId] } };
}
beforeEach(async () => {
  await pool.query('TRUNCATE club_message_reactions,club_messages,auth_sessions,auth_users,auth_rate_limits');
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
  assert.deepEqual(state.counts,{heart:0,love:0,like:0});assert.equal(state.selected,null);
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
  assert.deepEqual((await read()).reactions, [{ messageId: message.id, counts: { heart: 0, love: 0, like: 0 }, selected: null }]);
  await react(message.id, 'heart');
  await react(message.id, 'heart', students[1]);
  const first = (await reactions([message.id])).reactions[0];
  assert.equal(first.counts.heart, 2); assert.equal(first.selected, 'heart');
  await react(message.id, 'love');
  assert.deepEqual((await reactions([message.id])).reactions[0], {
    messageId: message.id, counts: { heart: 1, love: 1, like: 0 }, selected: 'love',
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
  assert.deepEqual(removed.counts, { heart: 1, love: 0, like: 0 }); assert.equal(removed.selected, null);
  assert.ok(!JSON.stringify(removed).includes(students[1].id));
});

test('repeated and concurrent requests cannot duplicate a reaction or remove another account selection', async () => {
  const { message } = await send('Проверка повторов');
  await Promise.all([react(message.id, 'like'), react(message.id, 'like'), react(message.id, 'like', students[1])]);
  assert.equal((await reactions([message.id])).reactions[0].counts.like, 2);
  await Promise.all([react(message.id, null), react(message.id, null)]);
  assert.deepEqual((await reactions([message.id])).reactions[0].counts, { heart: 0, love: 0, like: 1 });
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
  assert.deepEqual(older.reactions[0].counts, { heart: 0, love: 1, like: 0 });
  await react(message.id, 'like', students[1]);
  assert.deepEqual((await reactions([message.id])).reactions[0].counts, { heart: 0, love: 0, like: 1 });
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
    assert.equal((await post('/read', { headers: { ...headers, cookie: '' }, body: JSON.stringify({ messageIds: [message.id] }) })).status, 401);
    assert.equal((await post('', { body: JSON.stringify({ messageId: message.id, reaction: 'x'.repeat(5000) }) })).status, 413);
    assert.equal((await post('?userId=other')).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
