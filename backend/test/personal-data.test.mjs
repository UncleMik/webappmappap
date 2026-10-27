import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { testPool } from './auth-pool.mjs';
import { createPersonalData } from '../auth/personal-data.mjs';
import { hashToken } from '../auth/security.mjs';
import { createAuthServer } from '../auth/http.mjs';

test('personal records belong to the session owner, reject revoked sessions, and import once', async () => {
  const { pool, close } = await testPool();
  try {
    await pool.query(await readFile(new URL('../auth/personal-data-migration.sql', import.meta.url), 'utf8'));
    const a = randomUUID(), b = randomUUID();
    const tokenA = 'a'.repeat(43), tokenB = 'b'.repeat(43);
    for (const [id, email, token, gc] of [[a, 'a@example.com', tokenA, 1], [b, 'b@example.com', tokenB, 2]]) {
      await pool.query('INSERT INTO auth_users(id,email,getcourse_id) VALUES($1,$2,$3)', [id, email, gc]);
      await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'1 day\')', [hashToken(token), id]);
    }
    const records = createPersonalData(pool);
    assert.deepEqual((await records.read(tokenA)).weights, []);
    const id = randomUUID();
    await records.write(tokenA, { operation: 'addWeight', id, value: 70.5, recordedAt: '2026-10-27T10:00:00.000Z' });
    await records.write(tokenA, { operation: 'addWeight', id, value: 70.5, recordedAt: '2026-10-27T10:00:00.000Z' });
    await assert.rejects(records.write(tokenA, { operation: 'addWeight', id, value: 71, recordedAt: '2026-10-27T10:00:00.000Z' }), error => error.status === 409);
    assert.equal((await records.read(tokenA)).weights.length, 1);
    assert.equal((await records.read(tokenB)).weights.length, 0);
    await records.write(tokenA, { operation: 'setBaby', week: 27, heartRate: '150', ultrasoundDate: '', ultrasoundWeek: '', position: 'head' });
    const legacy = { weights: [{ value: 68, recordedAt: '2026-10-01T10:00:00.000Z' }],
      pressure: { systolic: 120, diastolic: 80 }, wellbeing: { state: 'good', comment: 'ok' },
      baby: { 27: { heartRate: '145', ultrasoundDate: '2026-10-02', ultrasoundWeek: '27', position: 'head' } },
      movements: [Date.parse('2026-10-27T11:00:00.000Z')], readArticles: ['pregnancy-082'], favorites: ['back-practice'] };
    await assert.rejects(records.write(tokenA, { operation: 'import', data: legacy }), error => error.status === 400);
    await records.write(tokenA, { operation: 'import', confirmed: true, data: legacy });
    const once = await records.write(tokenA, { operation: 'import', confirmed: true, data: legacy });
    assert.equal(once.weights.length, 2);
    assert.equal(once.pressure.length, 1);
    assert.equal(once.wellbeing.length, 1);
    assert.equal(once.movements.length, 1);
    assert.equal(once.baby['27'].heartRate, '150');
    assert.equal(once.baby['27'].position, 'head');
    assert.deepEqual(once.readArticles, ['pregnancy-082']);
    assert.deepEqual(once.favorites, ['back-practice']);
    assert.equal((await records.read(tokenB)).movements.length, 0);
    for (const [operation, values] of [
      ['addPressure', { systolic: 121, diastolic: 80 }],
      ['addPressure', { systolic: 122, diastolic: 81 }],
      ['addWellbeing', { state: 'normal', comment: '' }],
      ['addWellbeing', { state: 'bad', comment: 'Устала' }],
    ]) await records.write(tokenA, { operation, id: randomUUID(), ...values, recordedAt: '2026-10-27T12:00:00.000Z' });
    assert.equal((await records.read(tokenA)).pressure.length, 3);
    assert.equal((await records.read(tokenA)).wellbeing.length, 3);
    await records.write(tokenA, { operation: 'setBaby', week: 28, heartRate: '140', ultrasoundDate: '', ultrasoundWeek: '', position: '' });
    assert.equal((await records.read(tokenA)).baby['27'].heartRate, '150');
    assert.equal((await records.read(tokenA)).baby['28'].heartRate, '140');
    await records.write(tokenA, { operation: 'setArticleRead', id: 'pregnancy-082', read: false });
    await records.write(tokenA, { operation: 'setFavorite', id: 'back-practice', favorite: false });
    assert.deepEqual((await records.read(tokenA)).readArticles, []);
    assert.deepEqual((await records.read(tokenA)).favorites, []);
    const beforeBadImport = await records.read(tokenA);
    await assert.rejects(records.write(tokenA, { operation: 'import', confirmed: true,
      data: { weights: [{ value: 65, recordedAt: '2026-10-01T10:00:00.000Z' }], movements: [-1] } }), error => error.status === 400);
    assert.deepEqual(await records.read(tokenA), beforeBadImport);
    await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(tokenA)]);
    await assert.rejects(records.read(tokenA), error => error.status === 401);
    await assert.rejects(records.write(tokenA, { operation: 'setFavorite', id: 'back-practice', favorite: true }), error => error.status === 401);
    await assert.rejects(records.write(tokenB, { operation: 'addWeight', id: randomUUID(), value: -1, recordedAt: new Date().toISOString() }), error => error.status === 400);
    await assert.rejects(records.write(tokenB, { operation: 'addWeight', id: randomUUID(), value: 70, recordedAt: '2026-02-30T10:00:00.000Z' }), error => error.status === 400);
    await assert.rejects(records.write(tokenB, { operation: 'addWellbeing', id: randomUUID(), state: '', comment: 'text', recordedAt: new Date().toISOString() }), error => error.status === 400);
    await assert.rejects(records.write(tokenB, { operation: 'setFavorite', id: 'back-practice', favorite: true, userId: a }), error => error.status === 400);
    await pool.query('UPDATE auth_sessions SET expires_at=now()-interval \'1 minute\' WHERE token_hash=$1', [hashToken(tokenB)]);
    await assert.rejects(records.read(tokenB), error => error.status === 401);
  } finally { await close(); }
});

test('personal HTTP route enforces cookie ownership, same-origin writes and JSON bounds', async () => {
  const { pool, close } = await testPool();
  let server;
  try {
    await pool.query(await readFile(new URL('../auth/personal-data-migration.sql', import.meta.url), 'utf8'));
    const userId = randomUUID(), token = 'c'.repeat(43);
    await pool.query('INSERT INTO auth_users(id,email,getcourse_id) VALUES($1,$2,3)', [userId, 'c@example.com']);
    await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'1 day\')', [hashToken(token), userId]);
    server = createAuthServer({ enabled: true, origin: 'https://app.legkie-rody.ru',
      service: {}, store: { rateLimit: async () => {} }, personalData: createPersonalData(pool) });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/auth/personal`;
    const cookie = `__Host-school_session=${token}`;
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { method: 'POST', headers: { origin: 'https://app.legkie-rody.ru', 'Content-Type': 'application/json', 'X-Webpril-Account': userId },
      body: JSON.stringify({ operation: 'setArticleRead', id: 'pregnancy-082', read: true }) })).status, 401);
    const get = await fetch(base, { headers: { cookie } });
    assert.equal(get.status, 200);
    assert.equal((await get.clone().json()).accountId, userId);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    const body = JSON.stringify({ operation: 'setArticleRead', id: 'pregnancy-082', read: true });
    assert.equal((await fetch(base, { method: 'POST', headers: { cookie, origin: 'https://elsewhere.example', 'Content-Type': 'application/json', 'X-Webpril-Account': userId }, body })).status, 403);
    assert.equal((await fetch(base, { method: 'POST', headers: { cookie, origin: 'https://app.legkie-rody.ru', 'Content-Type': 'application/json' }, body })).status, 400);
    assert.equal((await fetch(base, { method: 'POST', headers: { cookie, origin: 'https://app.legkie-rody.ru', 'Content-Type': 'application/json', 'X-Webpril-Account': userId }, body })).status, 200);
    assert.deepEqual((await (await fetch(base, { headers: { cookie } })).json()).readArticles, ['pregnancy-082']);
    assert.equal((await fetch(base, { method: 'POST', headers: { cookie, origin: 'https://app.legkie-rody.ru', 'Content-Type': 'application/json', 'X-Webpril-Account': userId },
      body: JSON.stringify({ operation: 'setArticleRead', id: 'pregnancy-082', read: true, userId: randomUUID() }) })).status, 400);
    const otherId = randomUUID(), otherToken = 'd'.repeat(43);
    await pool.query('INSERT INTO auth_users(id,email,getcourse_id) VALUES($1,$2,4)', [otherId, 'd@example.com']);
    await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'1 day\')', [hashToken(otherToken), otherId]);
    assert.equal((await fetch(base, { method: 'POST', headers: { cookie: `__Host-school_session=${otherToken}`,
      origin: 'https://app.legkie-rody.ru', 'Content-Type': 'application/json', 'X-Webpril-Account': userId }, body })).status, 409);
    assert.deepEqual((await (await fetch(base, { headers: { cookie: `__Host-school_session=${otherToken}` } })).json()).readArticles, []);
    const oversized = JSON.stringify({ operation: 'import', confirmed: true, data: { movements: [], padding: 'x'.repeat(1_000_000) } });
    assert.equal((await fetch(base, { method: 'POST', headers: { cookie, origin: 'https://app.legkie-rody.ru', 'Content-Type': 'application/json', 'X-Webpril-Account': userId }, body: oversized })).status, 413);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await close(); }
});
