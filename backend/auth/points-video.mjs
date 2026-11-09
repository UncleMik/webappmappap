import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AuthError, isUuid } from './security.mjs';
import { weeklyVideoPosition } from './weekly-videos.mjs';

const durations = JSON.parse(readFileSync(new URL('./weekly-video-durations.json', import.meta.url)));
const reward = 30;
const durationMs = position => durations[position] * 1000;

export function mergeWatched(ranges) {
  const merged = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
const lengthOf = ranges => ranges.reduce((total, [start, end]) => total + end - start, 0);

export function createVideoPoints({ withAccount, includes, lockAccount, limits, clock }) {
  return async (token, account, { videoId, attemptId, ranges }) => {
    const position = typeof videoId === 'string' && weeklyVideoPosition(videoId);
    const duration = durationMs(position);
    const starting = attemptId === undefined && ranges === undefined;
    if (!duration) throw new AuthError(404, 'video_not_found', 'Видео не найдено.');
    if (!starting && (!isUuid(attemptId) || !Array.isArray(ranges) || ranges.length > 32 ||
        ranges.some(range => !Array.isArray(range) || range.length !== 2 ||
          !range.every(Number.isSafeInteger) || range[0] < 0 || range[1] <= range[0] || range[0] >= duration ||
          range[1] > duration + 1000))) {
      throw new AuthError(400, 'invalid_video_progress', 'Неверные данные просмотра.');
    }
    return withAccount(token, account, async (client, userId, sessionHash) => {
      if (!includes(userId)) throw new AuthError(403, 'points_unavailable', 'Баллы недоступны.');
      await lockAccount(client, userId);
      const now = new Date(clock());
      const args = [userId, position];
      const { rows: [earned] } = await client.query(
        'SELECT amount FROM auth_points_ledger WHERE user_id=$1 AND video_id=$2', args);
      if (earned) return starting ? { status: 'already_earned' } : { status: 'already_earned', amount: earned.amount };

      const { rows: [view] } = await client.query(
        'SELECT * FROM auth_points_video_views WHERE user_id=$1 AND video_id=$2', args);
      if (starting) {
        const { rows: [profile] } = await client.query(
          "SELECT profile->>'completedAt' AS completed FROM auth_users WHERE id=$1", [userId]);
        if (!profile?.completed) throw new AuthError(403, 'onboarding_required', 'Заполните профиль, чтобы продолжить.');
        const quota = await limits(client, userId, now);
        if (!quota.available) return { status: 'limited', limitedBy: quota.limitedBy };
        const id = randomUUID();
        const watched = view && !view.limited_by ? view.watched : [];
        await client.query(`INSERT INTO auth_points_video_views(user_id,video_id,session_hash,attempt_id,last_seen_at,watched)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id,video_id) DO UPDATE SET
          session_hash=EXCLUDED.session_hash,attempt_id=EXCLUDED.attempt_id,last_seen_at=EXCLUDED.last_seen_at,
          watched=EXCLUDED.watched,limited_by=NULL`, [...args, sessionHash, id, now, JSON.stringify(watched)]);
        return { status: 'watching', attemptId: id, availableAmount: Math.min(reward, quota.available) };
      }
      if (view?.attempt_id !== attemptId || view.session_hash !== sessionHash) {
        throw new AuthError(409, 'video_attempt_expired', 'Начните просмотр снова.');
      }
      if (view.limited_by) return { status: 'limited', limitedBy: view.limited_by };

      const elapsed = +now - +view.last_seen_at;
      const submitted = mergeWatched(ranges.map(([start, end]) => [start, Math.min(end, duration)]));
      const accepted = elapsed >= 0 && elapsed <= 30_000 && lengthOf(submitted) <= elapsed * 2;
      const watched = accepted ? mergeWatched([...view.watched, ...submitted]) : view.watched;
      if (lengthOf(watched) * 5 < duration * 4) {
        await client.query(`UPDATE auth_points_video_views SET last_seen_at=$3,watched=$4 WHERE user_id=$1 AND video_id=$2`,
          [...args, now, JSON.stringify(watched)]);
        return { status: 'watching' };
      }
      const quota = await limits(client, userId, now);
      const amount = Math.min(reward, quota.available);
      if (!amount) {
        await client.query('UPDATE auth_points_video_views SET limited_by=$3 WHERE user_id=$1 AND video_id=$2',
          [...args, quota.limitedBy]);
        return { status: 'limited', limitedBy: quota.limitedBy };
      }
      await client.query(`INSERT INTO auth_points_ledger(user_id,video_id,occurred_at,moscow_day,amount)
        VALUES($1,$2,$3,$4,$5)`, [...args, now, quota.day, amount]);
      await client.query('DELETE FROM auth_points_video_views WHERE user_id=$1 AND video_id=$2', args);
      return { status: 'earned', amount };
    });
  };
}
