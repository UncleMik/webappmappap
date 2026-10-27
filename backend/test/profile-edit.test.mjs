import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testPool } from './auth-pool.mjs';
import { createStore } from '../auth/store.mjs';
import { createAuthService } from '../auth/service.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { createProfilePhoto } from '../auth/profile-photo.mjs';
import { hashToken } from '../auth/security.mjs';

const origin = 'https://app.legkie-rody.ru';
const photo = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgoKC8oLzc3Nzc3N0E8QUNDQ0FBQUFDQ0NISEhVVVVISEhDQ0hIUFBVVVxfXFdXVVdfX2RkZHh4c3OMjJGsrM//xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Z';

test('profile edits and photo stay with session owner, survive reload, and respect stage confirmation', async () => {
  const { pool, close } = await testPool();
  const dir = await mkdtemp(join(tmpdir(), 'webpril-photo-test-'));
  const now = Date.parse('2026-10-27T12:00:00Z');
  const store = createStore(pool, { secret: 'profile-edit-test-secret-with-32-bytes', clock: () => now });
  const service = createAuthService({ store, sendMail: async () => {}, ensureGetCourse: async () => 1 });
  const profilePhoto = createProfilePhoto(pool, { directory: dir, clock: () => now });
  let server;
  try {
    const a = randomUUID(), b = randomUUID();
    const tokenA = 'a'.repeat(43), tokenB = 'b'.repeat(43);
    for (const [id, email, token, gc] of [[a, 'a@example.ru', tokenA, 1], [b, 'b@example.ru', tokenB, 2]]) {
      await pool.query('INSERT INTO auth_users(id,email,getcourse_id) VALUES($1,$2,$3)', [id, email, gc]);
      await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hashToken(token), id, new Date(now + 86_400_000)]);
    }
    const start = { name: 'Анна', stage: 'pregnancy', method: 'due', due: '2027-01-01', goals: [0] };
    await service.saveProfile(tokenA, start);
    await service.saveProfile(tokenB, { ...start, name: 'Бета' });
    server = createAuthServer({ enabled: true, origin, service, store, profilePhoto });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/auth`;
    const post = (path, body, token = tokenA, requestOrigin = origin) => fetch(`${base}/${path}`, {
      method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json', cookie: `__Host-school_session=${token}` },
      body: JSON.stringify(body),
    });
    const getPhoto = (token = tokenA, version = '') => fetch(`${base}/profile-photo${version ? `?v=${version}` : ''}`,
      { headers: { cookie: `__Host-school_session=${token}` } });
    assert.equal((await post('profile-edit', { accountId: b, changes: { name: 'Чужая' } })).status, 409);
    assert.equal((await post('profile-edit', { accountId: a, changes: { name: 'Новая' } }, tokenA, 'https://evil.test')).status, 403);
    assert.equal((await post('profile-edit', { accountId: a, changes: { stage: 'mother', birthDate: '2026-10-01', goals: [0] } })).status, 400);
    assert.equal((await post('profile-edit', { accountId: a, changes: { birthday: '2026-02-30' } })).status, 400);
    assert.equal((await post('profile-edit', { accountId: a, changes: { name: 'Чужая', email: 'changed@example.ru' } })).status, 400);
    assert.equal((await post('profile-edit', { accountId: a, changes: { name: 'Чужая' }, email: 'changed@example.ru' })).status, 400);
    const edit = await post('profile-edit', { accountId: a, changes: { name: 'Мария', surname: 'Петрова', city: 'Москва',
      birthday: '1992-02-29', phone: '+79991234567' } });
    assert.equal(edit.status, 200);
    assert.equal((await edit.json()).user.profile.surname, 'Петрова');
    const mother = await post('profile-edit', { accountId: a, confirmMother: true, changes: {
      stage: 'mother', birthDate: '2026-10-01', goals: [1, 4] } });
    assert.equal(mother.status, 200);
    const account = await (await fetch(`${base}/session`, { headers: { cookie: `__Host-school_session=${tokenA}` } })).json();
    assert.equal(account.user.profile.name, 'Мария');
    assert.equal(account.user.profile.stage, 'mother');
    assert.equal(account.user.profile.birthDate, '2026-10-01');
    assert.equal(account.user.profile.surname, 'Петрова');
    assert.equal((await store.session(tokenB)).profile.name, 'Бета');
    assert.equal((await post('profile', start)).status, 409);
    assert.equal((await getPhoto('')).status, 401);
    assert.equal((await post('profile-photo', { accountId: a, photo }, '')).status, 401);
    assert.equal((await getPhoto()).status, 404);
    assert.equal((await post('profile-photo', { accountId: b, photo })).status, 409);
    assert.equal((await post('profile-photo', { accountId: a, photo: Buffer.from('not a jpeg').toString('base64') })).status, 400);
    const bigJpeg = await readFile(new URL('./fixtures/profile-edit-noise.jpg', import.meta.url));
    assert.ok(bigJpeg.length > 100_000 && bigJpeg.length < 350 * 1024);
    const oversized = Buffer.from(bigJpeg);
    const frame = oversized.indexOf(Buffer.from([0xff, 0xc0]));
    assert.ok(frame > 0);
    oversized.writeUInt16BE(513, frame + 7);
    assert.equal((await post('profile-photo', { accountId: a, photo: oversized.toString('base64') })).status, 400);
    const uploaded = await post('profile-photo', { accountId: a, photo: bigJpeg.toString('base64') });
    assert.equal(uploaded.status, 200);
    const version = (await uploaded.json()).user.profile.photoVersion;
    assert.ok(version);
    assert.equal((await getPhoto(tokenB)).status, 404);
    assert.equal((await getPhoto(tokenA, version)).status, 200);
    assert.equal((await getPhoto(tokenA, randomUUID())).status, 404);
    assert.equal((await getPhoto(tokenA, version)).headers.get('cache-control'), 'private, no-store');
    assert.equal((await readdir(dir)).length, 1);
    await pool.query("UPDATE auth_users SET profile=jsonb_set(profile,'{dueDate}',to_jsonb('2025-01-01'::text)) WHERE id=$1", [b]);
    const expired = await post('profile-edit', { accountId: b, changes: { name: 'Елена' } }, tokenB);
    assert.equal(expired.status, 200);
    assert.equal((await expired.json()).user.profile.dueDate, '2025-01-01');
    const renamed = await post('profile-edit', { accountId: a, changes: { name: 'Надя' } });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).user.profile.photoVersion, version);
    assert.equal((await getPhoto(tokenA, version)).status, 200);
    const replaced = await post('profile-photo', { accountId: a, photo });
    assert.equal(replaced.status, 200);
    assert.notEqual((await replaced.json()).user.profile.photoVersion, version);
    assert.equal((await getPhoto(tokenA, version)).status, 404);
    assert.equal((await readdir(dir)).length, 1);
    const removed = await post('profile-photo', { accountId: a, photo: null });
    assert.equal(removed.status, 200);
    assert.equal((await getPhoto()).status, 404);
    assert.deepEqual(await readdir(dir), []);
    await pool.query('UPDATE auth_sessions SET revoked_at=$2 WHERE token_hash=$1', [hashToken(tokenA), new Date(now)]);
    assert.equal((await post('profile-edit', { accountId: a, changes: { name: 'Нельзя' } })).status, 401);
    assert.equal((await getPhoto()).status, 401);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});
