import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.mjs';
import { importCourseDrafts } from './course-drafts.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourcePath, databasePath, trustedPath] = process.argv.slice(2);
  if (!sourcePath || !databasePath || !trustedPath || process.argv.length !== 5) throw new Error('Usage: node import-course-drafts.mjs private-snapshot.json database.sqlite trusted-inventories.json');
  const source = JSON.parse(readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, ''));
  const trustedInventories = JSON.parse(readFileSync(trustedPath, 'utf8').replace(/^\uFEFF/, ''));
  const db = openDatabase(databasePath, false);
  try { console.log(JSON.stringify(importCourseDrafts(db, source, trustedInventories))); }
  finally { db.close(); }
}
