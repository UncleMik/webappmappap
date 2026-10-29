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
});
after(async () => { await db?.close(); });
function snapshot(productId = 4302509, trainingId = 935386893) {
  return { checkedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 299_000).toISOString(),
    snapshot: { purchases: [{ id: 1, product_id: productId, user_id: 11, is_actual: 1, is_payed: 1,
      state: null, period_type: 'limited', start_at: new Date(now - 60_000).toISOString(),
      finish_at: new Date(now + 86_400_000).toISOString() }], trainingIds: [trainingId] } };
}
beforeEach(async () => {
  await pool.query('TRUNCATE club_messages,auth_sessions,auth_users,auth_rate_limits');
  now = Date.now();
  store = createStore(pool, { secret: 'club-test-secret-longer-than-32-bytes', clock: () => now });
  service = { session: token => store.session(token) };
  students = [];
  for (const [i, name] of ['Первая ученица', 'Вторая ученица'].entries()) {
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
    'x-webpril-account': students[0].id, origin, 'content-type': 'application/json' };
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
