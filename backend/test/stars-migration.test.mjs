import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { testPool } from './auth-pool.mjs';
import { applyAuthMigrations } from '../auth/migrations.mjs';

test('full migration reruns preserve legacy and new ledger entries and the launch boundary', async t => {
  const db = await testPool(); t.after(() => db.close()); const { pool } = db;
  const old = randomUUID(), newer = randomUUID();
  await pool.query("INSERT INTO auth_users(id,email,getcourse_id,created_at) VALUES($1,$2,1,'2026-01-01')", [old, old+'@example.invalid']);
  await applyAuthMigrations(pool);
  const launch = (await pool.query('SELECT launched_at FROM auth_stars_launch')).rows[0].launched_at;
  await pool.query("INSERT INTO auth_points_ledger(user_id,article_id,occurred_at,moscow_day,amount) VALUES($1,'synthetic-old',now(),CURRENT_DATE,20)", [old]);
  await pool.query("INSERT INTO auth_points_ledger(user_id,event_code,event_ref,occurred_at,moscow_day,amount,capped) VALUES($1,'welcome','once',now(),CURRENT_DATE,100,false),($1,'ai_pack','purchase',now(),CURRENT_DATE,-50,false),($1,'article','zero',now(),CURRENT_DATE,0,true)", [old]);
  await pool.query("UPDATE auth_stars_wallet SET legacy=false,preserved_weeks=ARRAY[30] WHERE user_id=$1", [old]);
  await pool.query('INSERT INTO auth_users(id,email,getcourse_id,created_at) VALUES($1,$2,2,$3)', [newer, newer+'@example.invalid',new Date(+launch+1000)]);
  await applyAuthMigrations(pool); await applyAuthMigrations(pool);
  assert.deepEqual((await pool.query('SELECT count(*)::int AS n,sum(amount)::int AS balance FROM auth_points_ledger WHERE user_id=$1',[old])).rows[0], {n:4,balance:70});
  assert.equal(+(await pool.query('SELECT launched_at FROM auth_stars_launch')).rows[0].launched_at,+launch);
  assert.deepEqual((await pool.query('SELECT legacy,preserved_weeks FROM auth_stars_wallet WHERE user_id=$1',[old])).rows[0], {legacy:false,preserved_weeks:[30]});
  assert.equal((await pool.query('SELECT user_id FROM auth_stars_wallet WHERE user_id=$1 AND legacy=true',[newer])).rows.length,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM auth_stars_material_progress WHERE user_id=$1 AND kind='article' AND material_id='synthetic-old'",[old])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM gamification_settings')).rows[0].n,1);
});
