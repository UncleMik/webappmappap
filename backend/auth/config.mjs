import pg from 'pg';

export function readConfig(env = process.env) {
  const required = ['AUTH_DATABASE_URL', 'AUTH_HMAC_SECRET', 'UNISENDER_API_KEY', 'UNISENDER_TEMPLATE_ID', 'GETCOURSE_IMPORT_KEY'];
  for (const key of required) if (!env[key]) throw new Error(`Missing ${key}`);
  if (Buffer.byteLength(env.AUTH_HMAC_SECRET) < 32) throw new Error('AUTH_HMAC_SECRET must contain at least 32 bytes');
  const origin = new URL(env.AUTH_ORIGIN || 'https://app.legkie-rody.ru').origin;
  if (!origin.startsWith('https://')) throw new Error('AUTH_ORIGIN must use HTTPS');
  let db;
  try { db = new URL(env.AUTH_DATABASE_URL); } catch { throw new Error('Invalid AUTH_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(db.hostname)) {
    throw new Error('Use PostgreSQL on localhost; remote database transport requires separate configuration');
  }
  if (!/^[a-f0-9-]{36}$/i.test(env.UNISENDER_TEMPLATE_ID)) throw new Error('Invalid UNISENDER_TEMPLATE_ID');
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
