import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createCourseMaterials, importCourseDeliveryPolicy } from '../course-materials.mjs';
import { importCourseVideoLinks } from '../course-video-links.mjs';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const iso = value => new Date(value).toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const purchase = (productId, id = productId) => ({ id, product_id: productId, user_id: 42,
  is_actual: 1, is_payed: 0, state: null, period_type: 'limited',
  start_at: '2025-01-01 00:00:00', finish_at: '2027-01-01 00:00:00' });

function fixture({ purchases = [purchase(10)], trainingIds = [100, 101, 102],
  lessonStates = [], policyChange = () => {}, now = NOW, snapshotVersion = 2 } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE course_products(product_id INTEGER,title TEXT,type TEXT);
    CREATE TABLE course_program_drafts(family TEXT,inventory_json TEXT,sha256 TEXT);
    CREATE TABLE course_lesson_drafts(lesson_id INTEGER,parent_stream_id INTEGER,title TEXT,content_json TEXT,sha256 TEXT);
    CREATE TABLE course_delivery_policy(singleton INTEGER PRIMARY KEY,body_json TEXT,sha256 TEXT)`);
  for (const [id, title, type] of [[10, 'Main', 'training'], [20, 'Separate bonus', 'training'], [30, 'Meetings', 'group']])
    db.prepare('INSERT INTO course_products VALUES(?,?,?)').run(id, title, type);
  const streams = {
    100: { id: 100, title: 'Main', parents: [], order: 0 },
    101: { id: 101, title: 'Inherited chapter', parents: [{ streamId: 100, order: 1 }], order: 1 },
    102: { id: 102, title: 'Separately purchased bonus', parents: [{ streamId: 100, order: 2 }], order: 2 },
  };
  const lessons = [
    [1001, 100, 1], [1002, 100, 2], [1003, 100, 3], [1004, 100, 4],
    [1005, 100, 5], [1006, 100, 6], [1011, 101, 1], [1021, 102, 1],
  ].map(([id, parentId, order]) => ({ id, parentId, order }));
  const inventory = JSON.stringify({ streams, roots: [{ productId: 10, trainingId: 100 },
    { productId: 20, trainingId: 102 }], lessons });
  db.prepare('INSERT INTO course_program_drafts VALUES(?,?,?)').run('express', inventory, hash(inventory));
  for (const lesson of lessons) {
    const content = JSON.stringify({ blocks: lesson.id === 1001 ? [
      { blockId: 'text-main', type: 'text', text: 'Exact school text https://school.example/info', richHtml: '<p>Exact school text https://school.example/info</p>' },
      { blockId: 'video-main', type: 'video', text: 'Video label', videos: [
        { provider: 'getcourse', getcourseFileId: 8765, signedUrl: 'secret' },
        { provider: 'youtube', videoId: 'SafeId_2' },
        { provider: 'rutube', videoId: 'safe-id-3' },
      ] },
      { blockId: 'attachment-main', type: 'attachment', text: 'File label', signedUrl: 'secret' },
      { blockId: 'image-main', type: 'image', text: 'Image label', src: 'secret' },
    ] : [{ blockId: 'text-main', type: 'text', text: `Lesson ${lesson.id}` }] });
    db.prepare('INSERT INTO course_lesson_drafts VALUES(?,?,?,?,?)').run(lesson.id, lesson.parentId, `Lesson ${lesson.id}`, content, hash(content));
  }
  const policy = { schemaVersion: 1,
    streams: Object.values(streams).map(s => ({ streamId: s.id, accessType: s.id === 102 ? 'none' : s.id === 101 ? 'parent' : 'none',
      noAccessMode: 'not_show', scheduleType: '0', hideUnavailable: true, disableCopy: false,
      disableCopyCurrent: false, reverseLessons: false })),
    lessons: lessons.map(l => ({ lessonId: l.id, visibility: '1', startAt: '', hidden: false,
      disableCopy: false, hasMission: false, stop: false, alwaysAvailable: false,
      delayed: false, stopType: 'self' })),
  };
  policyChange(policy);
  importCourseDeliveryPolicy(db, policy);
  const check = { checkedAt: iso(now - 1000), expiresAt: iso(now + 299000),
    snapshot: { version: snapshotVersion, purchases, trainingIds, lessonStates } };
  let current = now;
  const courseChecks = { requireCurrent: async () => check };
  const make = () => createCourseMaterials({ db, courseChecks, clock: () => current });
  return { db, check, policy, make, advance: value => { current = value; }, close: () => db.close() };
}

async function denied(promise, status = 403) {
  await assert.rejects(promise, error => error.status === status);
}

test('grants require the exact active old product, not a tariff, group, or parent link', async () => {
  const f = fixture();
  try {
    const service = f.make();
    assert.deepEqual((await service.list(42)).courses.map(c => c.productId), [10]);
    assert.equal((await service.lesson(42, 10, 1011)).lesson.lessonId, 1011);
    await denied(service.lesson(42, 10, 1021));
    await denied(service.lesson(42, 20, 1021));
    await denied(service.course(42, 30));
    await denied(service.course(42, 999));
    f.check.snapshot.purchases.push(purchase(20));
    assert.equal((await service.lesson(42, 20, 1021)).lesson.lessonId, 1021);
    assert.equal((await service.lesson(42, 10, 1021)).lesson.lessonId, 1021);
  } finally { f.close(); }
});

test('source text remains exact while media IDs, URLs and secret fields are stripped', async () => {
  const f = fixture();
  try {
    const result = await f.make().lesson(42, 10, 1001);
    assert.deepEqual(result.lesson.blocks, [
      { type: 'text', text: 'Exact school text https://school.example/info', html: '<p>Exact school text https://school.example/info</p>' },
      { type: 'video', text: 'Video label', videos: [
        { provider: 'getcourse', url: null }, { provider: 'youtube', url: null },
        { provider: 'rutube', url: null },
      ] }, { type: 'attachment', text: 'File label' },
      { type: 'image', text: 'Image label' },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /8765|signedUrl|secret|src|SafeId_2/);
    assert.equal(result.lesson.videoAvailable, false);
  } finally { f.close(); }
});

test('hidden lessons remain closed even when always available; stop affects same stream only', async () => {
  const f = fixture({ policyChange: policy => {
    policy.lessons.find(l => l.lessonId === 1001).hasMission = true;
    policy.lessons.find(l => l.lessonId === 1001).stop = true;
    policy.lessons.find(l => l.lessonId === 1003).alwaysAvailable = true;
    policy.lessons.find(l => l.lessonId === 1004).hidden = true;
    policy.lessons.find(l => l.lessonId === 1004).alwaysAvailable = true;
  } });
  try {
    const service = f.make();
    await denied(service.lesson(42, 10, 1002));
    assert.equal((await service.lesson(42, 10, 1003)).lesson.lessonId, 1003);
    await denied(service.lesson(42, 10, 1004));
    assert.equal((await service.lesson(42, 10, 1011)).lesson.lessonId, 1011);
    f.check.snapshot.lessonStates = [{ lessonId: 1001, status: 'accepted', updatedAt: '2026-10-23 14:00:00' }];
    assert.equal((await service.lesson(42, 10, 1002)).lesson.lessonId, 1002);
    f.check.snapshot.lessonStates.push({ lessonId: 1001, status: 'declined', updatedAt: '2026-10-23 14:30:00' });
    await denied(service.lesson(42, 10, 1002));
  } finally { f.close(); }
});

test('schedule visibility 1, 2, 3; empty, current and future starts; individual schedule fails closed', async () => {
  const f = fixture({ policyChange: policy => {
    policy.lessons.find(l => l.lessonId === 1001).visibility = '1';
    policy.lessons.find(l => l.lessonId === 1001).startAt = '2030-01-01 00:00:00';
    policy.lessons.find(l => l.lessonId === 1002).visibility = '2';
    policy.lessons.find(l => l.lessonId === 1003).visibility = '3';
    policy.lessons.find(l => l.lessonId === 1003).startAt = '2026-10-23 15:00:00';
    policy.lessons.find(l => l.lessonId === 1004).visibility = '2';
    policy.lessons.find(l => l.lessonId === 1004).startAt = '2030-01-01 00:00:00';
    policy.streams.find(s => s.streamId === 101).scheduleType = '1';
    policy.lessons.find(l => l.lessonId === 1011).visibility = '2';
  } });
  try {
    const service = f.make();
    for (const id of [1001, 1002, 1003]) assert.equal((await service.lesson(42, 10, id)).lesson.lessonId, id);
    await denied(service.lesson(42, 10, 1004));
    await denied(service.lesson(42, 10, 1011));
  } finally { f.close(); }
});

test('old snapshot, absent training, stale cache, and finished purchase fail closed', async () => {
  for (const options of [
    { snapshotVersion: 1 }, { trainingIds: [] },
    { purchases: [{ ...purchase(10), finish_at: '2026-10-23 15:00:00' }] },
  ]) {
    const f = fixture(options);
    try {
      if (options.snapshotVersion === 1) await denied(f.make().lesson(42, 10, 1001), 503);
      else await denied(f.make().lesson(42, 10, 1001));
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    const service = f.make();
    f.advance(NOW + 299000);
    await denied(service.lesson(42, 10, 1001), 503);
  } finally { f.close(); }
});

test('inventory, policy and lesson hashes fail closed', async () => {
  for (const table of ['course_program_drafts', 'course_delivery_policy']) {
    const f = fixture();
    try {
      f.db.exec(`UPDATE ${table} SET sha256='bad'`);
      assert.throws(() => f.make(), error => error.status === 503);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    const service = f.make();
    f.db.exec("UPDATE course_lesson_drafts SET sha256='bad' WHERE lesson_id=1001");
    await denied(service.lesson(42, 10, 1001), 503);
  } finally { f.close(); }
});

test('lesson response must not be returned after verification expires during request', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const service = createCourseMaterials({ db: f.db,
      courseChecks: { requireCurrent: async () => f.check },
      clock: () => ++reads === 1 ? NOW : NOW + 299000 });
    await denied(service.lesson(42, 10, 1001), 503);
  } finally { f.close(); }
});

test('old purchase expiry, not offer duration, caps access and response metadata', async () => {
  const f = fixture({ purchases: [{ ...purchase(10), finish_at: '2026-10-23 15:00:02' }] });
  try {
    const service = f.make();
    const result = await service.lesson(42, 10, 1001);
    assert.equal(result.validUntil, iso(NOW + 2000));
    assert.doesNotMatch(JSON.stringify(result), /user_id|is_payed|start_at|finish_at|lessonStates|trainingIds/);
    f.advance(NOW + 2000);
    await denied(service.lesson(42, 10, 1001));
  } finally { f.close(); }
});

test('lesson reached through parent expires with separately purchased child product', async () => {
  const f = fixture({ purchases: [purchase(10), { ...purchase(20), finish_at: '2026-10-23 15:00:02' }] });
  try {
    const service = f.make();
    const result = await service.lesson(42, 10, 1021);
    assert.equal(result.validUntil, iso(NOW + 2000));
    f.advance(NOW + 2000);
    await denied(service.lesson(42, 10, 1021));
    assert.equal((await service.lesson(42, 10, 1011)).lesson.lessonId, 1011);
  } finally { f.close(); }
});

test('course containing a separately purchased child expires before its child listing can stale', async () => {
  const f = fixture({ purchases: [purchase(10), { ...purchase(20), finish_at: '2026-10-23 15:00:02' }] });
  try {
    const service = f.make();
    const result = await service.course(42, 10);
    assert.ok(result.course.sections.some(s => s.lessons.some(l => l.lessonId === 1021)));
    assert.equal(result.validUntil, iso(NOW + 2000));
    f.advance(NOW + 2000);
    const later = await service.course(42, 10);
    assert.ok(later.course.sections.every(s => s.lessons.every(l => l.lessonId !== 1021)));
  } finally { f.close(); }
});

test('unrecognized inherited access and future or missing stop statuses stay closed', async () => {
  const f = fixture({ policyChange: policy => {
    policy.streams.find(s => s.streamId === 101).accessType = 'parent_with_groups';
    policy.lessons.find(l => l.lessonId === 1001).hasMission = true;
    policy.lessons.find(l => l.lessonId === 1001).stop = true;
  } });
  try {
    const service = f.make();
    await denied(service.lesson(42, 10, 1011));
    f.check.snapshot.lessonStates = [{ lessonId: 1001, status: 'accepted', updatedAt: null }];
    await denied(service.lesson(42, 10, 1002));
    f.check.snapshot.lessonStates = [{ lessonId: 1001, status: 'accepted', updatedAt: '2030-01-01 00:00:00' }];
    await denied(service.lesson(42, 10, 1002));
  } finally { f.close(); }
});

test('incomplete v2 evidence is unavailable and cannot grant a lesson', async () => {
  for (const key of ['purchases', 'trainingIds', 'lessonStates']) {
    const f = fixture();
    try {
      delete f.check.snapshot[key];
      await denied(f.make().lesson(42, 10, 1001), 503);
    } finally { f.close(); }
  }
});

const gcUrl = `https://fs.getcourse.ru/fileservice/file/download/a/25918/sc/123/h/${'a'.repeat(32)}.mp4`;
const videoRows = [
  { lessonId: 1001, blockId: 'video-main', videoIndex: 0, provider: 'getcourse', getcourseFileId: 8765, url: gcUrl },
  { lessonId: 1001, blockId: 'video-main', videoIndex: 1, provider: 'youtube', url: 'https://www.youtube.com/embed/SafeId_2' },
  { lessonId: 1001, blockId: 'video-main', videoIndex: 2, provider: 'rutube', url: 'https://rutube.ru/play/embed/safe-id-3' },
];

test('Rutube original access keys survive protected delivery and remain bound to the video', async () => {
  const f = fixture();
  try {
    for (const suffix of ['/?p=SchoolKey_123-test', '?p=SchoolKey_123-test', '/']) {
      const row = { ...videoRows[2], url: videoRows[2].url + suffix };
      importCourseVideoLinks(f.db, { schemaVersion: 1, rows: [row] });
      assert.equal((await f.make().lesson(42, 10, 1001)).lesson.blocks[1].videos[2].url, row.url);
      assert.doesNotMatch(JSON.stringify(await f.make().list(42)), /SchoolKey/);
      await denied(f.make().lesson(42, 20, 1001));
    }
    const before = f.db.prepare('SELECT body_json,sha256 FROM course_video_links').get();
    for (const url of [
      'https://rutube.ru/play/embed/other-id/?p=SchoolKey',
      videoRows[2].url + '/?p=', videoRows[2].url + '/?p=key&x=1',
      videoRows[2].url + '/?p=key&p=other', videoRows[2].url + '/?p=key#fragment',
      videoRows[2].url + '/?p=key%26x', videoRows[2].url.replace('rutube.ru', 'rutube.ru.evil.test'),
    ]) assert.throws(() => importCourseVideoLinks(f.db, { schemaVersion: 1, rows: [{ ...videoRows[2], url }] }));
    assert.deepEqual(f.db.prepare('SELECT body_json,sha256 FROM course_video_links').get(), before);
    f.check.snapshot.purchases = [];
    await denied(f.make().lesson(42, 10, 1001));
  } finally { f.close(); }
});

test('private video registry preserves order, partial links, and exact access gates', async () => {
  const f = fixture();
  try {
    assert.deepEqual(importCourseVideoLinks(f.db, { schemaVersion: 1, rows: [videoRows[1], videoRows[0]] }), { links: 2 });
    const service = f.make();
    const result = await service.lesson(42, 10, 1001);
    assert.deepEqual(result.lesson.blocks[1].videos, [
      { provider: 'getcourse', url: gcUrl },
      { provider: 'youtube', url: videoRows[1].url },
      { provider: 'rutube', url: null },
    ]);
    assert.equal(result.lesson.videoAvailable, true);
    assert.doesNotMatch(JSON.stringify(await service.list(42)), /fs\.getcourse|youtube\.com|rutube\.ru/);
    assert.doesNotMatch(JSON.stringify(await service.course(42, 10)), /fs\.getcourse|youtube\.com|rutube\.ru/);
    await denied(service.lesson(42, 20, 1001));
    await denied(service.lesson(42, 10, 9999));
    f.check.snapshot.purchases = [];
    await denied(service.lesson(42, 10, 1001));
    f.check.snapshot.purchases = [purchase(10)];
    f.advance(NOW + 299000);
    await denied(service.lesson(42, 10, 1001), 503);
  } finally { f.close(); }
});

test('video registry import is idempotent, incomplete allowed, invalid changes roll back', async () => {
  const f = fixture();
  try {
    const source = { schemaVersion: 1, rows: videoRows };
    assert.equal(importCourseVideoLinks(f.db, source).links, 3);
    assert.equal(importCourseVideoLinks(f.db, source).links, 3);
    const before = f.db.prepare('SELECT body_json,sha256 FROM course_video_links').get();
    const invalid = [
      [...videoRows, videoRows[0]],
      [{ ...videoRows[0], blockId: 'unknown' }],
      [{ ...videoRows[0], getcourseFileId: 999 }],
      [{ ...videoRows[0], url: gcUrl + '?token=secret' }],
      [{ ...videoRows[0], url: gcUrl.replace('fs.getcourse.ru', 'evil.example') }],
      [{ ...videoRows[1], url: 'https://www.youtube.com/embed/OtherId' }],
      [{ ...videoRows[2], url: 'https://rutube.ru/play/embed/safe-id-3?x=1' }],
      [{ ...videoRows[0], lessonId: 9999 }],
    ];
    for (const rows of invalid) assert.throws(() => importCourseVideoLinks(f.db, { schemaVersion: 1, rows }));
    assert.deepEqual(f.db.prepare('SELECT body_json,sha256 FROM course_video_links').get(), before);
    assert.equal((await f.make().lesson(42, 10, 1001)).lesson.blocks[1].videos[0].url, gcUrl);
    importCourseVideoLinks(f.db, { schemaVersion: 1, rows: [videoRows[0]] });
    assert.deepEqual((await f.make().lesson(42, 10, 1001)).lesson.blocks[1].videos.map(v => v.url), [gcUrl, null, null]);
  } finally { f.close(); }
});

test('GetCourse sc/0 is valid but leading-zero sc values and unknown blocks are rejected', async () => {
  const f = fixture();
  try {
    const zero = { ...videoRows[0], url: gcUrl.replace('/sc/123/', '/sc/0/') };
    assert.deepEqual(importCourseVideoLinks(f.db, { schemaVersion: 1, rows: [zero] }), { links: 1 });
    assert.equal((await f.make().lesson(42, 10, 1001)).lesson.blocks[1].videos[0].url, zero.url);
    for (const bad of [
      { ...zero, url: zero.url.replace('/sc/0/', '/sc/00/') },
      { ...zero, url: zero.url.replace('/sc/0/', '/sc/0123/') },
      { ...zero, blockId: 'missing-block' },
    ]) assert.throws(() => importCourseVideoLinks(f.db, { schemaVersion: 1, rows: [bad] }), /Video source mismatch/);
    assert.equal((await f.make().lesson(42, 10, 1001)).lesson.blocks[1].videos[0].url, zero.url);
  } finally { f.close(); }
});

test('absent, corrupted, or stale video registry never opens video while text stays available', async () => {
  const f = fixture();
  try {
    assert.equal((await f.make().lesson(42, 10, 1001)).lesson.videoAvailable, false);
    importCourseVideoLinks(f.db, { schemaVersion: 1, rows: [videoRows[0]] });
    f.db.exec("UPDATE course_video_links SET sha256='bad'");
    assert.equal((await f.make().lesson(42, 10, 1001)).lesson.blocks[1].videos[0].url, null);
    importCourseVideoLinks(f.db, { schemaVersion: 1, rows: [videoRows[0]] });
    const content = JSON.parse(f.db.prepare('SELECT content_json FROM course_lesson_drafts WHERE lesson_id=1001').get().content_json);
    content.blocks[0].text += ' updated';
    const json = JSON.stringify(content);
    f.db.prepare('UPDATE course_lesson_drafts SET content_json=?,sha256=? WHERE lesson_id=1001').run(json, hash(json));
    assert.equal((await f.make().lesson(42, 10, 1001)).lesson.blocks[1].videos[0].url, null);
  } finally { f.close(); }
});

test('unknown provider keeps its original video position closed', async () => {
  const f = fixture();
  try {
    const stored = f.db.prepare('SELECT content_json FROM course_lesson_drafts WHERE lesson_id=1001').get();
    const content = JSON.parse(stored.content_json);
    content.blocks[1].videos.splice(1, 0, { provider: 'unrecognized', videoId: 'unknown-id' });
    const json = JSON.stringify(content);
    f.db.prepare('UPDATE course_lesson_drafts SET content_json=?,sha256=? WHERE lesson_id=1001').run(json, hash(json));
    importCourseVideoLinks(f.db, { schemaVersion: 1, rows: [
      videoRows[0], { ...videoRows[1], videoIndex: 2 }, { ...videoRows[2], videoIndex: 3 },
    ] });
    const videos = (await f.make().lesson(42, 10, 1001)).lesson.blocks[1].videos;
    assert.deepEqual(videos, [
      { provider: 'getcourse', url: gcUrl }, { provider: 'unknown', url: null },
      { provider: 'youtube', url: videoRows[1].url }, { provider: 'rutube', url: videoRows[2].url },
    ]);
  } finally { f.close(); }
});

test('video mapping refuses a reference attached to a non-video content block', () => {
  const f = fixture();
  try {
    const stored = f.db.prepare('SELECT content_json FROM course_lesson_drafts WHERE lesson_id=1001').get();
    const content = JSON.parse(stored.content_json);
    content.blocks[0].video = { provider: 'youtube', videoId: 'TextBlockId' };
    const json = JSON.stringify(content);
    f.db.prepare('UPDATE course_lesson_drafts SET content_json=?,sha256=? WHERE lesson_id=1001').run(json, hash(json));
    assert.throws(() => importCourseVideoLinks(f.db, { schemaVersion: 1, rows: [
      { lessonId: 1001, blockId: 'text-main', videoIndex: 0,
        provider: 'youtube', url: 'https://www.youtube.com/embed/TextBlockId' },
    ] }), /Video source mismatch/);
    assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='course_video_links'").get(), undefined);
  } finally { f.close(); }
});


test('approved breathing lessons work with no purchases and unavailable GetCourse; neighbours stay closed', async () => {
  for (const [productId, lessonId] of [[4302509, 347472707], [4309095, 347531402]]) {
    const f = fixture({ purchases: [], trainingIds: [] });
    try {
      f.db.prepare('UPDATE course_products SET product_id=? WHERE product_id=10').run(productId);
      f.db.prepare('UPDATE course_lesson_drafts SET lesson_id=? WHERE lesson_id=1001').run(lessonId);
      for (const [table, column] of [['course_program_drafts', 'inventory_json'], ['course_delivery_policy', 'body_json']]) {
        const row = f.db.prepare(`SELECT ${column} AS body FROM ${table}`).get();
        const body = row.body.replace(/"productId":10(?=[,}])/g, `"productId":${productId}`)
          .replace(/"id":1001(?=[,}])/g, `"id":${lessonId}`)
          .replace(/"lessonId":1001(?=[,}])/g, `"lessonId":${lessonId}`);
        f.db.prepare(`UPDATE ${table} SET ${column}=?,sha256=?`).run(body, hash(body));
      }
      let checks = 0;
      const materials = createCourseMaterials({ db: f.db, clock: () => NOW,
        courseChecks: { requireCurrent: async () => { checks++; throw new Error('GetCourse offline'); } } });
      const data = await materials.lesson('free-user', productId, lessonId);
      assert.equal(data.lesson.lessonId, lessonId);
      assert.equal(data.navigation.sections[0].lessons.length, 1);
      assert.equal(data.lesson.assignmentAvailable, false);
      assert.equal(checks, 0);
      await assert.rejects(materials.lesson('free-user', productId, 1002), /GetCourse offline/);
      await assert.rejects(materials.course('free-user', productId), /GetCourse offline/);
      await assert.rejects(materials.lesson('free-user', 999, lessonId), /GetCourse offline/);
    } finally { f.close(); }
  }
});
