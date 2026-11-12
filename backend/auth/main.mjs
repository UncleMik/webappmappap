import { readConfig, openPool } from './config.mjs';
import { createStore } from './store.mjs';
import { createAuthService } from './service.mjs';
import { createMailer, createGetCourse } from './providers.mjs';
import { createAuthServer } from './http.mjs';
import { createGetCourseTech } from '../getcourse-tech.mjs';
import { createCourseChecks } from './course-checks.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readArticle } from '../database.mjs';
import { createCourseMaterials } from '../course-materials.mjs';
import { createPersonalData } from './personal-data.mjs';
import { createProfilePhoto } from './profile-photo.mjs';
import { createClubChat } from './club-chat.mjs';
import { createAiChat } from './ai-chat.mjs';
import { createPoints } from './points.mjs';
import { createWeeklyPoll } from './weekly-poll.mjs';
import { createAdmin } from './admin.mjs';
import { openAdminArticles } from './admin-articles.mjs';
import { createAdminHttp } from './admin-http.mjs';
import { createStars } from './stars-core.mjs';
import { createStarsAi } from './stars-ai.mjs';
import { createStarsAccess } from './stars-access.mjs';
import { createStarsCatalog } from './stars-catalog.mjs';
import { createGamification } from './gamification.mjs';
import { loadGamificationCatalog } from './gamification-content.mjs';
import { createGamificationSettings } from './gamification-settings.mjs';
import { createGamificationAdmin } from './gamification-admin.mjs';
import { createGamificationNotifications, createGamificationPushTransport } from './gamification-notifications.mjs';

let pool, courseDb, adminArticles;
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
if (config.laraWeb) await pool.query('SELECT request_id,conversation_id FROM ai_chat_requests LIMIT 0');
const store = createStore(pool, config);
const sendMail = createMailer(config.mail), getcourse = createGetCourse(config.getcourse);
const service = createAuthService({ store, sendMail, ensureGetCourse: async email => {
  await store.rateLimit('getcourse_global', 'all', config.gcPerMinute);
  return getcourse(email);
} });
const courseChecks = config.getcourseTech
  ? createCourseChecks({ pool, tech: createGetCourseTech(config.getcourseTech) }) : null;
const pointsEnabled = config.pointsForAll || config.pointsPilotUserIds.length > 0;
let courseMaterials = null;
if (courseChecks || pointsEnabled || config.gamification) {
  try { courseDb = new DatabaseSync(config.courseDatabasePath, { readOnly: true }); }
  catch { console.error('auth_catalog_unavailable'); }
}
if (courseChecks && courseDb) {
  try { courseMaterials = createCourseMaterials({ db: courseDb, courseChecks }); }
  catch { console.error('course_materials_unavailable'); }
}
if (config.laraWeb) await pool.query('SELECT id,title,title_expires_at,legacy,updated_at FROM ai_chat_conversations LIMIT 0');
let stars, starsAi, starsAccess, gamification, gamificationSettings, gamificationNotifications;
if (config.gamification) {
  await pool.query('SELECT id FROM gamification_settings LIMIT 0');
  await pool.query('SELECT user_id FROM auth_stars_wallet LIMIT 0');
  await pool.query('SELECT user_id FROM auth_gamification_state LIMIT 0');
  gamificationSettings = createGamificationSettings({ pool });
  starsAi = createStarsAi({ pool, settings: gamificationSettings });
  const catalog = createStarsCatalog({ db: courseDb, starsAi,
    contentCatalog: loadGamificationCatalog({ pool, settings: gamificationSettings }),
    courseDurationsPath: config.gamification.courseDurationsPath });
  stars = createStars({ pool, service, courseMaterials, settings: gamificationSettings, catalog });
  starsAccess = createStarsAccess({ stars, pool, service, settings: gamificationSettings });
  const pushTransport = config.gamification.push
    ? await createGamificationPushTransport(config.gamification.push) : undefined;
  gamificationNotifications = createGamificationNotifications({ pool, service,
    settings: gamificationSettings, pushTransport, pushPublicKey: config.gamification.push?.publicKey });
  gamification = createGamification({ pool, service, stars, settings: gamificationSettings,
    catalog: catalog.daily, notifications: gamificationNotifications });
}
const aiChat = config.laraWeb && courseMaterials ? createAiChat({ pool, service, courseMaterials,
  starsAi, starsAccess, settings: gamificationSettings, ...config.laraWeb }) : null;
if (pointsEnabled) {
  await pool.query('SELECT article_id,video_id FROM auth_points_ledger LIMIT 0');
  await pool.query('SELECT attempt_id FROM auth_points_video_views LIMIT 0');
  await pool.query('SELECT attempt_id FROM auth_points_article_reads LIMIT 0');
}
const points = createPoints({ pool, userIds: config.pointsPilotUserIds, forAll: config.pointsForAll,
  stars, lookupArticle: id => courseDb && readArticle(courseDb, id) });
const weeklyPoll = createWeeklyPoll(pool, { stars, notifications: gamificationNotifications });
let admin, adminHttp;
if (config.admin) {
  try {
    await pool.query('SELECT user_id FROM admin_editors LIMIT 0');
    adminArticles = openAdminArticles(config.admin.database, config.admin.uploads);
    admin = createAdmin({ pool, articles: adminArticles, ownerEmail: config.admin.ownerEmail, appOrigin: config.origin, settings: gamificationSettings });
    const gamificationAdmin = gamificationSettings ? createGamificationAdmin({ pool, admin, settings: gamificationSettings }) : null;
    adminHttp = await createAdminHttp({ admin, service, store, gamificationAdmin, ...config.admin, mailPerMinute: config.mailPerMinute });
  } catch {
    console.error('admin_start_failed');
    adminArticles?.close(); adminArticles = null; admin = null;
  }
}
const server = createAuthServer({ ...config, service, store, courseChecks, courseMaterials, aiChat, points, weeklyPoll, admin, adminHttp,
  stars, starsAccess, gamification, gamificationNotifications,
  personalData: createPersonalData(pool), profilePhoto: createProfilePhoto(pool),
  clubChat: createClubChat({ pool, service, courseMaterials, store, points, ownerUserId: config.clubOwnerUserId }), trustProxy: true });
let working = false, stopping = false, lastCleanup = 0;
const worker = setInterval(async () => {
  if (working || stopping || !config.enabled) return;
  working = true;
  try {
    try { await weeklyPoll.settle(); } catch { console.error('weekly_poll_settlement_failed'); }
    try { await service.processJob(); } catch { console.error('auth_worker_failed'); }
    if (Date.now() - lastCleanup > 60 * 60_000) {
      lastCleanup = Date.now();
      try { await store.cleanup(); } catch { console.error('auth_cleanup_failed'); }
      try { await aiChat?.cleanup(); } catch { console.error('ai_cleanup_failed'); }
    }
  } finally { working = false; }
}, 1000);
// Push delivery must never hold up login emails or access synchronisation.
let notificationWorking = false, lastNotificationSchedule = 0;
const notificationWorker = setInterval(async () => {
  if (notificationWorking || stopping || !config.enabled || !config.gamification) return;
  notificationWorking = true;
  try {
    if (Date.now() - lastNotificationSchedule > 5 * 60_000) {
      let afterUserId = null;
      do {
        const batch = await gamification.scheduleNotifications({ limit: 100, afterUserId });
        afterUserId = batch.nextCursor;
      } while (afterUserId && !stopping);
      lastNotificationSchedule = Date.now();
    }
    if (!stopping) await gamificationNotifications.processQueue({ limit: 5 });
  } catch { console.error('gamification_notifications_failed'); }
  finally { notificationWorking = false; }
}, 60_000);
server.listen(config.port, '127.0.0.1', () => console.log('School auth listening on localhost'));
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(worker); clearInterval(notificationWorker);
  await new Promise(resolve => server.close(resolve));
  while (working || notificationWorking) await new Promise(resolve => setTimeout(resolve, 50));
  adminArticles?.close();
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
