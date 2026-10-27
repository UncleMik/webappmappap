import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const providers = new Set(['getcourse', 'youtube', 'rutube']);
const gcPattern = /^https:\/\/fs\.getcourse\.ru\/fileservice\/file\/download\/a\/25918\/sc\/(?:0|[1-9][0-9]*)\/h\/[a-fA-F0-9]{32}\.(?:mp4|m4v|mov|webm)$/;

export function videoReferences(block) {
  if (!record(block)) return [];
  const refs = [...(Array.isArray(block.videos) ? block.videos : []), ...(block.video == null ? [] : [block.video])];
  return refs;
}

function validUrl(provider, url, source) {
  if (typeof url !== 'string' || url.length > 500) return false;
  if (provider === 'getcourse') return gcPattern.test(url);
  if (typeof source.videoId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(source.videoId)) return false;
  if (provider === 'youtube') return url === `https://www.youtube.com/embed/${source.videoId}`
    || url === `https://www.youtube-nocookie.com/embed/${source.videoId}`;
  // Unlisted Rutube videos require the original access key from the school embed.
  // Accept only that key, on the exact host/path/video already in this lesson.
  const rutube = url.match(/^https:\/\/rutube\.ru\/play\/embed\/([A-Za-z0-9_-]{1,200})\/?(?:\?p=[A-Za-z0-9_-]{1,200})?$/);
  return provider === 'rutube' && rutube?.[1] === source.videoId;
}

function validatedRows(db, source, stored = false) {
  if (!record(source) || source.schemaVersion !== 1 || !Array.isArray(source.rows)
    || Object.keys(source).some(key => !['schemaVersion', 'rows'].includes(key))) throw new Error('Invalid video registry');
  const getLesson = db.prepare('SELECT content_json,sha256 FROM course_lesson_drafts WHERE lesson_id=?');
  const cached = new Map(), seen = new Set();
  return source.rows.map(row => {
    if (!record(row) || Object.keys(row).some(key => !['lessonId', 'blockId', 'videoIndex', 'provider', 'url', 'getcourseFileId', ...(stored ? ['contentHash'] : [])].includes(key))
      || !id(row.lessonId) || typeof row.blockId !== 'string' || !row.blockId || row.blockId.length > 200
      || !Number.isSafeInteger(row.videoIndex) || row.videoIndex < 0 || !providers.has(row.provider)) throw new Error('Invalid video mapping');
    const key = `${row.lessonId}\u0000${row.blockId}\u0000${row.videoIndex}`;
    if (seen.has(key)) throw new Error('Duplicate video mapping');
    seen.add(key);
    let lesson = cached.get(row.lessonId);
    if (!lesson) {
      const stored = getLesson.get(row.lessonId);
      if (!stored || hash(stored.content_json) !== stored.sha256) throw new Error('Invalid video target');
      let content;
      try { content = JSON.parse(stored.content_json); } catch { throw new Error('Invalid video target'); }
      if (!Array.isArray(content.blocks)) throw new Error('Invalid video target');
      const blocks = new Map();
      for (const block of content.blocks) {
        if (typeof block.blockId !== 'string' || !block.blockId || blocks.has(block.blockId)) throw new Error('Invalid video block IDs');
        blocks.set(block.blockId, block);
      }
      lesson = { blocks, contentHash: stored.sha256 };
      cached.set(row.lessonId, lesson);
    }
    const block = lesson.blocks.get(row.blockId);
    const references = block && videoReferences(block);
    const original = references?.[row.videoIndex];
    if (block?.type !== 'video' || !original || original.provider !== row.provider
      || !validUrl(row.provider, row.url, original)) throw new Error('Video source mismatch');
    if (stored && row.contentHash !== lesson.contentHash) throw new Error('Changed video target');
    if (row.provider === 'getcourse') {
      if (original.getcourseFileId != null && String(original.getcourseFileId) !== String(row.getcourseFileId)) throw new Error('GetCourse file mismatch');
      if (row.getcourseFileId != null && (!id(Number(row.getcourseFileId)) || String(Number(row.getcourseFileId)) !== String(row.getcourseFileId))) throw new Error('Invalid GetCourse file ID');
    } else if (row.getcourseFileId != null) throw new Error('Unexpected GetCourse file ID');
    return { lessonId: row.lessonId, blockId: row.blockId, videoIndex: row.videoIndex,
      provider: row.provider, url: row.url,
      ...(row.getcourseFileId == null ? {} : { getcourseFileId: row.getcourseFileId }),
      contentHash: lesson.contentHash };
  });
}

export function importCourseVideoLinks(db, source) {
  const rows = validatedRows(db, source);
  const body = JSON.stringify({ schemaVersion: 1, rows });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS course_video_links (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      body_json TEXT NOT NULL,
      sha256 TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO course_video_links(singleton,body_json,sha256) VALUES(1,?,?)
      ON CONFLICT(singleton) DO UPDATE SET body_json=excluded.body_json,sha256=excluded.sha256`).run(body, hash(body));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { links: rows.length };
}

export function loadCourseVideoLinks(db) {
  let stored;
  try { stored = db.prepare('SELECT body_json,sha256 FROM course_video_links WHERE singleton=1').get(); }
  catch { return new Map(); } // Old database without a registry: all videos stay closed.
  if (!stored || hash(stored.body_json) !== stored.sha256) return new Map();
  try {
    const source = JSON.parse(stored.body_json);
    const rows = validatedRows(db, source, true);
    const links = new Map();
    for (const row of rows) {
      links.set(`${row.lessonId}\u0000${row.blockId}\u0000${row.videoIndex}`, row);
    }
    return links;
  } catch { return new Map(); }
}

export function videoLink(links, lessonId, blockId, videoIndex, contentHash) {
  const item = links.get(`${lessonId}\u0000${blockId}\u0000${videoIndex}`);
  return item?.contentHash === contentHash ? item.url : null;
}
