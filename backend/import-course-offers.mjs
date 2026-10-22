import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.mjs';
import { importCourseOffers } from './course-catalog.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourcePath, databasePath] = process.argv.slice(2);
  if (!sourcePath || !databasePath || process.argv.length !== 4) throw new Error('Usage: node import-course-offers.mjs offers.json database.sqlite');
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const db = openDatabase(databasePath, false);
  try { console.log(JSON.stringify(importCourseOffers(db, source))); }
  finally { db.close(); }
}
