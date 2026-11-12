import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.mjs';
import { createStarsCatalog } from '../auth/stars-catalog.mjs';

test('week goals use published articles and actual video inventory, including week 25', async t => {
  const db = openDatabase(':memory:', false);
  t.after(() => db.close());
  const insert = db.prepare('INSERT INTO articles(id,number,week,title,minutes,blocks,status) VALUES(?,?,?,?,1,?,?)');
  for (let i=73;i<=75;i++) insert.run('pregnancy-'+i, i, 25, 'Урок '+i, '[]', 'published');
  insert.run('draft', 999, 25, 'Черновик', '[]', 'draft');
  const catalog = createStarsCatalog({ db, contentCatalog: { letters: [] } });
  assert.equal(catalog.materials().filter(row => row.week === 25).length, 5);
  assert.equal(catalog.materials().filter(row => row.kind === 'video').length, 125);
  assert.equal(catalog.materials().some(row => row.id === 'draft'), false);
  db.prepare("UPDATE articles SET status='draft' WHERE id='pregnancy-73'").run();
  assert.equal(catalog.materials().filter(row => row.week === 25).length, 4);
});

test('daily recommendations never carry inaccessible future catalogue entries', async t => {
  const db = openDatabase(':memory:', false);
  t.after(() => db.close());
  const catalog = createStarsCatalog({ db, contentCatalog: { letters: [] } });
  const client = { query: async sql => ({ rows: sql.includes('material_progress')
    ? [{kind:'video', material_id:'073'}] : [{week:26}] }) };
  const context = { userId:'fixture', currentWeek:25, legacy:false,
    settings:{enabled:true, features:{weekLocks:true}} };
  const daily = await catalog.daily(context, client);
  assert.ok(daily.materials.some(row => row.week === 26));
  assert.equal(daily.materials.some(row => row.week > 26), false);
  assert.equal(daily.materials.find(row => row.id === '073').completed, true);
  assert.equal(daily.materials.find(row => row.id === '074').completed, false);
  assert.ok(daily.materials.every(row => row.accessible === true));
});
