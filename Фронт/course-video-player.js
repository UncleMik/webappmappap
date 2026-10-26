import { queueCourseVideoRestore, resumeCourseVideo, stopCourseMedia } from './course-views.js?v=20261026-course-layout';

const svg = path => {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  icon.append(shape);
  return { icon, shape };
};

const element = (tag, className, label) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label) node.textContent = label;
  return node;
};

const formatTime = seconds => {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole % 3600 / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
};

export function mountCourseVideo({ video, container, key, saved, isAllowed, refresh, previous, next, chapters = [], title }) {
  container.classList.add('course-player');
  const valid = () => container.isConnected && isAllowed();
  const allowed = () => {
    if (valid()) return true;
    if (container.isConnected) refresh();
    return false;
  };
  const player = element('video', 'course-video-element');
  player.courseVideoKey = key;
  player.playsInline = true;
  player.preload = saved ? 'metadata' : 'none';
  player.setAttribute('controlslist', 'nodownload');
  player.setAttribute('aria-label', title || 'Видео урока');
  const stage = element('div', 'video-stage');
  const cover = element('button', 'video-cover course-video-start');
  cover.type = 'button';
  cover.setAttribute('aria-label', 'Включить видео');
  const circle = element('span', 'cover-play');
  circle.append(svg('m8 4 13 8-13 8Z').icon);
  const coverLabel = element('span', 'cover-label', 'Смотреть видео');
  cover.append(circle, coverLabel);
  const fullscreen = element('button', 'video-fullscreen-button');
  fullscreen.type = 'button';
  fullscreen.disabled = true;
  fullscreen.setAttribute('aria-label', 'На весь экран');
  const fullscreenIcon = svg('M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5');
  fullscreen.append(fullscreenIcon.icon);
  stage.append(player, cover, fullscreen);

  const panel = element('div', 'video-panel');
  const timeline = element('div', 'video-timeline');
  const progress = element('input', 'course-video-progress');
  progress.type = 'range';
  progress.min = '0';
  progress.max = '100';
  progress.step = '0.1';
  progress.value = '0';
  progress.disabled = true;
  progress.setAttribute('aria-label', 'Позиция в видео');
  const time = element('output', 'course-video-time', '0:00');
  timeline.append(progress, time);
  const controls = element('div', 'video-controls');
  const previousButton = element('button', 'skip-button');
  previousButton.type = 'button';
  previousButton.disabled = !previous;
  previousButton.setAttribute('aria-label', previous ? `Предыдущий урок: ${previous.title}` : 'Предыдущего урока нет');
  previousButton.append(svg('M5 5h3v14H5zm14 0v14L8 12Z').icon);
  const playButton = element('button', 'play-button');
  playButton.type = 'button';
  playButton.setAttribute('aria-label', 'Воспроизвести видео');
  const playIcon = svg('m8 4 13 8-13 8Z');
  playButton.append(playIcon.icon);
  const nextButton = element('button', 'skip-button');
  nextButton.type = 'button';
  nextButton.disabled = !next;
  nextButton.setAttribute('aria-label', next ? `Следующий урок: ${next.title}` : 'Следующего урока нет');
  nextButton.append(svg('M16 5h3v14h-3zM5 5l11 7-11 7Z').icon);
  controls.append(previousButton, playButton, nextButton);
  const status = element('p', 'course-player-status');
  status.setAttribute('role', 'status');
  status.hidden = true;
  panel.append(timeline, controls, status);
  container.append(stage, panel);

  function message(value) {
    status.textContent = value;
    status.hidden = !value;
  }
  function update() {
    if (!valid()) return;
    const duration = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
    progress.disabled = duration === 0;
    fullscreen.disabled = duration === 0;
    progress.max = String(duration || 100);
    progress.value = String(Math.min(player.currentTime || 0, duration || 100));
    progress.style.setProperty('--progress', `${duration ? player.currentTime / duration * 100 : 0}%`);
    progress.setAttribute('aria-valuetext', `${formatTime(player.currentTime)} из ${formatTime(duration)}`);
    time.value = formatTime(Math.max(0, duration - player.currentTime));
    if (player.videoWidth > 0 && player.videoHeight > 0) {
      stage.style.setProperty('--video-aspect-ratio', `${player.videoWidth} / ${player.videoHeight}`);
    }
  }
  function playing(value) {
    playButton.setAttribute('aria-label', value ? 'Пауза' : 'Воспроизвести видео');
    playIcon.shape.setAttribute('d', value ? 'M5 4h5v16H5zm9 0h5v16h-5z' : 'm8 4 13 8-13 8Z');
  }
  let pendingTime = null;
  function applyTime() {
    if (!valid() || pendingTime === null || !Number.isFinite(player.duration)) return;
    try { player.currentTime = Math.max(0, Math.min(pendingTime, player.duration - 0.1)); }
    catch { return; }
    pendingTime = null;
    update();
  }
  async function start(position = null) {
    if (!allowed()) return;
    if (Number.isFinite(position) && position >= 0) pendingTime = position;
    if (player.getAttribute('src') && player.readyState >= 1) applyTime();
    if (!player.getAttribute('src')) player.src = video.url;
    cover.hidden = true;
    message('Загружаем видео…');
    try {
      await player.play();
      if (!valid()) return;
      applyTime();
      message('');
    } catch (failure) {
      if (!valid()) return;
      if (failure?.name === 'AbortError' && player.getAttribute('src') && player.paused) { message(''); return; }
      cover.hidden = false;
      coverLabel.textContent = failure?.name === 'NotAllowedError' ? 'Нажмите, чтобы включить' : 'Попробовать ещё раз';
      cover.setAttribute('aria-label', 'Повторить воспроизведение');
      message(failure?.name === 'NotAllowedError' ? 'Нажмите «Смотреть видео», чтобы начать.' : 'Не удалось открыть видео. Попробуйте ещё раз.');
    }
  }
  cover.addEventListener('click', () => start());
  playButton.addEventListener('click', () => {
    if (!allowed()) return;
    if (player.getAttribute('src') && !player.paused) player.pause();
    else void start();
  });
  progress.addEventListener('input', () => {
    if (!allowed() || !Number.isFinite(player.duration)) return;
    try { player.currentTime = Math.min(Number(progress.value), Math.max(0, player.duration - 0.1)); }
    catch { /* The browser may still be loading seekable ranges. */ }
  });
  function navigate(destination) {
    if (!destination || !allowed()) return;
    const target = new URL(destination.href, location.href);
    if (target.origin !== location.origin || !target.pathname.endsWith('/article.html')) return;
    stopCourseMedia(document.querySelector('.reader-scroll') || container);
    location.assign(target.href);
  }
  previousButton.addEventListener('click', () => navigate(previous));
  nextButton.addEventListener('click', () => navigate(next));

  const safeChapters = chapters.filter(entry => Number.isFinite(entry?.seconds) && entry.seconds >= 0
    && typeof entry.label === 'string' && entry.label.trim());
  if (safeChapters.length) {
    const timestamps = element('details', 'video-chapters video-timestamps');
    timestamps.open = true;
    const heading = element('summary', '', 'Таймкоды ');
    heading.append(element('span', '', String(safeChapters.length)));
    const list = element('ol');
    for (const chapter of safeChapters) {
      const item = element('li'), button = element('button');
      button.type = 'button';
      const stamp = element('time', '', formatTime(chapter.seconds));
      stamp.dateTime = `PT${chapter.seconds}S`;
      button.append(stamp, element('span', '', chapter.label));
      button.addEventListener('click', () => start(chapter.seconds));
      item.append(button);
      list.append(item);
    }
    timestamps.append(heading, list);
    panel.append(timestamps);
  }

  fullscreen.addEventListener('click', async () => {
    if (!allowed() || fullscreen.disabled) return;
    try {
      if (document.fullscreenElement === container) await document.exitFullscreen();
      else if (container.requestFullscreen) await container.requestFullscreen();
      else player.webkitEnterFullscreen?.();
    } catch { message('Не удалось открыть полноэкранный режим.'); }
  });
  container.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === container;
    fullscreen.setAttribute('aria-label', active ? 'Выйти из полного экрана' : 'На весь экран');
    fullscreen.setAttribute('aria-pressed', String(active));
  });
  player.addEventListener('loadedmetadata', () => { applyTime(); update(); });
  player.addEventListener('resize', update);
  player.addEventListener('timeupdate', update);
  player.addEventListener('playing', () => {
    if (!valid()) { player.pause(); return; }
    cover.hidden = true;
    playing(true);
    message('');
    document.querySelectorAll('.course-video-item').forEach(item => { if (item !== container) item.courseReset?.(); });
    document.querySelectorAll('video.course-video-element').forEach(other => {
      if (other !== player) other.pause();
    });
  });
  player.addEventListener('pause', () => playing(false));
  player.addEventListener('ended', () => { playing(false); message('Видео завершено. Можно перейти к следующему уроку.'); });
  player.addEventListener('error', () => {
    if (!valid() || !player.getAttribute('src')) return;
    player.pause();
    player.removeAttribute('src');
    player.load();
    cover.hidden = false;
    coverLabel.textContent = 'Попробовать ещё раз';
    message('Не удалось открыть видео. Попробуйте ещё раз.');
  });
  player.addEventListener('emptied', () => {
    if (document.fullscreenElement === container) void document.exitFullscreen().catch(() => {});
  });
  if (saved?.url === video.url) {
    cover.hidden = true;
    resumeCourseVideo(player, saved, valid);
  }
  return {
    player,
    restore: () => {
      if (saved?.url !== video.url) return;
      queueCourseVideoRestore(player, video.url, valid);
    },
  };
}
