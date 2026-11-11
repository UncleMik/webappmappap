import { DatabaseSync } from 'node:sqlite';
import { createCourseMaterials } from './course-materials.mjs';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node backend/smoke-course-programs.mjs /absolute/path/to/articles.sqlite');
  process.exitCode = 2;
} else {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const now = Date.now();
    const courseChecks = { requireCurrent: async () => ({
      checkedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 299000).toISOString(),
      snapshot: { version: 2, purchases: [], trainingIds: [], lessonStates: [] },
    }) };
    const materials = createCourseMaterials({ db, courseChecks, clock: () => now });
    const ids = db.prepare("SELECT product_id FROM course_products WHERE type='training' ORDER BY product_id")
      .all().map(row => row.product_id);
    let sections = 0, lessons = 0, lockedLessons = 0;
    for (const productId of ids) {
      const response = await materials.program('synthetic-read-only', productId);
      if (response.course.available) throw new Error(`Unexpected purchased program ${productId}`);
      if (JSON.stringify(response).match(/"blocks"|"html"|"videos"|"url"|"imageUrl"/))
        throw new Error(`Protected content in program ${productId}`);
      sections += response.course.sections.length;
      lessons += response.course.sections.reduce((count, s) => count + s.lessons.length, 0);
      lockedLessons += response.course.sections.reduce((count, s) => count + s.lessons.filter(l => !l.available).length, 0);
    }
    console.log(JSON.stringify({ status: 'ok', products: ids.length, sections, lessons, lockedLessons }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', reason: error?.code || error?.message || 'unknown' }));
    process.exitCode = 1;
  } finally { db.close(); }
}
