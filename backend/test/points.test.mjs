import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { testPool } from './auth-pool.mjs';
import { createClubChat } from '../auth/club-chat.mjs';
import { readConfig } from '../auth/config.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { createPoints } from '../auth/points.mjs';
import { hashToken, randomToken, sessionCookie } from '../auth/security.mjs';
import { createStore } from '../auth/store.mjs';

test('points pilot is disabled with no account list or a malformed entry', () => {
  const env = {
    AUTH_DATABASE_URL: 'postgresql://localhost/auth_test',
    AUTH_HMAC_SECRET: 'points-configuration-test-secret-value',
    UNISENDER_API_KEY: 'test', UNISENDER_TEMPLATE_ID: randomUUID(), GETCOURSE_IMPORT_KEY: 'test',
  };
  const id = randomUUID();
  assert.deepEqual(readConfig(env).pointsPilotUserIds, []);
  assert.equal(readConfig(env).pointsForAll, false);
  assert.equal(readConfig({ ...env, AUTH_POINTS_FOR_ALL: '1' }).pointsForAll, false);
  assert.equal(readConfig({ ...env, AUTH_POINTS_FOR_ALL: 'true' }).pointsForAll, true);
  assert.deepEqual(readConfig({ ...env, AUTH_POINTS_PILOT_USER_IDS: id + ',bad' }).pointsPilotUserIds, []);
  assert.deepEqual(readConfig({ ...env, AUTH_POINTS_PILOT_USER_IDS: ' ' + id.toUpperCase() + ' ' }).pointsPilotUserIds, [id]);
});

test('chat pilot credits one saved message per Moscow day and serves only the account history', async t => {
  const db = await testPool(), { pool } = db;
  let server;
  try {
    for (const name of ['club-chat', 'chat-reactions', 'chat-reactions-extra', 'club-delete', 'club-reading', 'club-rooms', 'points']) {
      await pool.query(await readFile(new URL(`../auth/${name}-migration.sql`, import.meta.url), 'utf8'));
    }
    const firstTime = '2026-11-08T20:59:59.999Z';
    let now = Date.parse(firstTime);
    const clock = () => now;
    const store = createStore(pool, { secret: 'synthetic-points-pilot-test-secret', clock });
    const service = { session: token => store.session(token) };
    async function account(number) {
      const id = randomUUID(), token = randomToken();
      await pool.query('INSERT INTO auth_users(id,email,getcourse_id,profile) VALUES($1,$2,$3,$4)',
        [id, `points-${number}@example.invalid`, number, { name: 'Тест', stage: 'pregnancy', completedAt: firstTime }]);
      await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',
        [hashToken(token), id, new Date(now + 30 * 86_400_000)]);
      return { id, token };
    }
    const pilot = await account(1), other = await account(2);
    const reader = await account(3), daily = await account(4), weekly = await account(5), legacy = await account(6);
    await pool.query('INSERT INTO auth_points_ledger(user_id,source_message_id,occurred_at,moscow_day,amount) VALUES($1,999,$2,$3,5)',
      [legacy.id, new Date(now), '2026-11-08']);
    const articleMigration = await readFile(new URL('../auth/points-article-migration.sql', import.meta.url), 'utf8');
    await pool.query(articleMigration);
    await pool.query(articleMigration);
    await pool.query(await readFile(new URL('../auth/points-video-migration.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../auth/weekly-poll.sql', import.meta.url), 'utf8'));
    const lookupArticle = id => /^pregnancy-0[01][0-9]$/.test(id) ? { id, minutes: 3 } : null;
    const points = createPoints({ pool, userIds: [pilot.id, reader.id, daily.id, weekly.id, legacy.id], clock, lookupArticle });
    const clubChat = createClubChat({ pool, service, store, points, clock });
    const origin = 'https://points-test.example.invalid';
    server = createAuthServer({ store, service, points, clubChat, origin, enabled: true });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}/api/auth`;
    async function request(path, user, body, expectedId = user?.id) {
      const headers = {};
      if (expectedId) headers['X-Webpril-Account'] = expectedId;
      if (user) headers.Cookie = sessionCookie(user.token).split(';')[0];
      if (body !== undefined) Object.assign(headers, { Origin: origin, 'Content-Type': 'application/json', 'X-Webpril-Chat-Version': '2' });
      const response = await fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() };
    }
    const room1 = 'pregnancy-trimester-1', room2 = 'pregnancy-trimester-2';
    const first = { requestId: randomUUID(), text: 'Первое тестовое сообщение' };
    const second = { requestId: randomUUID(), text: 'Вторая тестовая запись' };
    const send = (room, body, user = pilot) => request(`/club/messages?room=${room}`, user, body);
    const fresh = () => ({ requestId: randomUUID(), text: 'Тестовое сообщение' });
    const wallet = (before = '') => request('/points' + before, pilot);
    const startReading = (user, articleId) => request('/points/articles', user, { articleId });
    const pulse = (user, articleId, attemptId, reachedEnd) => request('/points/articles', user, { articleId, attemptId, reachedEnd });
    async function readArticleToEnd(user, articleId) {
      const start = (await startReading(user, articleId)).data;
      assert.equal(start.status, 'reading');
      now += 15_000;
      assert.equal((await pulse(user, articleId, start.attemptId, false)).data.remainingMs, 15_000);
      now += 15_000;
      return (await pulse(user, articleId, start.attemptId, true)).data;
    }

    await t.test('allowlist, session and account binding', async () => {
      const empty = await wallet();
      assert.equal(empty.status, 200);
      assert.equal(empty.cache, 'private, no-store');
      assert.deepEqual(empty.data, { accountId: pilot.id, enabled: true, balance: 0, history: [], nextCursor: null });
      assert.equal((await request('/points', null)).status, 401);
      assert.equal((await request('/points', pilot, undefined, other.id)).data.error, 'account_changed');
      assert.deepEqual((await request('/points', other)).data, { accountId: other.id, enabled: false });
      assert.equal((await send(room1, fresh(), other)).status, 200);
      assert.equal((await send(room1, { requestId: randomUUID(), text: ' ' })).status, 400);
      assert.equal((await wallet()).data.balance, 0);
    });

    await t.test('one credit across rooms, retry, deletion and the Moscow boundary', async () => {
      const writes = await Promise.all([send(room1, first), send(room2, second)]);
      for (const result of writes) assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.notEqual(writes[0].data.message.id, writes[1].data.message.id);
      const earned = (await wallet()).data;
      assert.equal(earned.balance, 5);
      assert.equal(earned.history.length, 1);
      assert.deepEqual(earned.history[0], { id: earned.history[0].id, kind: 'club_message', amount: 5, occurredAt: firstTime });
      assert.ok(!JSON.stringify(earned).includes(first.text));

      const erased = await request(`/club/messages/${writes[0].data.message.id}/delete?room=${room1}`, pilot, {});
      assert.equal(erased.status, 200);
      assert.equal((await wallet()).data.balance, 5);
      now++;
      const replay = await send(room1, first);
      assert.equal(replay.status, 200);
      assert.equal(replay.data.duplicate, true);
      assert.equal(replay.data.message.id, writes[0].data.message.id);
      assert.equal((await wallet()).data.balance, 5);
      const next = await send(room2, fresh());
      assert.equal(next.status, 200);
      assert.equal((await wallet()).data.balance, 10);
      now = Date.parse('2026-11-09T00:00:00Z');
      assert.equal((await send(room1, fresh())).status, 200);
      assert.equal((await wallet()).data.balance, 10);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM auth_points_ledger WHERE user_id=$1', [other.id])).rows[0].count, 0);
    });

    await t.test('history pagination preserves the total, and a revoked session loses access', async () => {
      for (let day = 0; day < 19; day++) {
        now += 86_400_000;
        assert.equal((await send(room1, fresh())).status, 200);
      }
      const newest = (await wallet()).data;
      assert.equal(newest.balance, 105);
      assert.equal(newest.history.length, 20);
      assert.equal(newest.nextCursor, newest.history.at(-1).id);
      const oldest = (await wallet('?before=' + newest.nextCursor)).data;
      assert.equal(oldest.balance, 105);
      assert.equal(oldest.history.length, 1);
      assert.equal(oldest.history[0].occurredAt, firstTime);
      assert.equal(oldest.nextCursor, null);
      assert.equal(new Set([...newest.history, ...oldest.history].map(row => row.id)).size, 21);
      assert.equal((await wallet('?before=0')).status, 400);
      assert.equal((await wallet('?before=9223372036854775808')).status, 400);
      await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE user_id=$1', [pilot.id, new Date(now)]);
      assert.equal((await wallet()).status, 401);
    });

    await t.test('open mode credits a signed-in account outside the pilot list', async () => {
      const openPoints = createPoints({ pool, userIds: [], forAll: true, clock });
      const openChat = createClubChat({ pool, service, store, points: openPoints, clock });
      assert.deepEqual(await openPoints.read(other.token, other.id),
        { accountId: other.id, enabled: true, balance: 0, history: [], nextCursor: null });
      await Promise.all([room1, room2].map(room => openChat.send(other.token, other.id, fresh(), room)));
      const result = await openPoints.read(other.token, other.id);
      assert.equal(result.balance, 5);
      assert.equal(result.history.length, 1);
      await assert.rejects(openPoints.read(other.token, pilot.id), { code: 'account_changed' });
      await assert.rejects(openPoints.read(pilot.token, pilot.id), { code: 'sign_in_required' });
    });

    await t.test('article credit requires both active time and the end and can only be earned once', async () => {
      now = Date.parse('2026-11-09T09:00:00Z');
      const id = 'pregnancy-001';
      assert.equal((await request('/points/articles', null, { articleId: id })).status, 401);
      assert.equal((await request('/points/articles', reader, { articleId: id }, other.id)).status, 409);
      assert.equal((await startReading(other, id)).status, 403);
      assert.equal((await startReading(reader, 'mom-week')).status, 404);
      assert.equal((await request('/points/articles', reader, { articleId: id, amount: 20 })).status, 400);
      const legacyHistory = (await request('/points', legacy)).data.history;
      assert.equal(legacyHistory.length, 1);
      assert.equal(legacyHistory[0].kind, 'club_message');
      assert.equal(legacyHistory[0].amount, 5);

      const started = await startReading(reader, id);
      assert.equal(started.cache, 'private, no-store');
      const { attemptId, availableAmount, remainingMs } = started.data;
      assert.equal(availableAmount, 20);
      assert.equal(remainingMs, 30_000);
      assert.equal((await pulse(reader, id, attemptId, true)).data.remainingMs, 30_000);
      now += 15_000;
      assert.equal((await pulse(reader, id, attemptId, false)).data.remainingMs, 15_000);
      now += 60_000;
      assert.equal((await pulse(reader, id, attemptId, true)).data.remainingMs, 15_000);
      const resumed = (await startReading(reader, id)).data;
      assert.equal(resumed.attemptId, attemptId);
      assert.equal(resumed.remainingMs, 15_000);
      await pool.query('UPDATE auth_points_article_reads SET required_ms=90000 WHERE attempt_id=$1', [attemptId]);
      now += 15_000;
      assert.equal((await pulse(reader, id, attemptId, false)).data.remainingMs, 0);
      assert.equal((await request('/points', reader)).data.balance, 0);

      const responses = await Promise.all([pulse(reader, id, attemptId, true), pulse(reader, id, attemptId, true)]);
      for (const response of responses) assert.deepEqual(response.data, { status: 'earned', amount: 20 });
      assert.deepEqual((await startReading(reader, id)).data, { status: 'already_earned' });
      const result = (await request('/points', reader)).data;
      assert.equal(result.balance, 20);
      assert.equal(result.history.length, 1);
      assert.equal(result.history[0].kind, 'article_read');
    });

    await t.test('chat and articles share the daily cap, and a zero result never turns into a later reward', async () => {
      now = Date.parse('2026-11-09T19:00:00Z');
      assert.equal((await readArticleToEnd(daily, 'pregnancy-001')).amount, 20);
      assert.equal((await readArticleToEnd(daily, 'pregnancy-002')).amount, 20);
      assert.equal((await send(room1, fresh(), daily)).status, 200);
      const first = (await startReading(daily, 'pregnancy-003')).data;
      const second = (await startReading(daily, 'pregnancy-004')).data;
      assert.equal(first.availableAmount, 15);
      now += 15_000;
      await pulse(daily, 'pregnancy-003', first.attemptId, false);
      await pulse(daily, 'pregnancy-004', second.attemptId, false);
      now += 15_000;
      assert.deepEqual((await pulse(daily, 'pregnancy-003', first.attemptId, true)).data, { status: 'earned', amount: 15 });
      const zero = { status: 'limited', limitedBy: 'day' };
      assert.deepEqual((await pulse(daily, 'pregnancy-004', second.attemptId, true)).data, zero);
      assert.equal((await request('/points', daily)).data.balance, 60);
      now = Date.parse('2026-11-09T21:00:00Z');
      assert.deepEqual((await pulse(daily, 'pregnancy-004', second.attemptId, true)).data, zero);
      assert.deepEqual((await startReading(daily, 'pregnancy-003')).data, { status: 'already_earned' });
      assert.equal((await readArticleToEnd(daily, 'pregnancy-004')).amount, 20);
      assert.equal((await request('/points', daily)).data.balance, 80);
    });

    await t.test('a concurrent chat and article share the remainder, and the week resets on Monday in Moscow', async () => {
      now = Date.parse('2026-11-09T09:00:00Z');
      const day = 86_400_000;
      for (const id of ['pregnancy-001', 'pregnancy-002']) assert.equal((await readArticleToEnd(weekly, id)).amount, 20);
      const { attemptId } = (await startReading(weekly, 'pregnancy-003')).data;
      now += 15_000;
      await pulse(weekly, 'pregnancy-003', attemptId, false);
      now += 15_000;
      const [message, article] = await Promise.all([
        send(room1, fresh(), weekly), pulse(weekly, 'pregnancy-003', attemptId, true),
      ]);
      assert.equal(message.status, 200);
      assert.ok([15, 20].includes(article.data.amount));
      assert.equal((await request('/points', weekly)).data.balance, 60);

      now += day;
      for (const id of ['pregnancy-004', 'pregnancy-005', 'pregnancy-006']) {
        assert.equal((await readArticleToEnd(weekly, id)).amount, 20);
      }
      now += day;
      for (const id of ['pregnancy-007', 'pregnancy-008']) assert.equal((await readArticleToEnd(weekly, id)).amount, 20);
      assert.equal((await send(room2, fresh(), weekly)).status, 200);
      assert.equal((await request('/points', weekly)).data.balance, 165);

      now += day;
      assert.equal((await readArticleToEnd(weekly, 'pregnancy-009')).amount, 15);
      now += day;
      assert.deepEqual((await startReading(weekly, 'pregnancy-010')).data, { status: 'limited', limitedBy: 'week' });
      assert.equal((await send(room1, fresh(), weekly)).status, 200);
      assert.equal((await request('/points', weekly)).data.balance, 180);
      now = Date.parse('2026-11-15T21:00:00Z');
      assert.equal((await readArticleToEnd(weekly, 'pregnancy-010')).amount, 20);
      assert.equal((await request('/points', weekly)).data.balance, 200);
    });
    await t.test('free video needs 80 percent of distinct played ranges and shares the daily cap', async () => {
      now = Date.parse('2026-11-17T09:00:00Z');
      const route = '/points/videos', videoId = 'week-video-004';
      assert.equal((await request(route, reader, { videoId: 'week-video-075' })).status, 404);
      assert.equal((await request(route, null, { videoId })).status, 401);
      assert.equal((await readArticleToEnd(reader, 'pregnancy-002')).amount, 20);
      assert.equal((await readArticleToEnd(reader, 'pregnancy-003')).amount, 20);
      assert.equal((await send(room1, fresh(), reader)).status, 200);
      const start = (await request(route, reader, { videoId })).data;
      assert.equal(start.availableAmount, 15);
      const tick = ranges => request(route, reader, { videoId, attemptId: start.attemptId, ranges });
      assert.equal((await tick([[0, 190000]])).data.status, 'watching');
      for (let i = 0; i < 7; i++) {
        now += 20_000;
        assert.equal((await tick([[0, 20000]])).data.status, 'watching');
      }
      for (let i = 1; i < 7; i++) {
        now += 20_000;
        assert.equal((await tick([[i * 20000, (i + 1) * 20000]])).data.status, 'watching');
      }
      now += 12_000;
      assert.deepEqual((await tick([[140000, 152000]])).data, { status: 'earned', amount: 15 });
      assert.deepEqual((await request(route, reader, { videoId })).data, { status: 'already_earned' });
      const result = (await request('/points', reader)).data;
      assert.equal(result.balance, 80);
      assert.equal(result.history.filter(row => row.kind === 'video_watch').length, 1);
    });
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await db.close();
  }
});
