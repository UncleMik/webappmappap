import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { importCourseVideoLinks } from './course-video-links.mjs';

const [source, database] = process.argv.slice(2);
if (!source || !database) throw new Error('Usage: node import-course-video-links.mjs private-video-links.json articles.sqlite');
const db = new DatabaseSync(database);
try { console.log(JSON.stringify(importCourseVideoLinks(db, JSON.parse(readFileSync(source, 'utf8'))))); }
finally { db.close(); }
