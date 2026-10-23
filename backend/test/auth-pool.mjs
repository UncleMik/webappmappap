import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

export async function testPool() {
  const schema = await readFile(new URL('../auth/schema.sql', import.meta.url), 'utf8') + '\n' +
    await readFile(new URL('../auth/single-session-migration.sql', import.meta.url), 'utf8');
  if (process.env.AUTH_TEST_DATABASE_URL) {
    const url = new URL(process.env.AUTH_TEST_DATABASE_URL);
    if (!url.pathname.endsWith('_test')) throw new Error('AUTH_TEST_DATABASE_URL must use a dedicated database ending in _test');
    const namespace = `test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: url.href });
    await admin.query(`CREATE SCHEMA ${namespace}`);
    const pool = new pg.Pool({ connectionString: url.href, options: `-c search_path=${namespace}` });
    await pool.query('BEGIN;\n' + schema + '\nCOMMIT;');
    return { pool, engine: 'PostgreSQL', async close() {
      await pool.end(); await admin.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.end();
    } };
  }
  // PostgreSQL compiled to WASM: useful for SQL/functional checks, not a pool/load benchmark.
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec('BEGIN;\n' + schema + '\nCOMMIT;');
  let tail = Promise.resolve();
  const pool = {
    async connect() {
      let unlock;
      const next = new Promise(resolve => { unlock = resolve; });
      const before = tail; tail = before.then(() => next); await before;
      return { query: (sql, args = []) => args.length ? db.query(sql, args) : db.exec(sql).then(rows => rows.at(-1)), release: unlock };
    },
    async query(sql, args) {
      const client = await this.connect();
      try { return await client.query(sql, args); } finally { client.release(); }
    },
  };
  return { pool, engine: 'PGlite (serialized)', close: () => db.close() };
}
