import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { testPool } from './auth-pool.mjs';
import { createCourseChecks, COURSE_CHECK_TTL_MS } from '../auth/course-checks.mjs';
import { createStore } from '../auth/store.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { hashToken, randomToken } from '../auth/security.mjs';

const user = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const origin = 'https://app.legkie-rody.ru';
const initial = Date.parse('2026-10-23T12:00:00Z');
let db, pool, now, checks, calls, fail, purchases, trainings, statuses;
const rejected = promise => assert.rejects(promise, e => e.status === 503 && e.code === 'course_check_unavailable');
const purchase = gcId => ({ id: 10, product_id: 4309095, user_id: gcId, is_actual: 1, is_payed: 0,
  period_type: 'limited', start_at: '2026-10-23 11:00:00', finish_at: '2027-01-23 11:00:00', state: null,
  money_sum: 'private-value', extra: 'must-not-persist' });
before(async () => {
  db = await testPool(); pool = db.pool;
  await pool.query(await readFile(new URL('../auth/course-checks-migration.sql', import.meta.url), 'utf8'));
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await pool.query('TRUNCATE course_access_checks,auth_sessions,auth_users');
  await pool.query('INSERT INTO auth_users(id,email,getcourse_id,profile) VALUES($1,$2,123,$3),($4,$5,456,$3)',
    [user, 'one@example.org', JSON.stringify({ completedAt: '2026-10-22T12:00:00Z' }), other, 'two@example.org']);
  now = initial; calls = []; fail = false; purchases = [purchase(123)]; trainings = [{ id: 935397478, title: 'Private course' }];
  statuses = [{ lessonId: 347529601, status: 'accepted', updatedAt: '2026-10-23 11:00:00',
    answer_text: 'private student answer', files: ['private file'] }];
  checks = createCourseChecks({ pool, clock: () => now, tech: {
    getPurchases: async id => { calls.push(['purchases', id]); if (fail) throw new Error('secret provider payload'); return purchases; },
    getUserTrainings: async id => { calls.push(['trainings', id]); return trainings; },
    getLessonStatuses: async id => { calls.push(['statuses', id]); return statuses; },
  } });
});

test('five-minute evidence survives service reconstruction, coalesces calls, and strips irrelevant fields', async () => {
  const [first, concurrent] = await Promise.all([checks.requireCurrent(user), checks.requireCurrent(user)]);
  assert.deepEqual(first, concurrent);
  assert.equal(first.expiresAt, new Date(initial + COURSE_CHECK_TTL_MS).toISOString());
  assert.equal(calls.length, 3);
  assert.equal(first.snapshot.version, 2);
  assert.equal(first.snapshot.purchases[0].is_payed, 0);
  assert.equal('money_sum' in first.snapshot.purchases[0], false);
  assert.equal(JSON.stringify(first).includes('private-value'), false);
  assert.deepEqual(first.snapshot.lessonStates,
    [{ lessonId: 347529601, status: 'accepted', updatedAt: '2026-10-23 11:00:00' }]);
  assert.doesNotMatch(JSON.stringify(first), /private student answer|private file/);
  const restarted = createCourseChecks({ pool, clock: () => now, tech: {
    getPurchases: () => { throw new Error('must use persisted evidence'); }, getUserTrainings: () => { throw new Error('must use persisted evidence'); },
    getLessonStatuses: () => { throw new Error('must use persisted evidence'); },
  } });
  now += COURSE_CHECK_TTL_MS - 1;
  assert.deepEqual(await restarted.requireCurrent(user), first);
  const { rows: [saved] } = await pool.query('SELECT * FROM course_access_checks WHERE user_id=$1', [user]);
  assert.equal(+new Date(saved.expires_at) - +new Date(saved.checked_at), COURSE_CHECK_TTL_MS);
});

test('exact expiry blocks stale data on failure and a subsequent empty purchase result replaces old evidence', async () => {
  const first = await checks.requireCurrent(user);
  now += COURSE_CHECK_TTL_MS; fail = true;
  await rejected(checks.requireCurrent(user));
  const count = calls.length;
  await rejected(checks.requireCurrent(user));
  assert.equal(calls.length, count); // concurrent requests cannot hammer a failed provider.
  const { rows: [old] } = await pool.query('SELECT expires_at,snapshot FROM course_access_checks WHERE user_id=$1', [user]);
  assert.equal(new Date(old.expires_at).toISOString(), first.expiresAt);
  assert.equal(old.snapshot.purchases.length, 1);
  now += 5001; fail = false; purchases = []; trainings = []; statuses = [];
  const refreshed = await checks.requireCurrent(user);
  assert.deepEqual(refreshed.snapshot.purchases, []);
  assert.deepEqual(refreshed.snapshot.trainingIds, []);
  assert.deepEqual(refreshed.snapshot.lessonStates, []);
});

test('partial provider failures never become a successful check and caller errors stay private', async () => {
  const partial = createCourseChecks({ pool, clock: () => now, tech: {
    getPurchases: async () => [purchase(123)], getUserTrainings: async () => { throw new Error('school key and private body'); },
    getLessonStatuses: async () => [],
  } });
  await rejected(partial.requireCurrent(user));
  const { rows: [row] } = await pool.query('SELECT snapshot,checked_at,expires_at FROM course_access_checks WHERE user_id=$1', [user]);
  assert.equal(row.snapshot, null); assert.equal(row.checked_at, null); assert.equal(row.expires_at, null);
  await rejected(checks.requireCurrent('not-a-user'));
});

test('a failed lesson-status read cannot publish partial evidence', async () => {
  const partial = createCourseChecks({ pool, clock: () => now, tech: {
    getPurchases: async () => [purchase(123)], getUserTrainings: async () => trainings,
    getLessonStatuses: async () => { throw new Error('private answer text and school key'); },
  } });
  await rejected(partial.requireCurrent(user));
  const { rows: [row] } = await pool.query('SELECT snapshot,checked_at,expires_at FROM course_access_checks WHERE user_id=$1', [user]);
  assert.equal(row.snapshot, null);
  assert.equal(row.checked_at, null);
  assert.equal(row.expires_at, null);
});

test('version-one evidence is stale even within five minutes and must be refreshed', async () => {
  const first = await checks.requireCurrent(user);
  await pool.query('UPDATE course_access_checks SET snapshot=$2::jsonb WHERE user_id=$1',
    [user, JSON.stringify({ ...first.snapshot, version: 1, lessonStates: undefined })]);
  const callCount = calls.length;
  statuses = [{ lessonId: 347529601, status: 'new', updatedAt: null,
    answer_text: 'must not persist' }];
  const refreshed = await checks.requireCurrent(user);
  assert.equal(refreshed.snapshot.version, 2);
  assert.equal(calls.length, callCount + 3);
  assert.deepEqual(refreshed.snapshot.lessonStates,
    [{ lessonId: 347529601, status: 'new', updatedAt: null }]);
  assert.doesNotMatch(JSON.stringify(refreshed), /must not persist/);
});

test('missing Tech API configuration and an incomplete profile close the course check without breaking sign-in', async () => {
  let completed = true;
  const server = createAuthServer({ service: { session: async () => ({ id: user, profile: completed ? { completedAt: '2026-10-23' } : null }) },
    store: {}, origin, enabled: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/auth/course-check')).status, 503);
    assert.equal((await fetch(base + '/api/auth/check')).status, 204);
    completed = false;
    assert.equal((await fetch(base + '/api/auth/course-check')).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('evidence is bound to school identity and incomplete or unrelated purchase rows fail closed', async () => {
  await checks.requireCurrent(user);
  await pool.query('UPDATE auth_users SET getcourse_id=789 WHERE id=$1', [user]);
  // The old snapshot is still within five minutes but belongs to the previous GC identity.
  await rejected(checks.requireCurrent(user));
  assert.equal(calls.at(-3)[1], 789);
  now += 5001; purchases = [purchase(789)];
  assert.equal((await checks.requireCurrent(user)).snapshot.purchases[0].user_id, 789);
  now += COURSE_CHECK_TTL_MS; purchases = [{}];
  await rejected(checks.requireCurrent(user));
  assert.equal((await checks.requireCurrent(other).catch(e => e)).code, 'course_check_unavailable');
});

test('slow reads do not renew evidence from completion time, and obsolete leases cannot overwrite a newer check', async () => {
  let finish;
  const slow = createCourseChecks({ pool, clock: () => now, tech: {
    getPurchases: () => new Promise(resolve => { finish = resolve; }), getUserTrainings: async () => [],
    getLessonStatuses: async () => [],
  } });
  const pending = slow.requireCurrent(user);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  const second = createCourseChecks({ pool, clock: () => now, tech: {
    getPurchases: async () => [], getUserTrainings: async () => [], getLessonStatuses: async () => [],
  } });
  await rejected(second.requireCurrent(user));
  now += 30_001;
  const winner = await second.requireCurrent(user);
  finish([purchase(123)]);
  await rejected(pending);
  assert.deepEqual(await second.requireCurrent(user), winner);
  assert.deepEqual(winner.snapshot.purchases, []);
});

test('changing the linked school identity between subject lookup and cached read cannot return old evidence', async () => {
  await checks.requireCurrent(user);
  let changed = false;
  const race = createCourseChecks({ clock: () => now, pool: { query: async (sql, args) => {
    const result = await pool.query(sql, args);
    if (sql === 'SELECT getcourse_id FROM auth_users WHERE id=$1' && !changed) {
      changed = true;
      await pool.query('UPDATE auth_users SET getcourse_id=789 WHERE id=$1', [user]);
    }
    return result;
  } }, tech: { getPurchases: () => { throw new Error('must not query obsolete identity'); },
    getUserTrainings: () => { throw new Error('must not query obsolete identity'); },
    getLessonStatuses: () => { throw new Error('must not query obsolete identity'); } } });
  await rejected(race.requireCurrent(user));
  assert.equal(changed, true);
});

test('a read taking longer than five minutes cannot be saved as current; database rejects excessive TTL', async () => {
  const slow = createCourseChecks({ pool, clock: () => now, tech: {
    getPurchases: async () => { now += COURSE_CHECK_TTL_MS; return []; }, getUserTrainings: async () => [],
    getLessonStatuses: async () => [],
  } });
  await rejected(slow.requireCurrent(user));
  await assert.rejects(pool.query(`UPDATE course_access_checks SET snapshot='{}',checked_at=$2,expires_at=$3 WHERE user_id=$1`,
    [user, new Date(initial), new Date(initial + COURSE_CHECK_TTL_MS + 1)]));
});

test('HTTP uses the session identity, hides raw evidence, denies query impersonation and expired/offline checks', async () => {
  const token = randomToken();
  await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hashToken(token), user, new Date(initial + 86_400_000)]);
  const store = createStore(pool, { secret: 'a-test-secret-with-at-least-thirty-two-bytes', clock: () => now });
  const server = createAuthServer({ service: { session: t => store.session(t) }, store, courseChecks: checks, origin, enabled: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path = '/api/auth/course-check', cookie = token) => fetch(base + path, { headers: cookie ? { cookie: `__Host-school_session=${cookie}` } : {} });
  try {
    assert.equal((await get(undefined, null)).status, 401); assert.equal(calls.length, 0);
    assert.equal((await get('/api/auth/course-check?userId=' + other)).status, 400); assert.equal(calls.length, 0);
    const response = await get(); const body = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(body).sort(), ['checkedAt', 'expiresAt', 'verification']);
    assert.equal(body.verification, 'current'); assert.equal('snapshot' in body, false);
    now += COURSE_CHECK_TTL_MS; fail = true;
    const denied = await get(); assert.equal(denied.status, 503);
    assert.equal((await denied.text()).includes('secret'), false);
    assert.equal((await get('/api/auth/check')).status, 204); // course failure does not log out the user.
    await store.logout(token);
    assert.equal((await get()).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
