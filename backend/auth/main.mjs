import { readConfig, openPool } from './config.mjs';
import { createStore } from './store.mjs';
import { createAuthService } from './service.mjs';
import { createMailer, createGetCourse } from './providers.mjs';
import { createAuthServer } from './http.mjs';
import { createGetCourseTech } from '../getcourse-tech.mjs';
import { createCourseChecks } from './course-checks.mjs';

let pool;
async function start() {
const config = readConfig();
pool = openPool(config);
await pool.query('SELECT id FROM auth_users LIMIT 0'); // Migration must be applied first.
const store = createStore(pool, config);
const sendMail = createMailer(config.mail), getcourse = createGetCourse(config.getcourse);
const service = createAuthService({ store, sendMail, ensureGetCourse: async email => {
  await store.rateLimit('getcourse_global', 'all', config.gcPerMinute);
  return getcourse(email);
} });
const courseChecks = config.getcourseTech
  ? createCourseChecks({ pool, tech: createGetCourseTech(config.getcourseTech) }) : null;
const server = createAuthServer({ ...config, service, store, courseChecks, trustProxy: true });
let working = false, stopping = false, lastCleanup = 0;
const worker = setInterval(async () => {
  if (working || stopping || !config.enabled) return;
  working = true;
  try {
    await service.processJob();
    if (Date.now() - lastCleanup > 60 * 60_000) { await store.cleanup(); lastCleanup = Date.now(); }
  } catch { console.error('auth_worker_failed'); }
  finally { working = false; }
}, 1000);
server.listen(config.port, '127.0.0.1', () => console.log('School auth listening on localhost'));
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(worker);
  await new Promise(resolve => server.close(resolve));
  while (working) await new Promise(resolve => setTimeout(resolve, 50));
  await pool.end();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
start().catch(async () => {
  console.error('auth_start_failed_check_private_configuration');
  await pool?.end(); process.exitCode = 1;
});
