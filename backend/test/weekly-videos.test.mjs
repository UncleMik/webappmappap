import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAuthServer } from '../auth/http.mjs';
import { COOKIE_NAME } from '../auth/security.mjs';

test('weekly video source requires a current session, but no purchase', async () => {
  let loggedIn = true, completed = true;
  const token = 'a'.repeat(43);
  const service = { session: async value => loggedIn && value === token ? { id: 'free-user', profile: completed ? {completedAt:'2026-10-19T00:00:00Z'} : null } : null };
  const server = createAuthServer({ service, origin: 'https://app.legkie-rody.ru', enabled: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/auth/videos/`;
  try {
    const anonymous = await fetch(url + 'contractions-lesson');
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.text()).includes('getcourse.ru'), false);
    for (const id of ['contractions-lesson', 'back-relief-video', 'birth-breathing-video']) {
      const result = await fetch(url + id, { headers: { cookie: `${COOKIE_NAME}=${token}` } });
      assert.equal(result.status, 200);
      assert.match((await result.json()).source, /^https:\/\/fs\.getcourse\.ru\/fileservice\/file\/download\//);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
    completed = false;
    const incomplete = await fetch(url + 'contractions-lesson', { headers: { cookie: `${COOKIE_NAME}=${token}` } });
    assert.equal(incomplete.status, 403);
    assert.equal((await incomplete.json()).error, 'onboarding_required');
    completed = true;
    loggedIn = false;
    assert.equal((await fetch(url + 'contractions-lesson', { headers: { cookie: `${COOKIE_NAME}=${token}` } })).status, 401);
    loggedIn = true;
    assert.equal((await fetch(url + 'unknown', { headers: { cookie: `${COOKIE_NAME}=${token}` } })).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
