import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.mjs';

const kinds = ['baby', 'mom', 'calendar'];
const weeks = Array.from({ length: 42 }, (_, index) => String(index + 1));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateWeeklyContent(content, uploads) {
  if (!isRecord(content) || Object.keys(content).sort().join(',') !== [...kinds, 'calendarNotes'].sort().join(',')) throw new Error('Expected baby, mom, calendar and calendarNotes');
  const checkedImages = new Set();
  for (const kind of kinds) {
    const entries = content[kind];
    if (!isRecord(entries) || Object.keys(entries).sort((a, b) => Number(a) - Number(b)).join(',') !== weeks.join(',')) throw new Error(`Expected weeks 1–42 for ${kind}`);
    for (const week of weeks) {
      const entry = entries[week];
      if (kind === 'baby') {
        if (!isRecord(entry) || !['description', 'developmentDescription', 'illustration'].every(key => typeof entry[key] === 'string') || !entry.description || !entry.developmentDescription) throw new Error(`Invalid baby week ${week}`);
        for (const key of ['illustration', 'comparisonImage']) {
          if (entry[key] === undefined) continue;
          if (typeof entry[key] !== 'string' || !/^\/uploads\/weekly\/[a-f0-9]{64}\.webp$/.test(entry[key])) throw new Error(`Missing or invalid ${key} for week ${week}`);
          if (!checkedImages.has(entry[key])) {
            const file = resolve(uploads, entry[key].slice('/uploads/'.length));
            if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== entry[key].slice('/uploads/weekly/'.length, -'.webp'.length)) throw new Error(`Missing or invalid ${key} for week ${week}`);
            checkedImages.add(entry[key]);
          }
        }
      } else if (kind === 'mom') {
        if (!isRecord(entry) || typeof entry.title !== 'string' || !entry.title || !Array.isArray(entry.paragraphs) || !entry.paragraphs.length || entry.paragraphs.some(text => typeof text !== 'string' || !text)) throw new Error(`Invalid mom week ${week}`);
      } else if (!Array.isArray(entry) || entry.some(event => !isRecord(event) || typeof event.type !== 'string' || typeof event.title !== 'string' || typeof event.description !== 'string' || !event.title || !event.description || (event.label !== undefined && typeof event.label !== 'string'))) {
        throw new Error(`Invalid calendar week ${week}`);
      }
    }
  }
  if (!isRecord(content.calendarNotes) || Object.entries(content.calendarNotes).some(([week, note]) => !weeks.includes(week) || typeof note !== 'string' || !note)) throw new Error('Invalid calendar notes');
}

export function importWeeklyContent(db, content, uploads) {
  validateWeeklyContent(content, uploads);
  const upsert = db.prepare(`INSERT INTO weekly_content(kind,week,data) VALUES(?,?,?)
    ON CONFLICT(kind,week) DO UPDATE SET data=excluded.data`);
  db.exec('BEGIN');
  try {
    for (const kind of kinds) for (const week of weeks) upsert.run(kind, Number(week), JSON.stringify(content[kind][week]));
    const deleteNote = db.prepare("DELETE FROM weekly_content WHERE kind='calendarNote' AND week=?");
    for (const row of db.prepare("SELECT week FROM weekly_content WHERE kind='calendarNote'").all()) if (!(row.week in content.calendarNotes)) deleteNote.run(row.week);
    for (const [week, note] of Object.entries(content.calendarNotes)) upsert.run('calendarNote', Number(week), JSON.stringify(note));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { baby: 42, mom: 42, calendar: 42, calendarNotes: Object.keys(content.calendarNotes).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, database, uploads] = process.argv.slice(2);
  if (!source || !database || !uploads) throw new Error('Usage: node import-weekly-content.mjs weekly-content.json database.sqlite uploads-directory');
  const content = JSON.parse(readFileSync(source, 'utf8'));
  const db = openDatabase(database, false);
  try { console.log(JSON.stringify(importWeeklyContent(db, content, uploads))); }
  finally { db.close(); }
}
