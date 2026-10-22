import { createHash } from 'node:crypto';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const allowedTags = new Set('div span p h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr td th caption colgroup col br hr strong b em i u s del blockquote pre code details summary sup sub'.split(' '));
const fields = (value, names) => {
  if (!record(value) || Object.keys(value).some(key => !names.includes(key))) throw new Error('Unexpected draft field');
};
const lessonFields = 'schemaVersion status lessonId title sourceTitle parentStreamId sourceVisibleStatus capturedAt blocks extractionWarnings emptyReason sourceWrapperCount excludedServiceBlockCount'.split(' ');
const blockFields = 'blockId order type text html richHtml videos video images attachments placeholder sourceBlockOrder sourcePartOrder sourceDomPath'.split(' ');

function checkBlock(block) {
  fields(block, blockFields);
  for (const name of ['text', 'html', 'richHtml']) {
    if (block[name] != null && typeof block[name] !== 'string') throw new Error('Invalid text field');
  }
  if (block.sourceBlockOrder != null && (!Number.isSafeInteger(block.sourceBlockOrder) || block.sourceBlockOrder < 0)) throw new Error('Invalid source order');
  if (block.sourcePartOrder != null && (!Number.isFinite(block.sourcePartOrder) || block.sourcePartOrder < 0)) throw new Error('Invalid source part');
  if (block.sourceDomPath != null && typeof block.sourceDomPath !== 'string' &&
      (!Array.isArray(block.sourceDomPath) || block.sourceDomPath.some(part => !Number.isSafeInteger(part) || part < 0))) throw new Error('Invalid DOM path');
  if (block.videos != null && !Array.isArray(block.videos)) throw new Error('Invalid videos');
  const videos = [...(block.videos ?? []), ...(block.video == null ? [] : [block.video])];
  for (const video of videos) {
    fields(video, ['provider', 'getcourseFileId', 'videoId']);
    if (typeof video.provider !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(video.provider) ||
        (video.getcourseFileId != null && !/^[1-9][0-9]*$/.test(String(video.getcourseFileId))) ||
        (video.videoId != null && (typeof video.videoId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(video.videoId)))) throw new Error('Invalid video reference');
  }
  for (const name of ['images', 'attachments']) {
    if (block[name] == null) continue;
    if (!Array.isArray(block[name])) throw new Error('Invalid file references');
    for (const item of block[name]) {
      fields(item, ['caption', 'type']);
      if (typeof item.caption !== 'string' || typeof item.type !== 'string') throw new Error('Invalid file placeholder');
    }
  }
  if (block.placeholder != null) {
    fields(block.placeholder, ['downloaded', 'fileType', 'label', 'targetVerified']);
    if (block.placeholder.downloaded !== false || (block.placeholder.label != null && typeof block.placeholder.label !== 'string') ||
        (block.placeholder.fileType != null && typeof block.placeholder.fileType !== 'string') ||
        (block.placeholder.targetVerified != null && typeof block.placeholder.targetVerified !== 'boolean')) throw new Error('Invalid file placeholder');
  }
}

// These captures are private drafts. No player URL or browser credential belongs
// in a content snapshot, even before a student-facing delivery route is added.
function checkContent(value, key = '') {
  if (typeof value === 'string') {
    if (/https?:\/\/[^\s"<>]*(?:sign-player|[?&](?:signature|token|user_id|auth)=)/i.test(value)) throw new Error('Signed playback URL in draft');
    if (key === 'html' || key === 'richHtml') {
      for (const token of value.matchAll(/<([^>]*)>/g)) {
        const match = token[1].match(/^\/?([a-z][a-z0-9]*)\s*\/?$/i);
        if (!match || !allowedTags.has(match[1].toLowerCase())) throw new Error('Unsafe markup in draft');
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) checkContent(item, key);
  } else if (record(value)) {
    for (const [name, item] of Object.entries(value)) {
      if (/^(?:url|src|href|iframe|cookie|cookies|authorization|password|csrf|access_token)$/i.test(name)) throw new Error('Browser or URL field in draft');
      checkContent(item, name);
    }
  } else if (value !== null && typeof value !== 'number' && typeof value !== 'boolean') throw new Error('Invalid draft value');
}

export function validateCourseDrafts(source, trustedInventories) {
  if (!record(source) || source.schemaVersion !== 1 || !Array.isArray(source.families) || !source.families.length) throw new Error('Invalid draft snapshot');
  const families = new Set(), lessonIds = new Set();
  return source.families.map(group => {
    if (!record(group) || !['express', 'full'].includes(group.family) || families.has(group.family) || !record(group.inventory) || !Array.isArray(group.inventory.lessons) || !group.inventory.lessons.length || !Array.isArray(group.lessons)) throw new Error('Invalid draft family');
    families.add(group.family);
    if (!record(trustedInventories) || !record(trustedInventories[group.family]) ||
        hash(JSON.stringify(trustedInventories[group.family])) !== hash(JSON.stringify(group.inventory))) throw new Error('Inventory differs from trusted source');
    const expected = new Map();
    for (const item of group.inventory.lessons) {
      const lessonId = group.family === 'express' ? item.id : item.lessonId;
      const parent = group.family === 'express' ? item.parentId : item.parentStreamId;
      if (!id(lessonId) || !id(parent) || expected.has(lessonId)) throw new Error('Invalid inventory lesson');
      expected.set(lessonId, { parent, item });
    }
    if (group.lessons.length !== expected.size) throw new Error('Incomplete draft family');
    const lessons = group.lessons.map(lesson => {
      fields(lesson, lessonFields);
      if (!record(lesson) || !id(lesson.lessonId) || !expected.has(lesson.lessonId) || lessonIds.has(lesson.lessonId)) throw new Error('Unknown or duplicate captured lesson');
      const inventory = expected.get(lesson.lessonId);
      if (lesson.parentStreamId !== inventory.parent || typeof lesson.title !== 'string' || !lesson.title.trim() || typeof lesson.capturedAt !== 'string' || !Number.isFinite(Date.parse(lesson.capturedAt)) || !Array.isArray(lesson.blocks) || !Array.isArray(lesson.extractionWarnings) || lesson.extractionWarnings.some(warning => typeof warning !== 'string') || (lesson.status !== undefined && lesson.status !== 'captured')) throw new Error('Invalid captured lesson');
      for (const name of ['sourceTitle', 'sourceVisibleStatus', 'emptyReason']) {
        if (lesson[name] != null && typeof lesson[name] !== 'string') throw new Error('Invalid source text');
      }
      for (const name of ['schemaVersion', 'sourceWrapperCount', 'excludedServiceBlockCount']) {
        if (lesson[name] != null && (!Number.isSafeInteger(lesson[name]) || lesson[name] < 0)) throw new Error('Invalid capture metadata');
      }
      if (!lesson.blocks.length && !lesson.emptyReason) throw new Error('Unexplained empty lesson');
      let previousOrder = -1;
      for (const block of lesson.blocks) {
        if (!record(block) || typeof block.blockId !== 'string' || !Number.isSafeInteger(block.order) || block.order <= previousOrder || !['text', 'list', 'table', 'video', 'image', 'attachment', 'other'].includes(block.type)) throw new Error('Invalid content block');
        previousOrder = block.order;
        checkBlock(block);
      }
      checkContent(lesson);
      lessonIds.add(lesson.lessonId);
      const json = JSON.stringify(lesson);
      return { lesson, json, sha256: hash(json), sourceStatus: JSON.stringify(inventory.item.visibleStatus ?? null) };
    });
    const inventoryJson = JSON.stringify(group.inventory);
    checkContent(group.inventory);
    return { family: group.family, inventoryJson, inventorySha256: hash(inventoryJson), lessons };
  });
}

export function importCourseDrafts(db, source, trustedInventories) {
  const groups = validateCourseDrafts(source, trustedInventories);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS course_program_drafts (
        family TEXT PRIMARY KEY CHECK(family IN ('express','full')),
        inventory_json TEXT NOT NULL,
        sha256 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS course_lesson_drafts (
        lesson_id INTEGER PRIMARY KEY CHECK(lesson_id > 0),
        family TEXT NOT NULL CHECK(family IN ('express','full')),
        parent_stream_id INTEGER NOT NULL CHECK(parent_stream_id > 0),
        title TEXT NOT NULL,
        source_status_json TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        content_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'unavailable' CHECK(delivery_status = 'unavailable')
      );
    `);
    const program = db.prepare(`INSERT INTO course_program_drafts(family,inventory_json,sha256) VALUES(?,?,?)
      ON CONFLICT(family) DO UPDATE SET inventory_json=excluded.inventory_json,sha256=excluded.sha256`);
    const remove = db.prepare('DELETE FROM course_lesson_drafts WHERE family=?');
    const insert = db.prepare(`INSERT INTO course_lesson_drafts(lesson_id,family,parent_stream_id,title,source_status_json,captured_at,content_json,sha256)
      VALUES(?,?,?,?,?,?,?,?)`);
    for (const group of groups) {
      program.run(group.family, group.inventoryJson, group.inventorySha256);
      remove.run(group.family);
      for (const row of group.lessons) {
        const lesson = row.lesson;
        insert.run(lesson.lessonId, group.family, lesson.parentStreamId, lesson.sourceTitle ?? lesson.title, row.sourceStatus, lesson.capturedAt, row.json, row.sha256);
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { families: groups.length, lessons: groups.reduce((sum, group) => sum + group.lessons.length, 0), deliveryStatus: 'unavailable' };
}
