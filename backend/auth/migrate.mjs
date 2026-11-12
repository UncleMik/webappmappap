import pg from 'pg';
import { applyAuthMigrations } from './migrations.mjs';

let pool;
try {
  if (!process.env.AUTH_DATABASE_URL) throw new Error();
  new URL(process.env.AUTH_DATABASE_URL);
  pool = new pg.Pool({ connectionString: process.env.AUTH_DATABASE_URL, connectionTimeoutMillis: 3000 });
  await applyAuthMigrations(pool);
  console.log('Auth database migration complete');
} catch {
  console.error('auth_migration_failed_check_private_configuration'); process.exitCode = 1;
} finally { await pool?.end(); }
