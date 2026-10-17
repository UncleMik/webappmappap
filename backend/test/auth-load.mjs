// Synthetic HTTP/session load against a dedicated real PostgreSQL database only.
// No messages, real GetCourse calls, production accounts or production databases.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { testPool } from './auth-pool.mjs';
import { createStore } from '../auth/store.mjs';
import { createAuthService } from '../auth/service.mjs';
import { createAuthServer } from '../auth/http.mjs';
import { randomToken, hashToken, COOKIE_NAME } from '../auth/security.mjs';

if (!process.env.AUTH_TEST_DATABASE_URL) throw new Error('Real dedicated AUTH_TEST_DATABASE_URL ending in _test required for load tests');
const users = 1000;
const seconds = Number(process.env.AUTH_LOAD_SECONDS || 60);
if (!Number.isInteger(seconds) || seconds < 30 || seconds > 900) throw new Error('AUTH_LOAD_SECONDS must be 30..900');
const database = await testPool();
const store = createStore(database.pool, { secret: randomToken() });
const service = createAuthService({ store, sendMail: async () => { throw new Error('Load test must not send mail'); }, ensureGetCourse: async () => { throw new Error('Load test must not call GetCourse'); } });
const server = createAuthServer({ service, store, origin: 'https://app.legkie-rody.ru', enabled: true });
const tokens = Array.from({ length: users }, randomToken), latencies = [];
let errors = 0, requests = 0;
try {
  for (let i = 0; i < users; i++) {
    const id = randomUUID();
    await database.pool.query('INSERT INTO auth_users(id,email,getcourse_id) VALUES($1,$2,$3)', [id, `load-${i}@example.test`, i + 1]);
    await database.pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hashToken(tokens[i]), id, new Date(Date.now() + 3_600_000)]);
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/auth/session`;
  const start = performance.now(), until = start + seconds * 1000;
  const progress = setInterval(() => console.log(JSON.stringify({ elapsedSeconds: Math.round((performance.now() - start) / 1000), requests, errors })), 10_000);
  await Promise.all(tokens.map(async (token, index) => {
    // Spread 1000 active clients over 30 seconds; each checks once per 30 seconds.
    await new Promise(resolve => setTimeout(resolve, index * 30));
    while (performance.now() < until) {
      const began = performance.now();
      try {
        const response = await fetch(url, { headers: { cookie: `${COOKIE_NAME}=${token}` }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok || !(await response.json()).authenticated) errors++;
      } catch { errors++; }
      requests++; latencies.push(performance.now() - began);
      if (performance.now() + 30_000 >= until) break;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 30_000 - (performance.now() - began))));
    }
  }));
  clearInterval(progress);
  latencies.sort((a, b) => a - b);
  console.log(JSON.stringify({ profile: '1000 authenticated clients, one session check per 30s', engine: database.engine,
    elapsedSeconds: Math.round((performance.now() - start) / 1000), requests, errors,
    p50ms: Math.round(latencies[Math.floor(latencies.length * .5)] || 0), p95ms: Math.round(latencies[Math.floor(latencies.length * .95)] || 0) }));
  if (errors) process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve)); await database.close();
}
