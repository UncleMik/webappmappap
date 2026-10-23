import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { importCourseDeliveryPolicy } from './course-materials.mjs';
const [source, database] = process.argv.slice(2);
if (!source || !database) throw new Error('Usage: node import-course-delivery.mjs private-policy.json articles.sqlite');
const db = new DatabaseSync(database);
try { console.log(JSON.stringify(importCourseDeliveryPolicy(db, JSON.parse(readFileSync(source, 'utf8'))))); }
finally { db.close(); }
