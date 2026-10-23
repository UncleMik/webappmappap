import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createAuthServer } from '../auth/http.mjs';
import { readConfig } from '../auth/config.mjs';
import { AuthError } from '../auth/security.mjs';

const origin = 'https://app.legkie-rody.ru';
const cookie = `__Host-school_session=${'a'.repeat(43)}`;
const user = { id: '11111111-1111-4111-8111-111111111111', profile: { completedAt: '2026-10-23T00:00:00.000Z' } };

async function withServer(options, check) {
  const server = createAuthServer({ origin, enabled: true, store: {}, courseChecks: {}, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, signed = true) => fetch(base + path, { headers: signed ? { cookie } : {} });
  try { await check(get); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('course database path defaults to project data and accepts a server override', () => {
  const env = { AUTH_DATABASE_URL: 'postgres://test@localhost/auth', AUTH_HMAC_SECRET: 'x'.repeat(32),
    UNISENDER_API_KEY: 'test', UNISENDER_TEMPLATE_ID: '11111111-1111-4111-8111-111111111111', GETCOURSE_IMPORT_KEY: 'test' };
  assert.equal(readConfig(env).courseDatabasePath, resolve(import.meta.dirname, '../../data/articles.sqlite'));
  assert.equal(readConfig({ ...env, COURSE_DATABASE_PATH: '/opt/wep_pril/data/articles.sqlite' }).courseDatabasePath,
    resolve('/opt/wep_pril/data/articles.sqlite'));
});

test('all course routes require a session and completed profile before materials are called', async () => {
  const calls = [];
  const courseMaterials = { list: () => calls.push('list'), course: () => calls.push('course'), lesson: () => calls.push('lesson') };
  await withServer({ service: { session: async () => null }, courseMaterials }, async get => {
    for (const path of ['/api/auth/courses', '/api/auth/courses/123', '/api/auth/courses/123/lessons/456']) {
      const response = await get(path);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  });
  await withServer({ service: { session: async () => ({ ...user, profile: null }) }, courseMaterials }, async get => {
    for (const path of ['/api/auth/courses', '/api/auth/courses/123', '/api/auth/courses/123/lessons/456']) {
      const response = await get(path);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'onboarding_required');
    }
  });
  assert.deepEqual(calls, []);
});

test('missing checks, missing materials and thrown implementation errors return safe 503', async () => {
  const service = { session: async () => user };
  for (const options of [
    { courseChecks: null, courseMaterials: { list: () => { throw new Error('must not call'); } } },
    { courseMaterials: null },
    { courseMaterials: { list: () => { throw new Error('private database path and content'); } } },
  ]) {
    await withServer({ service, ...options }, async get => {
      const response = await get('/api/auth/courses');
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.equal(body.error, 'course_materials_unavailable');
      assert.ok(!JSON.stringify(body).includes('private database'));
    });
  }
});

test('course routes delegate only the authenticated user ID and positive numeric IDs', async () => {
  const calls = [];
  const courseMaterials = {
    list: async (...args) => { calls.push(['list', ...args]); return { courses: [] }; },
    course: async (...args) => { calls.push(['course', ...args]); return { course: { productId: args[1] } }; },
    lesson: async (...args) => { calls.push(['lesson', ...args]); return { lesson: { lessonId: args[2] } }; },
  };
  await withServer({ service: { session: async token => token ? user : null }, courseMaterials }, async get => {
    const paths = ['/api/auth/courses', '/api/auth/courses/123', '/api/auth/courses/123/lessons/456'];
    for (const path of paths) {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.deepEqual(calls, [['list', user.id], ['course', user.id, 123], ['lesson', user.id, 123, 456]]);
    assert.equal((await get('/api/auth/courses', false)).status, 401);
    assert.equal((await get('/api/auth/courses?userId=other')).status, 400);
    assert.equal(calls.length, 3);
  });
});

test('malformed IDs never reach materials; foreign product and lesson IDs stay denied', async () => {
  const calls = [];
  const courseMaterials = {
    list: () => { throw new Error('unused'); },
    course: async (...args) => { calls.push(['course', ...args]); throw new AuthError(403, 'course_access_required', 'Нет доступа.'); },
    lesson: async (...args) => { calls.push(['lesson', ...args]); throw new AuthError(403, 'course_access_required', 'Нет доступа.'); },
  };
  await withServer({ service: { session: async () => user }, courseMaterials }, async get => {
    for (const path of ['/api/auth/courses/0', '/api/auth/courses/-1', '/api/auth/courses/abc',
      '/api/auth/courses/9007199254740992', '/api/auth/courses/123/lessons/0',
      '/api/auth/courses/123/lessons/abc', '/api/auth/courses/123/lessons/456/extra']) {
      const response = await get(path);
      assert.equal(response.status, 404, path);
    }
    assert.deepEqual(calls, []);
    for (const path of ['/api/auth/courses/999', '/api/auth/courses/123/lessons/999']) {
      const response = await get(path);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'course_access_required');
    }
    assert.deepEqual(calls, [['course', user.id, 999], ['lesson', user.id, 123, 999]]);
  });
});
