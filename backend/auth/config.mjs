import pg from 'pg';
import { resolve } from 'node:path';
import { isUuid, normalizeEmail } from './security.mjs';

export function readConfig(env = process.env) {
  const required = ['AUTH_DATABASE_URL', 'AUTH_HMAC_SECRET', 'UNISENDER_API_KEY', 'UNISENDER_TEMPLATE_ID', 'GETCOURSE_IMPORT_KEY'];
  for (const key of required) if (!env[key]) throw new Error(`Missing ${key}`);
  if (Buffer.byteLength(env.AUTH_HMAC_SECRET) < 32) throw new Error('AUTH_HMAC_SECRET must contain at least 32 bytes');
  const origin = new URL(env.AUTH_ORIGIN || 'https://app.legkie-rody.ru').origin;
  if (!origin.startsWith('https://')) throw new Error('AUTH_ORIGIN must use HTTPS');
  const adminOrigin = env.ADMIN_ORIGIN ? new URL(env.ADMIN_ORIGIN).origin : null;
  if (adminOrigin && (!adminOrigin.startsWith('https://') || adminOrigin === origin || !env.ADMIN_OWNER_EMAIL)) {
    throw new Error('Invalid admin origin or missing owner email');
  }
  let db;
  try { db = new URL(env.AUTH_DATABASE_URL); } catch { throw new Error('Invalid AUTH_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(db.hostname)) {
    throw new Error('Use PostgreSQL on localhost; remote database transport requires separate configuration');
  }
  if (!/^[a-f0-9-]{36}$/i.test(env.UNISENDER_TEMPLATE_ID)) throw new Error('Invalid UNISENDER_TEMPLATE_ID');
  const clubOwnerUserId = env.CLUB_OWNER_USER_ID || null;
  if (Boolean(env.LARA_WEB_URL) !== Boolean(env.LARA_WEB_SECRET)) throw new Error('Incomplete LARA_WEB configuration');
  if (env.LARA_WEB_SECRET && Buffer.byteLength(env.LARA_WEB_SECRET) < 32) throw new Error('Invalid LARA_WEB_SECRET');
  if (clubOwnerUserId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clubOwnerUserId)) {
    throw new Error('Invalid CLUB_OWNER_USER_ID');
  }
  const pilotIds = (env.AUTH_POINTS_PILOT_USER_IDS || '').split(',').map(id => id.trim().toLowerCase());
  const pointsPilotUserIds = pilotIds.every(isUuid) ? pilotIds : [];
  const gamificationEnabled = env.AUTH_GAMIFICATION_ENABLED === 'true';
  const pushFields = [env.GAMIFICATION_PUSH_PUBLIC_KEY, env.GAMIFICATION_PUSH_PRIVATE_KEY, env.GAMIFICATION_PUSH_SUBJECT];
  if (pushFields.some(Boolean) && !pushFields.every(Boolean)) throw new Error('Incomplete gamification push configuration');
  if (pushFields.every(Boolean) && (!/^[A-Za-z0-9_-]{87}$/.test(pushFields[0])
    || !/^[A-Za-z0-9_-]{43}$/.test(pushFields[1]) || !/^(mailto:|https:\/\/)/.test(pushFields[2]))) {
    throw new Error('Invalid gamification push configuration');
  }
  const positive = (name, fallback, maximum) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    origin, secret: env.AUTH_HMAC_SECRET, enabled: env.AUTH_ENABLED === 'true',
    mailPerMinute: positive('AUTH_MAILS_PER_MINUTE', 120, 1000),
    gcPerMinute: positive('AUTH_GETCOURSE_PER_MINUTE', 30, 120),
    poolSize: positive('AUTH_DB_POOL_SIZE', 10, 30),
    port: positive('AUTH_PORT', 3001, 65535),
    databaseUrl: env.AUTH_DATABASE_URL,
    clubOwnerUserId: clubOwnerUserId?.toLowerCase() || null,
    pointsPilotUserIds, pointsForAll: env.AUTH_POINTS_FOR_ALL === 'true',
    gamification: gamificationEnabled ? {
      courseDurationsPath: resolve(env.GAMIFICATION_COURSE_DURATIONS || '/etc/wep-pril-media/course-durations.json'),
      push: pushFields.every(Boolean) ? { publicKey: pushFields[0], privateKey: pushFields[1], subject: pushFields[2] } : null,
    } : null,
    admin: adminOrigin ? { origin: adminOrigin, ownerEmail: normalizeEmail(env.ADMIN_OWNER_EMAIL),
      frontend: resolve(env.ADMIN_FRONTEND_DIR || '/opt/wep_pril/admin-frontend'),
      uploads: resolve(env.ADMIN_ARTICLE_UPLOADS || '/opt/wep_pril/uploads/articles'),
      database: resolve(env.ADMIN_ARTICLES_PATH || '/opt/wep_pril/data/articles.sqlite'),
    } : null,
    laraWeb: env.LARA_WEB_URL ? { url: env.LARA_WEB_URL, secret: env.LARA_WEB_SECRET,
      sourceMapPath: resolve(env.LARA_WEB_SOURCE_MAP || resolve(import.meta.dirname, '../lara-source-map.json')) } : null,
    courseDatabasePath: resolve(env.COURSE_DATABASE_PATH || resolve(import.meta.dirname, '../../data/articles.sqlite')),
    mail: { key: env.UNISENDER_API_KEY, templateId: env.UNISENDER_TEMPLATE_ID,
      sender: 'auth@legkierody.ru', replyTo: env.AUTH_REPLY_TO || undefined,
      skipUnsubscribe: env.UNISENDER_TRANSACTIONAL_APPROVED === 'true' },
    getcourse: { origin: env.GETCOURSE_ORIGIN || 'https://legkierody.ru', key: env.GETCOURSE_IMPORT_KEY },
    getcourseTech: env.GETCOURSE_TECH_DEVELOPER_KEY && env.GETCOURSE_TECH_SCHOOL_KEY ? {
      developerKey: env.GETCOURSE_TECH_DEVELOPER_KEY, schoolKey: env.GETCOURSE_TECH_SCHOOL_KEY,
    } : null,
  };
}
export function openPool(config) {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.poolSize,
    connectionTimeoutMillis: 3000, idleTimeoutMillis: 30_000, statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10_000 });
  pool.on('error', () => console.error('auth_database_connection_failed'));
  return pool;
}
