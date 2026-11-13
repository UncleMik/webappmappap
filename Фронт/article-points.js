import { authRequest } from './auth-client.js?v=20261109-pilot';

const PULSE_MS = 15_000;
const plural = new Intl.PluralRules('ru');
const pointsText = amount => amount + ' ' + { one: 'балл', few: 'балла', many: 'баллов', other: 'балла' }[plural.select(amount)];

function showArticleReward(amount) {
  const reward = document.createElement('dialog');
  reward.className = 'article-reward';
  reward.setAttribute('aria-labelledby', 'article-reward-title');
  reward.setAttribute('aria-describedby', 'article-reward-amount');
  reward.innerHTML = `
    <div class="article-reward-card">
      <span class="article-reward-coin" aria-hidden="true">
        <svg viewBox="0 0 100 100" fill="none">
          <circle cx="50" cy="50" r="48" fill="#FFE48B"/>
          <circle cx="50" cy="50" r="38" fill="#F6BE36" stroke="#FFF3BD" stroke-width="3"/>
          <circle cx="50" cy="50" r="31" stroke="#DCA024" stroke-width="1.5"/>
          <path d="m50 27 6.8 14 15.4 2.2-11.1 10.9 2.6 15.3L50 62.2l-13.7 7.2 2.6-15.3L27.8 43.2 43.2 41Z" fill="#FFF7D9"/>
        </svg>
        <span class="article-reward-spark article-reward-spark-one"></span>
        <span class="article-reward-spark article-reward-spark-two"></span>
        <span class="article-reward-spark article-reward-spark-three"></span>
      </span>
      <span class="article-reward-title" id="article-reward-title" tabindex="-1" autofocus>Награда за прочитанную статью</span>
      <strong class="article-reward-amount" id="article-reward-amount"></strong>
      <button class="article-reward-dismiss" type="button" aria-label="Закрыть уведомление о награде">Нажмите, чтобы закрыть</button>
    </div>`;
  reward.querySelector('.article-reward-amount').textContent = '+' + pointsText(amount);
  let timer;
  function close() {
    clearTimeout(timer);
    reward.close();
  }
  reward.addEventListener('click', close);
  reward.addEventListener('close', () => {
    clearTimeout(timer);
    reward.remove();
  }, { once: true });
  document.body.append(reward);
  try { reward.showModal(); }
  catch { reward.remove(); return () => {}; }
  timer = setTimeout(close, 3000);
  return close;
}

export function trackArticlePoints(scroller, articleId) {
  const frame = window.frameElement;
  const gate = document.querySelector('#account-lock');
  const hint = document.createElement('p');
  const status = document.createElement('p');
  hint.className = status.className = 'reader-reading-time';
  hint.hidden = status.hidden = true;
  status.setAttribute('role', 'status');
  scroller.querySelector('.reader-reading-time').after(hint);
  scroller.querySelector('.reader-finish p').after(status);

  let accountId, attemptId, timer;
  let closeReward = () => {};
  let active = false, pending = false, done = false, suspended = false, reachedEnd = false, generation = 0;
  const pageVisible = () => !document.hidden && !frame?.hidden && !suspended;
  const isAtEnd = () => scroller.clientHeight > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;

  function show(element, text) {
    element.textContent = text;
    element.hidden = false;
  }
  function stop() {
    active = pending = false;
    generation++;
    clearTimeout(timer);
  }
  function finish(text) {
    done = true;
    stop();
    if (text) {
      show(hint, text);
      show(status, text);
    } else {
      hint.hidden = status.hidden = true;
    }
  }

  async function send(start = false) {
    if (pending || !active || !pageVisible() || done) return;
    if (window.webprilSessionAccountId !== accountId) { finish(); return; }
    const id = generation;
    clearTimeout(timer);
    pending = true;
    reachedEnd ||= isAtEnd();
    let wait = null;
    let nextStarts = start;
    try {
      const body = start ? { articleId } : { articleId, attemptId, reachedEnd };
      const result = await authRequest('points/articles', body, { headers: { 'X-Webpril-Account': accountId } });
      if (id !== generation || !pageVisible()) return;
      if (window.webprilSessionAccountId !== accountId) { finish(); return; }
      if (result.status === 'earned') {
        finish(result.amount > 0 ? `+${result.amount} ★ за чтение.` : 'Статья засчитана в прогресс без новых звёздочек.');
        if (Number.isSafeInteger(result.amount) && result.amount > 0) closeReward = showArticleReward(result.amount);
        window.dispatchEvent(new CustomEvent('stars:changed'));
        return;
      }
      if (result.status === 'already_earned') { finish('Эта статья уже засчитана.'); return; }
      if (result.status === 'limited') {
        finish(result.limitedBy === 'week'
          ? 'Недельный лимит исчерпан. Откройте статью снова с понедельника.'
          : 'Дневной лимит исчерпан. Откройте статью снова после 00:00 МСК.');
        return;
      }
      if (result.status !== 'reading') throw new Error('Invalid reading response');
      if (start) {
        if (attemptId && result.attemptId !== attemptId) reachedEnd = isAtEnd();
        attemptId = result.attemptId;
        show(hint, 'За чтение доступно +' + pointsText(result.availableAmount) + '.');
      }
      if (reachedEnd) show(status, 'Засчитываем чтение…');
      nextStarts = false;
      if (result.remainingMs > 0) wait = Math.min(PULSE_MS, result.remainingMs);
      else if (reachedEnd) wait = 0;
    } catch (error) {
      if (id !== generation) return;
      if ([401, 403, 404].includes(error.status) || error.code === 'account_changed') { finish(); return; }
      if (error.code === 'article_attempt_expired') nextStarts = true;
      wait = PULSE_MS;
    } finally {
      if (id === generation) {
        pending = false;
        if (wait !== null && active && pageVisible()) timer = setTimeout(() => void send(nextStarts), wait);
      }
    }
  }

  function syncVisibility() {
    if (!pageVisible()) { closeReward(); if (!done) stop(); return; }
    if (done) return;
    if (active) return;
    if (!window.webprilSessionAccountId || gate?.sheet?.disabled === false) {
      clearTimeout(timer);
      timer = setTimeout(syncVisibility, 100);
      return;
    }
    accountId = window.webprilSessionAccountId;
    active = true;
    void send(true);
  }

  scroller.addEventListener('scroll', () => {
    if (!active || !pageVisible() || reachedEnd || !isAtEnd()) return;
    reachedEnd = true;
    if (attemptId && !pending) void send();
  }, { passive: true });
  document.addEventListener('visibilitychange', syncVisibility);
  window.addEventListener('pagehide', () => { suspended = true; closeReward(); stop(); });
  window.addEventListener('pageshow', () => { suspended = false; syncVisibility(); });
  window.addEventListener('webpril:session-ended', () => { closeReward(); finish(); });
  if (frame) new MutationObserver(syncVisibility).observe(frame, { attributes: true, attributeFilter: ['hidden'] });
  syncVisibility();
}
