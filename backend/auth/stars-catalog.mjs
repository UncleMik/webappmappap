import { readFileSync } from 'node:fs';
import { readArticles } from '../database.mjs';
import { AuthError } from './security.mjs';
import { canAccessWeek } from './stars-access.mjs';

const weeklyVideos = JSON.parse(readFileSync(new URL('../content/weekly-video-materials.json', import.meta.url), 'utf8'));

// Article publication changes are read from the existing catalogue on each call.
// Video positions come from the same reviewed catalogue used by the current player.
export function createStarsCatalog({ db, contentCatalog, courseDurationsPath, starsAi }) {
  let courseDurations = [];
  if (courseDurationsPath) {
    try {
      const input = JSON.parse(readFileSync(courseDurationsPath, 'utf8'));
      if (input.version === 1 && Array.isArray(input.rows)) courseDurations = input.rows;
    } catch { console.error('stars_course_durations_unavailable'); }
  }
  const materials = () => {
    if (!db) throw new AuthError(503, 'catalog_unavailable', 'Материалы временно недоступны.');
    return [...readArticles(db).map(row => ({ id: row.id, kind: 'article', week: row.week, title: row.title })),
      ...weeklyVideos];
  };
  return {
    materials,
    async paidDailyUsed(client, context) {
      return (await starsAi.quota(client, { ...context, now: +new Date(context.now) })).paidUsed;
    },
    courseVideos(lessonId) {
      if (!db) return [];
      const lesson = db.prepare('SELECT sha256 FROM course_lesson_drafts WHERE lesson_id=?').get(lessonId);
      return courseDurations.filter(row => row.lessonId === lessonId && /^[a-f0-9]{64}$/.test(row.contentHash)
        && row.contentHash === lesson?.sha256
        && /^[0-9]+:[0-9]+$/.test(row.videoKey) && Number.isSafeInteger(row.durationMs) && row.durationMs > 0)
        .map(row => ({ key: row.videoKey, durationMs: row.durationMs, provider: row.provider, contentHash: row.contentHash }));
    },
    async daily(context, client) {
      const catalog = typeof contentCatalog === 'function' ? await contentCatalog(context, client) : structuredClone(contentCatalog);
      const { rows: completed } = await client.query('SELECT kind,material_id FROM auth_stars_material_progress WHERE user_id=$1', [context.userId]);
      const { rows: purchased } = await client.query('SELECT week FROM auth_stars_week_purchases WHERE user_id=$1', [context.userId]);
      const done = new Set(completed.map(row => row.kind + ':' + row.material_id));
      const access = { enforced: context.settings.enabled && context.settings.features.weekLocks,
        currentWeek: context.currentWeek || 0, legacy: context.legacy !== false,
        purchasedWeeks: purchased.map(row => row.week), preservedWeeks: context.preservedWeeks || [] };
      const inventory = materials();
      return { ...catalog, inventory: inventory.map(({id, kind, week}) => ({id, kind, week})),
        materials: inventory.filter(row => canAccessWeek(access, row.week))
        .map(row => ({ ...row, accessible: true, completed: done.has(row.kind + ':' + row.id) })) };
    },
  };
}
