import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.mjs';
import { readArticles, readWeeklyContent } from '../database.mjs';
import { createArticleServer } from '../server.mjs';
import { importCourseDrafts } from '../course-drafts.mjs';

const capture = () => ({ schemaVersion: 1, families: [{ family: 'full', inventory: {
  lessons: [{ lessonId: 101, parentStreamId: 201, visibleStatus: 'Не показывается ученикам' }],
}, lessons: [{ lessonId: 101, parentStreamId: 201, title: 'Lesson', capturedAt: '2026-10-22T18:00:00Z',
  blocks: [{ blockId: 'block-1', order: 1, type: 'text', text: 'Exact\n  text\u00a0', html: '<p>Exact<br>  text&nbsp;</p>' }], extractionWarnings: [], emptyReason: null,
}] }] });
const trusted = { full: capture().families[0].inventory };

test('private lesson drafts retain exact source, remain unavailable, and preserve existing content', () => {
  const db = openDatabase(':memory:', false);
  try {
    db.exec("INSERT INTO articles(id,number,week,title,minutes,blocks) VALUES('pregnancy-001',1,1,'Existing',1,'[]')");
    const source = capture();
    assert.deepEqual(importCourseDrafts(db, source, trusted), { families: 1, lessons: 1, deliveryStatus: 'unavailable' });
    const first = db.prepare('SELECT * FROM course_lesson_drafts').get();
    assert.deepEqual(JSON.parse(first.content_json), source.families[0].lessons[0]);
    assert.equal(first.source_status_json, '"Не показывается ученикам"');
    assert.equal(first.delivery_status, 'unavailable');
    importCourseDrafts(db, source, trusted);
    assert.deepEqual(db.prepare('SELECT * FROM course_lesson_drafts').get(), first);
    assert.equal(readArticles(db).length, 1);
    assert.deepEqual(readWeeklyContent(db), { baby: {}, mom: {}, calendar: {}, calendarNotes: {} });
    assert.throws(() => db.exec("UPDATE course_lesson_drafts SET delivery_status='published'"), /CHECK/);
  } finally { db.close(); }
});

test('invalid, incomplete, signed, or unsafe captures cannot replace imported drafts', () => {
  const db = openDatabase(':memory:', false);
  try {
    importCourseDrafts(db, capture(), trusted);
    const before = db.prepare('SELECT * FROM course_lesson_drafts').all();
    const changes = [
      s => { s.families[0].lessons = []; },
      s => { s.families[0].lessons[0].parentStreamId = 999; },
      s => { s.families[0].lessons[0].blocks[0].html = '<img src="secret">'; },
      s => { s.families[0].lessons[0].blocks[0].iframe = 'secret'; },
      s => { s.families[0].lessons[0].blocks[0].text = 'https://player.example/sign-player?token=secret'; },
      s => { s.families[0].lessons[0].status = 'failed'; },
      s => { s.families[0].lessons[0].studentEmail = 'person@example.org'; },
      s => { s.families[0].lessons[0].blocks[0].studentName = 'Example'; },
      s => { s.families[0].inventory.lessons[0].title = 'changed inventory'; },
      s => { s.families[0].lessons[0].extractionWarnings = [{ studentEmail: 'person@example.org' }]; },
      s => { Object.assign(s.families[0].lessons[0].blocks[0], { videos: [], video: { studentName: 'Example' } }); },
      s => { s.families[0].lessons[0].sourceTitle = { studentName: 'Example' }; },
    ];
    for (const change of changes) {
      const source = capture(); change(source);
      assert.throws(() => importCourseDrafts(db, source, trusted));
      assert.deepEqual(db.prepare('SELECT * FROM course_lesson_drafts').all(), before);
    }
    db.exec("CREATE TRIGGER fail_draft BEFORE INSERT ON course_lesson_drafts BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    assert.throws(() => importCourseDrafts(db, capture(), trusted), /simulated failure/);
    assert.deepEqual(db.prepare('SELECT * FROM course_lesson_drafts').all(), before);
  } finally { db.close(); }
});

test('existing content API does not serve private drafts through guessed lesson routes', async () => {
  const db = openDatabase(':memory:', false);
  importCourseDrafts(db, capture(), trusted);
  const server = createArticleServer(db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/api/course-lessons', '/api/course-lessons/101', '/api/course-drafts/101', '/api/articles/101']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /Exact|Не показывается ученикам/);
    }
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});

test('equally truncated captures and inventory cannot replace a complete trusted family', () => {
  const db = openDatabase(':memory:', false);
  try {
    const source = capture();
    source.families[0].inventory.lessons.push({ lessonId: 102, parentStreamId: 201, visibleStatus: 'unknown' });
    source.families[0].lessons.push({ ...structuredClone(source.families[0].lessons[0]), lessonId: 102 });
    const trustedTwo = { full: structuredClone(source.families[0].inventory) };
    importCourseDrafts(db, source, trustedTwo);
    const before = db.prepare('SELECT * FROM course_lesson_drafts ORDER BY lesson_id').all();
    source.families[0].inventory.lessons.pop();
    source.families[0].lessons.pop();
    assert.throws(() => importCourseDrafts(db, source, trustedTwo), /trusted source/);
    assert.deepEqual(db.prepare('SELECT * FROM course_lesson_drafts ORDER BY lesson_id').all(), before);
  } finally { db.close(); }
});
