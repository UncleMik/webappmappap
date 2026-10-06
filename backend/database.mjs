import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path, readOnly = true) {
  const db = new DatabaseSync(path, { readOnly });
  if (!readOnly) db.exec(`
    PRAGMA journal_mode=DELETE;
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      number INTEGER UNIQUE NOT NULL,
      week INTEGER NOT NULL CHECK(week BETWEEN 1 AND 42),
      title TEXT NOT NULL,
      image TEXT,
      minutes INTEGER NOT NULL,
      blocks TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','draft')),
      access TEXT NOT NULL DEFAULT 'public' CHECK(access IN ('public','restricted'))
    );
    CREATE INDEX IF NOT EXISTS articles_week ON articles(week);
  `);
  return db;
}

export function readArticles(db, week = null) {
  const columns = 'id, number, week, title, image, minutes';
  const rows = week === null
    ? db.prepare(`SELECT ${columns} FROM articles WHERE status='published' AND access='public' ORDER BY number`).all()
    : db.prepare(`SELECT ${columns} FROM articles WHERE status='published' AND access='public' AND week=? ORDER BY number`).all(week);
  return rows;
}

export function readArticle(db, id) {
  const row = db.prepare("SELECT id, number, week, title, image, minutes, blocks FROM articles WHERE id=? AND status='published' AND access='public'").get(id);
  return row ? { ...row, blocks: JSON.parse(row.blocks) } : null;
}
