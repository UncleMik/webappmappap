import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from './database.mjs';

const [source, database, uploads] = process.argv.slice(2);
if (!source || !database || !uploads) throw new Error('Usage: node import-articles.mjs articles.json database.sqlite uploads-directory');
const articles = JSON.parse(readFileSync(source, 'utf8'));
const ids = new Set();
for (const article of articles) {
  if (!/^pregnancy-\d{3}$/.test(article.id) || ids.has(article.id)) throw new Error('Invalid or duplicate article id');
  ids.add(article.id);
  if (!Number.isInteger(article.week) || article.week < 1 || article.week > 42 || !Number.isInteger(article.number) || !article.title || !Array.isArray(article.blocks) || !article.blocks.length) throw new Error(`Invalid article ${article.id}`);
  for (const block of article.blocks) if (!['paragraph', 'heading', 'list-item'].includes(block.type) || typeof block.text !== 'string') throw new Error(`Invalid block ${article.id}`);
  if (article.image && (!/^\/uploads\/articles\/[a-z0-9-]+\.webp$/.test(article.image) || !existsSync(resolve(uploads, article.image.slice('/uploads/'.length))))) throw new Error(`Missing image ${article.id}`);
}
const db = openDatabase(database, false);
const insert = db.prepare(`INSERT INTO articles(id,number,week,title,image,minutes,blocks) VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET number=excluded.number,week=excluded.week,title=excluded.title,image=excluded.image,minutes=excluded.minutes,blocks=excluded.blocks`);
db.exec('BEGIN');
try {
  for (const article of articles) insert.run(article.id, article.number, article.week, article.title, article.image || null, Math.max(1, Math.ceil(article.blocks.map(block => block.text).join(' ').split(/\s+/).length / 180)), JSON.stringify(article.blocks));
  db.exec('COMMIT');
} catch (error) { db.exec('ROLLBACK'); throw error; }
console.log(JSON.stringify({ imported: articles.length, withImages: articles.filter(article => article.image).length }));
db.close();
