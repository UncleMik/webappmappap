import { authRequest } from './auth-client.js';

function played(video) {
  const ranges = [];
  for (let i = 0; i < video.played.length; i++) {
    const start = Math.ceil(video.played.start(i) * 1000), end = Math.floor(video.played.end(i) * 1000);
    if (end > start) ranges.push([start, end]);
  }
  return ranges;
}

function difference(ranges, previous) {
  const result = [];
  for (const [start, end] of ranges) {
    let cursor = start;
    for (const [left, right] of previous) {
      if (right <= cursor) continue;
      if (left >= end) break;
      if (left > cursor) result.push([cursor, left]);
      cursor = Math.max(cursor, right);
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}

export function trackVideoPoints(video, videoId, note) {
  const frame = window.frameElement;
  const visible = () => !document.hidden && !frame?.hidden;
  const account = window.webprilSessionAccountId;
  let attemptId, baseline = [], timer, pending = false, stopped = false, reset = true;
  async function update() {
    clearTimeout(timer);
    if (pending || stopped || !visible()) return;
    const user = window.webprilSessionAccountId;
    if (!user || (account && user !== account)) return;
    if (!attemptId && video.paused && !video.ended) return;
    pending = true;
    try {
      const snapshot = played(video);
      const start = reset || !attemptId;
      const data = start ? { videoId } : { videoId, attemptId, ranges: difference(snapshot, baseline).slice(0, 32) };
      const result = await authRequest('points/videos', data, { headers: { 'X-Webpril-Account': user } });
      if (stopped || window.webprilSessionAccountId !== user) return;
      if (result.status === 'watching') {
        baseline = snapshot;
        if (start) {
          attemptId = result.attemptId;
          reset = !visible();
          note.textContent = 'За просмотр 80% ролика доступно +' + result.availableAmount + '.';
        }
      } else {
        stopped = true;
        window.dispatchEvent(new CustomEvent('stars:changed'));
        note.textContent = result.status === 'earned' ? (result.amount > 0 ? '+' + result.amount + ' ★ за просмотр.' : 'Видео засчитано в прогресс без новых звёздочек.')
          : result.status === 'already_earned' ? 'Это видео уже засчитано.'
          : result.limitedBy === 'week' ? 'Недельный лимит баллов исчерпан.' : 'Дневной лимит баллов исчерпан.';
      }
    } catch (error) {
      if ([401,403,404].includes(error.status) || error.code === 'account_changed') stopped = true;
      if (error.code === 'video_attempt_expired' || error.code === 'network_error') reset = true;
    } finally {
      pending = false;
      if (!stopped && visible() && !video.paused && !video.ended) timer = setTimeout(update, 12_000);
    }
  }
  video.addEventListener('playing', update);
  video.addEventListener('pause', update);
  // The player waits for this final checkpoint before advancing to the next clip.
  function visibility() {
    if (!visible()) { clearTimeout(timer); reset = true; }
    else if (!video.paused) void update();
  }
  document.addEventListener('visibilitychange', visibility);
  if (frame) new MutationObserver(visibility).observe(frame, { attributes: true, attributeFilter: ['hidden'] });
  addEventListener('pagehide', () => { clearTimeout(timer); reset = true; });
  addEventListener('webpril:session-ended', () => { stopped = true; clearTimeout(timer); });
  return async () => {
    while (pending) await new Promise(resolve => setTimeout(resolve, 50));
    await update();
  };
}
