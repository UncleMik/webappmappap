import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { testPool } from './auth-pool.mjs';
import { createStore, transaction } from '../auth/store.mjs';
import { createAuthService } from '../auth/service.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { hashToken, randomToken } from '../auth/security.mjs';

let db, pool, store, service, now, mail;
before(async () => { db = await testPool(); pool = db.pool; });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await pool.query('TRUNCATE auth_sessions,auth_users,auth_challenges,auth_email_state,auth_mail_events,auth_gc_jobs,auth_rate_limits');
  now = Date.now(); mail = new Map();
  store = createStore(pool, { secret: 'single-session-test-secret-over-32-bytes', clock: () => now });
  service = createAuthService({ store, makeCode: () => '123456',
    sendMail: async ({ email, code }) => mail.set(email, code),
    ensureGetCourse: async () => String(1000 + mail.size) });
});
async function login(email = 'one@example.ru') {
  const { challenge } = await service.request(email);
  return service.verify(challenge, mail.get(email));
}

test('successful new login revokes previous session, preserves other accounts and lasts 30 days', async () => {
  const first = await login();
  const other = await login('other@example.ru');
  now += 61_000;
  const latest = await login();
  assert.equal(await service.session(first.sessionToken), null);
  assert.equal((await service.session(latest.sessionToken)).id, first.user.id);
  assert.ok(await service.session(other.sessionToken));
  const state = await service.sessionState(first.sessionToken);
  assert.deepEqual(state, { authenticated: false, user: null, reason: 'session_replaced' });
  await service.logout(first.sessionToken);
  assert.ok(await service.session(latest.sessionToken), 'logout with old cookie cannot revoke new login');
  now += 30 * 24 * 60 * 60_000;
  assert.equal(await service.session(latest.sessionToken), null);
});

test('requesting or mistyping a code does not revoke the existing login', async () => {
  const first = await login(); now += 61_000;
  const { challenge } = await service.request('one@example.ru');
  assert.ok(await service.session(first.sessionToken));
  await assert.rejects(service.verify(challenge, '000000'));
  assert.ok(await service.session(first.sessionToken));
  await assert.rejects(service.complete(challenge));
  assert.ok(await service.session(first.sessionToken));
});

test('failed session replacement rolls back both revocation and code consumption', async () => {
  const first = await login(); const other = await login('other@example.ru'); now += 61_000;
  const { challenge } = await service.request('one@example.ru');
  await store.verifyCode(challenge, '123456');
  // A forced token collision makes the INSERT fail after revocation inside the transaction.
  await assert.rejects(store.finish(challenge, other.sessionToken));
  assert.ok(await service.session(first.sessionToken));
  const latest = await service.complete(challenge);
  assert.equal(await service.session(first.sessionToken), null);
  assert.ok(await service.session(latest.sessionToken));
});

test('concurrent completions leave exactly one current session and database rejects duplicates', async () => {
  const first = await login(); now += 61_000;
  const { challenge } = await service.request('one@example.ru');
  await store.verifyCode(challenge, '123456');
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => service.complete(challenge)));
  const successful = attempts.filter(x => x.status === 'fulfilled');
  assert.equal(successful.length, 1);
  assert.equal(await service.session(first.sessionToken), null);
  const { rows: [count] } = await pool.query('SELECT count(*)::int n FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL', [first.user.id]);
  assert.equal(count.n, 1);
  await assert.rejects(pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',
    [hashToken('duplicate'), first.user.id, new Date(now + 60_000)]), error => error.code === '23505');
});

test('replaced cookie loses access to check, profile, videos and all course routes', async () => {
  const first = await login(); now += 61_000; const latest = await login();
  const origin = 'https://app.legkie-rody.ru';
  const server = createAuthServer({ service, store, origin, enabled: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: `__Host-school_session=${first.sessionToken}` };
  try {
    for (const path of ['/check', '/videos/vitamins', '/course-check', '/courses', '/courses/1', '/courses/1/lessons/2']) {
      assert.equal((await fetch(base + '/api/auth' + path, { headers })).status, 401, path);
    }
    const state = await fetch(base + '/api/auth/session', { headers });
    assert.deepEqual(await state.json(), { authenticated: false, user: null, reason: 'session_replaced' });
    const save = await fetch(base + '/api/auth/profile', { method: 'POST',
      headers: { ...headers, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'pregnancy', name: 'Анна', method: 'weeks', weeks: 27, days: 0, goals: [0] }) });
    assert.equal(save.status, 401);
    assert.equal((await fetch(base + '/api/auth/check', { headers: { cookie: `__Host-school_session=${latest.sessionToken}` } })).status, 204);
    assert.equal(state.headers.get('cache-control'), 'no-store');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('independently verified concurrent logins serialize and only the last committed token survives', async () => {
  const first = await login();
  const proofs = [randomToken(), randomToken()];
  const tokens = [randomToken(), randomToken()];
  // Two verified requests already in flight; exercise separate proofs, not replay of one code.
  for (const proof of proofs) {
    await pool.query(`INSERT INTO auth_challenges(token_hash,email,code_mac,expires_at,verified_at)
      VALUES($1,$2,'test-only-verified-proof',$3,$4)`,
    [hashToken(proof), first.user.email, new Date(now + 60_000), new Date(now)]);
  }
  const completed = await Promise.all(proofs.map((proof, i) => store.finish(proof, tokens[i])));
  assert.ok(completed.every(result => result.user.id === first.user.id));
  assert.equal((await Promise.all(tokens.map(token => service.session(token)))).filter(Boolean).length, 1);
  assert.equal(await service.session(first.sessionToken), null);
});

test('migration keeps latest valid session per account, handles ties and is idempotent', async () => {
  const legacy = await testPool();
  try {
    await legacy.pool.query('DROP INDEX IF EXISTS auth_sessions_one_active_user');
    await legacy.pool.query('ALTER TABLE auth_sessions DROP COLUMN IF EXISTS revoked_at');
    const id = randomUUID(), otherId = randomUUID(), expiredId = randomUUID();
    await legacy.pool.query('INSERT INTO auth_users(id,email,getcourse_id) VALUES($1,$2,1),($3,$4,2)', [id, 'legacy@example.ru', otherId, 'other@example.ru']);
    await legacy.pool.query('INSERT INTO auth_users(id,email,getcourse_id) VALUES($1,$2,3)', [expiredId, 'expired@example.ru']);
    const future = new Date(Date.now() + 86_400_000), past = new Date(Date.now() - 86_400_000);
    const tiedTime = new Date();
    for (const [token, user, expiry, created] of [['old', id, future, past], ['tie-a', id, future, tiedTime], ['tie-b', id, future, tiedTime], ['expired', id, past, future], ['other', otherId, future, past], ['all-expired', expiredId, past, past]]) {
      await legacy.pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)', [token, user, expiry, created]);
    }
    const migration = await readFile(new URL('../auth/single-session-migration.sql', import.meta.url), 'utf8');
    await transaction(legacy.pool, client => client.query(migration));
    const before = await legacy.pool.query('SELECT token_hash,revoked_at FROM auth_sessions ORDER BY token_hash');
    const alive = before.rows.filter(row => row.revoked_at === null).map(row => row.token_hash);
    assert.equal(alive.length, 2);
    assert.ok(alive.includes('other'));
    assert.ok(alive.includes('tie-b'), 'equal creation times have a deterministic winner');
    assert.ok(before.rows.find(row => row.token_hash === 'all-expired').revoked_at);
    await transaction(legacy.pool, client => client.query(migration));
    assert.deepEqual((await legacy.pool.query('SELECT token_hash,revoked_at FROM auth_sessions ORDER BY token_hash')).rows, before.rows);
  } finally { await legacy.close(); }
});
