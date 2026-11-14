import { readFile } from 'node:fs/promises';
import { transaction } from './store.mjs';

const previous = ['schema.sql', 'single-session-migration.sql', 'course-checks-migration.sql',
  'personal-data-migration.sql', 'club-chat-migration.sql', 'chat-reactions-migration.sql',
  'club-delete-migration.sql', 'chat-reactions-extra-migration.sql', 'club-reading-migration.sql',
  'club-rooms-migration.sql', 'ai-chat-migration.sql', 'ai-failure-migration.sql',
  'ai-conversations-migration.sql', 'points-migration.sql', 'points-article-migration.sql',
  'points-video-migration.sql', 'weekly-poll.sql', 'admin-migration.sql'];
const current = ['stars-migration.sql', 'stars-ai-migration.sql',
  'gamification-migration.sql', 'gamification-admin-migration.sql', 'analytics-migration.sql'];

export async function applyAuthMigrations(pool) {
  const files = await Promise.all([...previous, ...current].map(name => readFile(new URL(name, import.meta.url), 'utf8')));
  await transaction(pool, async client => {
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SELECT pg_advisory_xact_lock(1398030674)");
    const { rows: [state] } = await client.query("SELECT to_regclass('auth_stars_launch') IS NOT NULL AS upgraded");
    // Older poll SQL reinstates its single-source constraint. Generic ledger
    // events introduced by this migration must survive every subsequent run.
    if (!state.upgraded) await client.query(files.slice(0, previous.length).join('\n'));
    await client.query(files.slice(previous.length).join('\n'));
  });
}
