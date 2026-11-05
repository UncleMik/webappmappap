import { readConfig, openPool } from './config.mjs';
import { createStore } from './store.mjs';
import { createAuthService } from './service.mjs';
import { createMailer, createGetCourse } from './providers.mjs';
import { createAuthServer } from './http.mjs';
import { createGetCourseTech } from '../getcourse-tech.mjs';
import { createCourseChecks } from './course-checks.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createCourseMaterials } from '../course-materials.mjs';
import { createPersonalData } from './personal-data.mjs';
import { createProfilePhoto } from './profile-photo.mjs';
import { createClubChat } from './club-chat.mjs';
import { createAiChat } from './ai-chat.mjs';

let pool, courseDb;
function closeCourseDb() {
  try { courseDb?.close(); } catch { console.error('course_materials_close_failed'); }
  courseDb = null;
}
async function start() {
const config = readConfig();
pool = openPool(config);
await pool.query('SELECT id FROM auth_users LIMIT 0'); // Migration must be applied first.
await pool.query('SELECT user_id FROM auth_personal_records LIMIT 0');
await pool.query('SELECT message_id FROM club_message_reactions LIMIT 0');
if (config.laraWeb) await pool.query('SELECT request_id FROM ai_chat_requests LIMIT 0');
const store = createStore(pool, config);
const sendMail = createMailer(config.mail), getcourse = createGetCourse(config.getcourse);
const service = createAuthService({ store, sendMail, ensureGetCourse: async email => {
  await store.rateLimit('getcourse_global', 'all', config.gcPerMinute);
  return getcourse(email);
} });
const courseChecks = config.getcourseTech
  ? createCourseChecks({ pool, tech: createGetCourseTech(config.getcourseTech) }) : null;
let courseMaterials = null;
if (courseChecks) {
  try {
    courseDb = new DatabaseSync(config.courseDatabasePath, { readOnly: true });
    courseMaterials = createCourseMaterials({ db: courseDb, courseChecks });
  } catch {
    console.error('course_materials_unavailable');
    closeCourseDb();
  }
}
const aiChat = config.laraWeb && courseMaterials ? createAiChat({ pool, service, courseMaterials, ...config.laraWeb }) : null;
const server = createAuthServer({ ...config, service, store, courseChecks, courseMaterials, aiChat,
  personalData: createPersonalData(pool), profilePhoto: createProfilePhoto(pool),
  clubChat: createClubChat({ pool, service, courseMaterials, store, ownerUserId: config.clubOwnerUserId }), trustProxy: true });
let working = false, stopping = false, lastCleanup = 0;
const worker = setInterval(async () => {
  if (working || stopping || !config.enabled) return;
  working = true;
  try {
    try { await service.processJob(); } catch { console.error('auth_worker_failed'); }
    if (Date.now() - lastCleanup > 60 * 60_000) {
      lastCleanup = Date.now();
      try { await store.cleanup(); } catch { console.error('auth_cleanup_failed'); }
      try { await aiChat?.cleanup(); } catch { console.error('ai_cleanup_failed'); }
    }
  } finally { working = false; }
}, 1000);
server.listen(config.port, '127.0.0.1', () => console.log('School auth listening on localhost'));
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(worker);
  await new Promise(resolve => server.close(resolve));
  while (working) await new Promise(resolve => setTimeout(resolve, 50));
  closeCourseDb();
  await pool.end();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
start().catch(async () => {
  console.error('auth_start_failed_check_private_configuration');
  closeCourseDb();
  await pool?.end(); process.exitCode = 1;
});
