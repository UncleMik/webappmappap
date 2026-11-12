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


test('released string lesson identifiers match numeric lesson requests and require current content hash', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'stars-durations-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const filename=join(directory,'durations.json'), current='a'.repeat(64);
  const rows=[{lessonId:'123',videoKey:'0:0',durationMs:120000,provider:'youtube',contentHash:current},
    {lessonId:123,videoKey:'0:1',durationMs:60000,provider:'rutube',contentHash:current},
    {lessonId:'123',videoKey:'0:2',durationMs:60000,provider:'rutube',contentHash:'b'.repeat(64)}];
  await writeFile(filename,JSON.stringify({version:1,rows}));
  const db = openDatabase(':memory:', false);t.after(()=>db.close());
  db.exec('CREATE TABLE course_lesson_drafts(lesson_id integer PRIMARY KEY,sha256 text)');
  db.prepare('INSERT INTO course_lesson_drafts VALUES(?,?)').run(123,current);
  const catalog=createStarsCatalog({db,courseDurationsPath:filename});
  assert.deepEqual(catalog.courseVideos(123).map(x=>x.key),['0:0','0:1']);
  assert.equal(catalog.courseVideos(124).length,0);
  db.prepare('UPDATE course_lesson_drafts SET sha256=? WHERE lesson_id=123').run('c'.repeat(64));
  assert.equal(catalog.courseVideos(123).length,0);
});
