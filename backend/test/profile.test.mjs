import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { testPool } from './auth-pool.mjs';
import { createStore } from '../auth/store.mjs';
import { createAuthService } from '../auth/service.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { normalizeProfile } from '../auth/profile.mjs';
import { SESSION_TTL_MS } from '../auth/security.mjs';

const origin = 'https://app.legkie-rody.ru';
const secret = 'profile-test-secret-with-more-than-32-bytes';
let database, pool, now, store, service, codes, server, base;

before(async () => { database = await testPool(); pool = database.pool; });
after(async () => { await database?.close(); });
beforeEach(async () => {
  await pool.query('TRUNCATE auth_sessions,auth_users,auth_challenges,auth_email_state,auth_mail_events,auth_gc_jobs,auth_rate_limits');
  now = Date.parse('2026-10-19T22:30:00Z'); codes = new Map();
  store = createStore(pool, { secret, clock: () => now });
  service = createAuthService({ store,
    sendMail: async ({ idempotencyKey, code }) => codes.set(idempotencyKey, code),
    ensureGetCourse: async email => email === 'other@example.ru' ? '12346' : '12345',
  });
});

const pregnancy = { name: '  Анна  ', stage: 'pregnancy', method: 'weeks', weeks: '27', days: '2', goals: [0, 4] };
async function login(email) {
  const { challenge } = await service.request(email);
  return service.verify(challenge, codes.get(challenge));
}
async function withServer(run) {
  server = createAuthServer({ service, store, origin, enabled: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  try { await run(); } finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (body, token, requestOrigin = origin) => fetch(`${base}/api/auth/profile`, {
  method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json',
    ...(token ? { cookie: `__Host-school_session=${token}` } : {}) }, body: JSON.stringify(body),
});

test('server calendar and both pregnancy routes enforce exact dates and bounds', () => {
  const fixed = Date.parse('2026-10-19T22:30:00Z'); // 20 October in Moscow.
  assert.equal(normalizeProfile(pregnancy, fixed).dueDate, '2027-01-17');
  assert.equal(normalizeProfile({ ...pregnancy, method: 'due', due: '2027-01-17' }, fixed).dueDate, '2027-01-17');
  assert.equal(normalizeProfile({ ...pregnancy, method: 'conception', conception: '2026-04-17' }, fixed).dueDate, '2027-01-08');
  assert.equal(normalizeProfile({ ...pregnancy, method: 'conception', conception: '2026-10-20' }, fixed).dueDate, '2027-07-13');
  assert.equal(normalizeProfile({ ...pregnancy, method: 'due', due: '2027-07-27' }, fixed).dueDate, '2027-07-27');
  for (const data of [
    { ...pregnancy, name: '\u0000Анна' }, { ...pregnancy, name: 'a'.repeat(81) },
    { ...pregnancy, goals: [] }, { ...pregnancy, goals: [0, 0] },
    { ...pregnancy, goals: ['0'] }, { ...pregnancy, goals: [7] },
    { ...pregnancy, weeks: 43, days: 0 }, { ...pregnancy, weeks: '', days: 0 },
    { ...pregnancy, weeks: '1.5', days: 0 }, { ...pregnancy, weeks: 42, days: 7 },
    { ...pregnancy, method: 'due', due: '2027-02-30' },
    { ...pregnancy, method: 'due', due: '2026-02-30' },
    { ...pregnancy, method: 'conception', conception: '2026-10-21' },
    { ...pregnancy, method: 'conception', conception: '2027-01-01' },
  ]) assert.throws(() => normalizeProfile(data, fixed), error => error.status === 400);
  assert.equal(normalizeProfile({ ...pregnancy, method: 'conception', conception: '2024-02-29' }, Date.parse('2024-03-01T12:00:00Z')).dueDate, '2024-11-21');
  const mother = normalizeProfile({ name: 'Мария', stage: 'mother', birth: '2026-10-20', goals: [6] }, fixed);
  assert.equal(mother.birthDate, '2026-10-20'); assert.equal(mother.method, null);
  for (const birth of ['2026-10-21', '2026-02-30', '1899-12-31']) {
    assert.throws(() => normalizeProfile({ name: 'Мария', stage: 'mother', birth, goals: [6] }, fixed), error => error.status === 400);
  }
});

test('profile persists across new sessions and store reconstruction without leaking to another user', async () => {
  const first = await login('first@example.ru');
  assert.equal(first.user.profile, null);
  const user = await service.saveProfile(first.sessionToken, { ...pregnancy, ignored: 'not saved' });
  assert.equal(user.profile.name, 'Анна'); assert.equal(user.profile.dueDate, '2027-01-17');
  assert.equal(Object.hasOwn(user.profile, 'ignored'), false);
  assert.deepEqual((await service.session(first.sessionToken)).profile, user.profile);
  const restarted = createStore(pool, { secret, clock: () => now });
  assert.deepEqual((await restarted.session(first.sessionToken)).profile, user.profile);
  now += 61_000;
  const again = await login('first@example.ru');
  assert.deepEqual(again.user.profile, user.profile);
  const other = await login('other@example.ru');
  assert.equal(other.user.profile, null);
  assert.notEqual(other.user.id, first.user.id);
});

test('HTTP validates session, origin, input size and expiry; logout revokes write access', async () => {
  const signed = await login('first@example.ru');
  await withServer(async () => {
    assert.equal((await post(pregnancy)).status, 401);
    assert.equal((await post(pregnancy, signed.sessionToken, 'https://evil.example')).status, 403);
    assert.equal((await post({ ...pregnancy, name: '' }, signed.sessionToken)).status, 400);
    assert.equal((await post({ ...pregnancy, padding: 'x'.repeat(4096) }, signed.sessionToken)).status, 413);
    const saved = await post(pregnancy, signed.sessionToken);
    assert.equal(saved.status, 200);
    const { user } = await saved.json();
    assert.equal(user.profile.name, 'Анна');
    const session = await fetch(`${base}/api/auth/session`, { headers: { cookie: `__Host-school_session=${signed.sessionToken}` } });
    assert.equal((await session.json()).user.profile.name, 'Анна');
    await service.logout(signed.sessionToken);
    assert.equal((await post(pregnancy, signed.sessionToken)).status, 401);
    now += 61_000;
    const again = await login('first@example.ru');
    now += SESSION_TTL_MS + 1;
    assert.equal((await post(pregnancy, again.sessionToken)).status, 401);
  });
});
