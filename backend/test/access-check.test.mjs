import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAuthServer } from '../auth/http.mjs';

test('access check accepts only a server-confirmed session and fails closed', async () => {
  let valid = false, unavailable = false;
  const token = 'a'.repeat(43);
  const server = createAuthServer({ enabled: true, origin: 'https://app.legkie-rody.ru',
    service: { async session(value) {
      if (unavailable) throw new Error('private database failure');
      return valid && value === token ? { id: 'student', email: 'student@example.ru' } : null;
    } }, store: {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/auth/check`;
  try {
    const headers = { Cookie: `__Host-school_session=${token}` };
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers })).status, 401);
    valid = true;
    const allowed = await fetch(base, { headers });
    assert.equal(allowed.status, 204);
    assert.equal(await allowed.text(), '');
    assert.equal(allowed.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(base, { headers: { Cookie: '__Host-school_session=forged' } })).status, 401);
    valid = false; // Revoked or expired sessions must be rechecked on every request.
    assert.equal((await fetch(base, { headers })).status, 401);
    unavailable = true;
    const failed = await fetch(base, { headers });
    assert.equal(failed.status, 503);
    assert.ok(!(await failed.text()).includes('private database failure'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
