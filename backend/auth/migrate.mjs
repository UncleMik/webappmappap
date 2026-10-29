import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { transaction } from './store.mjs';

let pool;
try {
  if (!process.env.AUTH_DATABASE_URL) throw new Error();
  new URL(process.env.AUTH_DATABASE_URL);
  pool = new pg.Pool({ connectionString: process.env.AUTH_DATABASE_URL, connectionTimeoutMillis: 3000 });
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const sessions = await readFile(new URL('./single-session-migration.sql', import.meta.url), 'utf8');
  const courses = await readFile(new URL('./course-checks-migration.sql', import.meta.url), 'utf8');
  const personal = await readFile(new URL('./personal-data-migration.sql', import.meta.url), 'utf8');
  const club = await readFile(new URL('./club-chat-migration.sql', import.meta.url), 'utf8');
  await transaction(pool, client => client.query(sql + '\n' + sessions + '\n' + courses + '\n' + personal + '\n' + club));
  console.log('Auth database migration complete');
} catch {
  console.error('auth_migration_failed_check_private_configuration'); process.exitCode = 1;
} finally { await pool?.end(); }
