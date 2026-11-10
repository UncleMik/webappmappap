import { createHash } from 'node:crypto';
import { chmodSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AuthError, isUuid } from './security.mjs';

const maxCoverBytes = 450_000;
const validId = /^pregnancy-\d{3}$/;
const blockTypes = new Set(['paragraph', 'heading', 'list-item']);
const missing = () => new AuthError(404, 'article_not_found', 'Статья не найдена.');
const conflict = () => new AuthError(409, 'article_changed', 'Статья уже изменилась. Откройте её заново.');

function parseCover(value) {
  const invalid = () => new AuthError(400, 'invalid_cover', 'Выберите изображение WebP размером до 450 КБ.');
  if (typeof value !== 'string' || value.length > Math.ceil(maxCoverBytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 30 || bytes.length > maxCoverBytes || bytes.toString('base64') !== value ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8 ||
      bytes.toString('ascii', 8, 12) !== 'WEBP' || !['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) throw invalid();
  return bytes;
}

function parseArticle(data) {
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const { week, blocks } = data;
  if (!title || title.length > 200 || !Number.isInteger(week) || week < 1 || week > 42 ||
      !Array.isArray(blocks) || !blocks.length || blocks.length > 250 ||
      blocks.some(block => !block || !blockTypes.has(block.type) || typeof block.text !== 'string' ||
        !block.text.trim() || block.text.length > 20_000)) {
    throw new AuthError(400, 'invalid_article', 'Укажите неделю, заголовок и заполните блоки статьи.');
  }
  const content = blocks.map(block => ({ type: block.type, text: block.text.trim() }));
  const minutes = Math.max(1, Math.ceil(content.map(block => block.text).join(' ').split(/\s+/).length / 180));
  return { week, title, minutes, blocks: JSON.stringify(content) };
}

export function openAdminArticles(path, uploads) {
  const db = new DatabaseSync(path, { timeout: 2000 });
  const atomic = run => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  try {
    atomic(() => {
      if (!db.prepare('PRAGMA table_info(articles)').all().some(column => column.name === 'editor_revision')) {
        db.exec('ALTER TABLE articles ADD COLUMN editor_revision INTEGER NOT NULL DEFAULT 0');
      }
      db.exec(`CREATE TABLE IF NOT EXISTS admin_article_audit (
        actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, occurred_at TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL
      )`);
    });
  } catch (error) { db.close(); throw error; }

  const columns = 'id, number, week, title, image, status, editor_revision AS revision';
  const get = db.prepare(`SELECT ${columns}, blocks FROM articles WHERE id=? AND access='public'`);
  const priorRequest = db.prepare('SELECT actor,target,fingerprint FROM admin_article_audit WHERE request_id=?');
  const log = db.prepare('INSERT INTO admin_article_audit VALUES(?,?,?,?,?,?)');
  const result = id => {
    const row = get.get(id);
    if (!row) throw missing();
    return { ...row, blocks: JSON.parse(row.blocks) };
  };
  function write(actor, id, action, data) {
    if (id !== null && !validId.test(id)) throw missing();
    if (!isUuid(data.requestId)) throw new AuthError(400, 'invalid_request', 'Обновите страницу и повторите действие.');
    const publish = action === 'article_published';
    const content = publish ? parseArticle(data) : null;
    const cover = publish && data.cover !== undefined ? parseCover(data.cover) : null;
    const fingerprint = createHash('sha256').update(JSON.stringify([id, action, data.revision, content,
      data.removeCover === true, data.cover])).digest('hex');
    let createdCover;
    try {
      return atomic(() => {
        const previous = priorRequest.get(data.requestId);
        if (previous) {
          if (previous.actor !== actor || previous.fingerprint !== fingerprint) throw conflict();
          return result(previous.target);
        }
        const current = id === null ? null : get.get(id);
        if (id !== null && !current) throw missing();
        if (current && current.revision !== data.revision) throw conflict();
        let image = data.removeCover === true ? null : current?.image ?? null;
        if (cover) {
          const name = `admin-${createHash('sha256').update(cover).digest('hex')}.webp`;
          const file = join(uploads, name);
          try {
            writeFileSync(file, cover, { flag: 'wx' });
            createdCover = file;
            chmodSync(file, 0o644);
          } catch (error) { if (error.code !== 'EEXIST') throw error; }
          image = `/uploads/articles/${name}`;
        }
        let target = id;
        if (!current) {
          const { number } = db.prepare('SELECT COALESCE(MAX(number),0)+1 AS number FROM articles').get();
          if (number > 999) throw new AuthError(409, 'article_capacity', 'Достигнут предел нумерации статей.');
          target = `pregnancy-${String(number).padStart(3, '0')}`;
          db.prepare(`INSERT INTO articles(id,number,week,title,image,minutes,blocks,editor_revision)
            VALUES(?,?,?,?,?,?,?,1)`).run(target, number, content.week, content.title, image, content.minutes, content.blocks);
        } else if (publish) {
          db.prepare(`UPDATE articles SET week=?,title=?,image=?,minutes=?,blocks=?,status='published',
            editor_revision=editor_revision+1 WHERE id=?`)
            .run(content.week, content.title, image, content.minutes, content.blocks, target);
        } else {
          const status = action === 'article_hidden' ? 'draft' : 'published';
          db.prepare('UPDATE articles SET status=?,editor_revision=editor_revision+1 WHERE id=?').run(status, target);
        }
        log.run(actor, action, target, new Date().toISOString(), data.requestId, fingerprint);
        return result(target);
      });
    } catch (error) {
      if (createdCover) unlinkSync(createdCover);
      throw error;
    }
  }
  return {
    list: () => db.prepare(`SELECT ${columns} FROM articles WHERE access='public' ORDER BY week,number`).all(),
    get: result,
    publish: (actor, id, data) => write(actor, id, 'article_published', data),
    visibility: (actor, id, data) => {
      if (typeof data.visible !== 'boolean') throw new AuthError(400, 'invalid_visibility', 'Выберите действие для статьи.');
      return write(actor, id, data.visible ? 'article_restored' : 'article_hidden', data);
    },
    audit: () => db.prepare(`SELECT actor,action,target,occurred_at AS "occurredAt"
      FROM admin_article_audit ORDER BY rowid DESC LIMIT 50`).all(),
    close: () => db.close(),
  };
}
