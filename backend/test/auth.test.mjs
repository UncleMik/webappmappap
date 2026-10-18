import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { testPool } from './auth-pool.mjs';
import { createStore } from '../auth/store.mjs';
import { createAuthService } from '../auth/service.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { hashToken, normalizeEmail, CODE_TTL_MS, SESSION_TTL_MS } from '../auth/security.mjs';
import { createMailer, createGetCourse } from '../auth/providers.mjs';

let database, pool, now, store, service, emails, gcCalls, gcFails, mailFails;
const secret = 'test-only-secret-with-more-than-32-bytes';
before(async () => { database = await testPool(); pool = database.pool; });
after(async () => { await database?.close(); });
beforeEach(async () => {
  await pool.query('TRUNCATE auth_sessions,auth_users,auth_challenges,auth_email_state,auth_mail_events,auth_gc_jobs,auth_rate_limits');
  now = Date.now(); emails = []; gcCalls = []; gcFails = false; mailFails = false;
  store = createStore(pool, { secret, clock: () => now });
  service = createAuthService({ store,
    sendMail: async data => { if (mailFails) throw new Error('secret provider error'); emails.push(data); },
    ensureGetCourse: async email => { gcCalls.push(email); if (gcFails) throw new Error('private upstream error'); return '12345'; },
  });
});
const codeFor = challenge => emails.find(email => email.idempotencyKey === challenge).code;
async function login(email = 'student@example.ru') {
  const request = await service.request(email);
  return service.verify(request.challenge, codeFor(request.challenge));
}

test('email normalization preserves plus tags and dots and rejects injection', () => {
  assert.equal(normalizeEmail(' A.B+App@EXAMPLE.RU '), 'a.b+app@example.ru');
  assert.throws(() => normalizeEmail('a@example.ru\r\nBcc:b@example.ru'));
  assert.throws(() => normalizeEmail('bad@@example.ru'));
});
test('code is not stored in plaintext; GetCourse is untouched before email verification', async () => {
  const { challenge } = await service.request('student@example.ru');
  const row = (await pool.query('SELECT * FROM auth_challenges')).rows[0];
  assert.equal(row.token_hash, hashToken(challenge));
  assert.equal(row.code_mac.length, 64);
  assert.equal(gcCalls.length, 0);
  await assert.rejects(service.complete(challenge), error => error.code === 'invalid_code');
  assert.equal(gcCalls.length, 0);
});
test('registration creates a GetCourse link first and issues exactly one persistent session', async () => {
  const { challenge } = await service.request('student@example.ru');
  const result = await service.verify(challenge, codeFor(challenge));
  assert.deepEqual(gcCalls, ['student@example.ru']);
  assert.equal((await service.session(result.sessionToken)).email, 'student@example.ru');
  await assert.rejects(service.verify(challenge, codeFor(challenge)), error => error.code === 'invalid_code');
  assert.equal((await pool.query('SELECT count(*)::integer n FROM auth_users')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM auth_sessions')).rows[0].n, 1);
});
test('failed GetCourse prevents session/account creation; persisted retry completes without duplicate', async () => {
  gcFails = true;
  const { challenge } = await service.request('student@example.ru');
  await assert.rejects(service.verify(challenge, codeFor(challenge)), error => error.code === 'getcourse_pending');
  assert.equal((await pool.query('SELECT count(*)::integer n FROM auth_users')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM auth_sessions')).rows[0].n, 0);
  gcFails = false; now += 6000;
  const result = await service.complete(challenge);
  assert.equal(result.user.email, 'student@example.ru');
  assert.equal((await pool.query('SELECT count(*)::integer n FROM auth_gc_jobs')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM auth_users')).rows[0].n, 1);
});
test('returning user logs in without creating another GetCourse card', async () => {
  await login(); now += 61_000;
  const result = await login();
  assert.equal(gcCalls.length, 1);
  assert.ok(await service.session(result.sessionToken));
});
test('expired code cannot log in or create a GetCourse card', async () => {
  const { challenge } = await service.request('student@example.ru'); now += CODE_TTL_MS + 1;
  await assert.rejects(service.verify(challenge, codeFor(challenge)), error => error.code === 'invalid_code');
  assert.equal(gcCalls.length, 0);
});
test('resend invalidates old code, keeps failed attempts and locks after five guesses', async () => {
  const first = await service.request('student@example.ru');
  const wrong = codeFor(first.challenge) === '000000' ? '000001' : '000000';
  for (let i = 0; i < 4; i++) await assert.rejects(service.verify(first.challenge, wrong));
  now += 61_000;
  const second = await service.request('student@example.ru');
  await assert.rejects(service.verify(first.challenge, codeFor(first.challenge)));
  const secondWrong = codeFor(second.challenge) === '000000' ? '000001' : '000000';
  await assert.rejects(service.verify(second.challenge, secondWrong));
  await assert.rejects(service.verify(second.challenge, codeFor(second.challenge)));
  now += 61_000;
  await assert.rejects(service.request('student@example.ru'), error => error.status === 429);
  assert.equal(gcCalls.length, 0);
});
test('one-minute resend interval and rolling ten emails/hour enforced', async () => {
  await service.request('student@example.ru');
  await assert.rejects(service.request('student@example.ru'), error => error.status === 429);
  for (let i = 1; i < 10; i++) { now += 61_000; await service.request('student@example.ru'); }
  now += 61_000;
  await assert.rejects(service.request('student@example.ru'), error => error.status === 429);
  now += 3_600_000; await service.request('student@example.ru');
});
test('failed mail delivery cannot be used to sign in', async () => {
  mailFails = true;
  await assert.rejects(service.request('student@example.ru'), error => error.code === 'mail_unavailable');
  assert.ok((await pool.query('SELECT consumed_at FROM auth_challenges')).rows[0].consumed_at);
  assert.equal(gcCalls.length, 0);
});
test('concurrent completion consumes the code only once', async () => {
  const { challenge } = await service.request('student@example.ru');
  await store.verifyCode(challenge, codeFor(challenge)); await service.processJob();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.complete(challenge)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM auth_sessions')).rows[0].n, 1);
});
test('logout revokes server session and absolute lifetime is thirty days', async () => {
  const a = await login(); await service.logout(a.sessionToken); assert.equal(await service.session(a.sessionToken), null);
  now += 61_000; const b = await login(); now += SESSION_TTL_MS + 1;
  assert.equal(await service.session(b.sessionToken), null);
});
test('GetCourse adapter preserves existing fields and refuses unexpected redirects/error responses', async () => {
  let sent;
  const ensure = createGetCourse({ origin: 'https://legkierody.ru', key: 'test-key' }, async (url, options) => {
    sent = { url, options };
    return Response.json({ success: true, result: { success: true, user_id: 9876 } });
  });
  assert.equal(await ensure('student@example.ru'), '9876');
  assert.equal(sent.options.redirect, 'error');
  const body = sent.options.body;
  assert.equal(body.get('action'), 'add');
  // Contract with the school process: a new app card must match its exact
  // marker, while refresh=0 preserves every existing card and its preferences.
  assert.deepEqual(JSON.parse(Buffer.from(body.get('params'), 'base64').toString()), {
    user: { email: 'student@example.ru', addfields: { gc_system_user_utm_source: 'webpril_app_auth' } },
    system: { refresh_if_exists: 0 }, session: { utm_source: 'webpril_app_auth' },
  });
  const broken = createGetCourse({ origin: 'https://legkierody.ru', key: 'test-key' }, async () => Response.json({ success: true, result: { success: false, user_id: 9876 } }));
  await assert.rejects(broken('student@example.ru'));
});
test('mailer sends one recipient, no tracking and no suppression bypasses', async () => {
  let sent;
  const mailer = createMailer({ key: 'test-key', sender: 'auth@legkierody.ru', templateId: 'test-template' }, async (url, options) => {
    sent = JSON.parse(options.body).message;
    return Response.json({ status: 'success', job_id: 'job-1' });
  });
  await mailer({ email: 'student@example.ru', code: '123456', idempotencyKey: 'test-request' });
  assert.equal(sent.recipients.length, 1); assert.equal(sent.track_read, 0); assert.equal(sent.track_links, 0);
  assert.equal(sent.bypass_unsubscribed, 0); assert.equal(sent.bypass_complained, 0); assert.equal(sent.skip_unsubscribe, 0);
});
test('HTTP rejects foreign origins, protects cookie, avoids caching and revokes it on logout', async () => {
  const server = createAuthServer({ service, store, origin: 'https://app.legkie-rody.ru', enabled: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, origin = 'https://app.legkie-rody.ru', cookie) => fetch(base + '/api/auth/' + path, {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post('request', { email: 'student@example.ru' }, 'https://evil.example')).status, 403);
    const requested = await post('request', { email: 'student@example.ru' });
    const { challenge } = await requested.json();
    const verified = await post('verify', { challenge, code: codeFor(challenge) });
    assert.equal(verified.status, 200); assert.equal(verified.headers.get('cache-control'), 'no-store');
    const cookie = verified.headers.get('set-cookie');
    for (const flag of ['__Host-school_session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=2592000']) assert.ok(cookie.includes(flag));
    const session = await fetch(base + '/api/auth/session', { headers: { cookie: cookie.split(';')[0] } });
    assert.equal((await session.json()).authenticated, true);
    const logout = await post('logout', {}, undefined, cookie.split(';')[0]); assert.equal(logout.status, 200);
    assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
    const after = await fetch(base + '/api/auth/session', { headers: { cookie: cookie.split(';')[0] } });
    assert.equal((await after.json()).authenticated, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('disabled authentication accepts no registrations or sessions', async () => {
  const server = createAuthServer({ service, store, origin: 'https://app.legkie-rody.ru', enabled: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/session`);
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'auth_unavailable');
    assert.equal(emails.length, 0); assert.equal(gcCalls.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('persisted session survives service reconstruction; expired pending proof cannot finish later', async () => {
  const signed = await login();
  const restarted = createStore(pool, { secret, clock: () => now });
  assert.equal((await restarted.session(signed.sessionToken)).email, 'student@example.ru');
  now += 61_000; gcFails = true;
  const request = await service.request('other@example.ru');
  await assert.rejects(service.verify(request.challenge, codeFor(request.challenge)));
  now += CODE_TTL_MS + 1; gcFails = false;
  await assert.rejects(service.complete(request.challenge), error => error.code === 'invalid_code');
  assert.equal((await pool.query('SELECT count(*)::integer n FROM auth_users')).rows[0].n, 1);
});
