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
    const points = createPoints({ pool, userIds: [pilot.id], clock });
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
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await db.close();
  }
});
