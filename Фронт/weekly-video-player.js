import { authRequest } from './auth-client.js';

export function mountWeeklyVideo(id) {
  const items = window.webprilWeeklyVideos;
  const index = items.findIndex(item => item.id === id), item = items[index];
  const stage = document.querySelector('.video-stage'), cover = document.querySelector('.video-cover');
  const status = document.querySelector('#player-status'), progress = document.querySelector('#video-progress');
  const play = document.querySelector('#video-play'), previous = document.querySelector('#video-prev'), next = document.querySelector('#video-next');
  const video = document.createElement('video');
  video.id = 'weekly-video'; video.playsInline = true; video.preload = 'none'; video.hidden = true;
  video.setAttribute('aria-label', item.title);
  document.querySelector('#youtube-player').replaceWith(video);
  document.title = item.title;
  document.querySelector('#video-title').textContent = item.title;
  document.querySelector('#video-duration').textContent = item.label;
  document.querySelector('.step-count').textContent = `${index + 1} из ${items.length}`;
  document.querySelector('#step-title').textContent = item.title;
  const description = document.querySelector('.step-description');
  description.textContent = item.description;
  description.classList.add('weekly-video-description');
  // The source description belongs above the video, including on narrow screens.
  stage.before(description);
  document.querySelector('.video-note p').textContent = 'Три видео школы доступны бесплатно после входа.';
  document.querySelector('.video-note').hidden = false;
  cover.classList.add('weekly-cover');
  cover.querySelector('img').src = item.image;
  cover.querySelector('img').alt = item.title;
  video.poster = item.image;
  cover.setAttribute('aria-label', 'Включить видео');
  previous.disabled = index === 0; next.disabled = index === items.length - 1;
  previous.setAttribute('aria-label', 'Предыдущее видео недели');
  next.setAttribute('aria-label', 'Следующее видео недели');
  const summary = document.querySelector('.video-chapters summary');
  summary.textContent = 'Видео на эту неделю ';
  const count = document.createElement('span'); count.textContent = items.length; summary.append(count);
  const list = document.querySelector('#chapter-list');
  const go = target => {
    if (target < 0 || target >= items.length || target === index) return;
    video.pause();
    const url = new URL(location.href); url.searchParams.set('id', items[target].id); location.href = url.href;
  };
  items.forEach((entry, n) => {
    const li = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.textContent = `${n + 1}. ${entry.title}`;
    button.setAttribute('aria-current', String(n === index)); button.addEventListener('click', () => go(n));
    li.append(button); list.append(li);
  });
  const timestampButtons = [];
  if (item.chapters.length) {
    const timestamps = document.createElement('details');
    timestamps.className = 'video-chapters video-timestamps'; timestamps.open = true;
    const heading = document.createElement('summary'); heading.textContent = 'Таймкоды ';
    const amount = document.createElement('span'); amount.textContent = item.chapters.length; heading.append(amount);
    const chapters = document.createElement('ol');
    item.chapters.forEach(chapter => {
      const li = document.createElement('li'), button = document.createElement('button');
      const stamp = document.createElement('time'), label = document.createElement('span');
      stamp.dateTime = `PT${chapter.seconds}S`;
      stamp.textContent = `${String(Math.floor(chapter.seconds / 60)).padStart(2, '0')}:${String(chapter.seconds % 60).padStart(2, '0')}`;
      label.textContent = chapter.label; button.type = 'button';
      button.append(stamp, label); button.addEventListener('click', () => start(chapter.seconds));
      timestampButtons.push(button); li.append(button); chapters.append(li);
    });
    timestamps.append(heading, chapters); document.querySelector('.video-chapters').before(timestamps);
  }
  const login = document.createElement('a');
  login.className = 'video-login'; login.textContent = 'Войти и смотреть бесплатно'; login.hidden = true;
  const target = new URL('login.html', location.href);
  if (location.hostname === 'unclemik.github.io') target.href = 'https://app.legkie-rody.ru/login.html';
  target.searchParams.set('next', `video.html${location.search}`); login.href = target.href;
  status.after(login);
  let busy = false, failed = false, pending = false, requestedTime = null, timer;
  const time = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  function message(text) { status.textContent = text; status.hidden = !text; }
  function playing(value) {
    play.setAttribute('aria-label', value ? 'Пауза' : 'Воспроизвести видео');
    document.querySelector('#play-icon').setAttribute('d', value ? 'M5 4h5v16H5zm9 0h5v16h-5z' : 'm8 4 13 8-13 8Z');
  }
  function update() {
    const duration = Number.isFinite(video.duration) ? video.duration : item.duration;
    progress.max = duration; progress.value = video.currentTime;
    progress.style.setProperty('--progress', `${video.currentTime / duration * 100}%`);
    progress.setAttribute('aria-valuetext', `${time(video.currentTime)} из ${time(duration)}`);
    document.querySelector('#video-time').value = time(Math.max(0, duration - video.currentTime));
  }
  function signIn() {
    requestedTime = null; timestampButtons.forEach(button => { button.disabled = true; });
    pending = false; clearTimeout(timer); video.pause(); video.removeAttribute('src'); video.load();
    video.hidden = true; progress.disabled = true; cover.hidden = false; cover.disabled = true;
    cover.querySelector('.cover-label').textContent = 'Войдите для просмотра';
    play.disabled = true; login.hidden = false;
    message('Войдите, чтобы посмотреть бесплатное видео.');
  }
  function error(text = 'Не удалось загрузить видео. Проверьте интернет и попробуйте ещё раз.') {
    pending = false; clearTimeout(timer); video.pause(); failed = true;
    cover.hidden = false; message(text);
    cover.querySelector('.cover-label').textContent = 'Попробовать ещё раз';
    cover.setAttribute('aria-label', 'Повторить загрузку видео');
  }
  function applyRequestedTime() {
    if (requestedTime === null || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.max(0, Math.min(requestedTime, video.duration - .1));
    requestedTime = null; update();
  }
  async function start(position = null) {
    if (Number.isFinite(position)) requestedTime = position;
    if (busy) return;
    if (position === null && !video.paused) { video.pause(); return; }
    busy = true; login.hidden = true; message('Загружаем видео…');
    try {
      const result = await authRequest(`videos/${id}`);
      const source = new URL(result.source);
      if (source.protocol !== 'https:' || !/^fs\d*\.getcourse\.ru$/.test(source.hostname)) throw new Error('Некорректный адрес видео.');
      if (!video.getAttribute('src') || failed) { video.src = source.href; failed = false; }
      pending = true; clearTimeout(timer); timer = setTimeout(() => { if (pending) error(); }, 30000);
      cover.hidden = true; video.hidden = false;
      applyRequestedTime();
      await video.play();
      applyRequestedTime();
    } catch (failure) {
      if (failure.code === 'onboarding_required') {
        const onboarding = new URL('onboarding.html', location.href);
        onboarding.searchParams.set('next', `video.html${location.search}`);
        window.top.location.assign(onboarding.href);
      } else if (failure.code === 'sign_in_required') signIn();
      else if (failure.name === 'NotAllowedError') { pending = false; clearTimeout(timer); cover.hidden = false; message('Нажмите «Смотреть видео», чтобы начать.'); }
      else error(failure.code ? failure.message : undefined);
    } finally { busy = false; }
  }
  video.addEventListener('loadedmetadata', () => {
    progress.disabled = false;
    document.querySelector('#video-duration').textContent = time(Math.ceil(video.duration)); applyRequestedTime(); update();
  });
  video.addEventListener('playing', () => { pending = false; clearTimeout(timer); message(''); playing(true); });
  video.addEventListener('pause', () => playing(false));
  video.addEventListener('timeupdate', update);
  video.addEventListener('error', () => { if (video.getAttribute('src')) error(); });
  video.addEventListener('ended', () => {
    if (index < items.length - 1) go(index + 1);
    else message('Все видео этой недели завершены. Можно вернуться к материалам недели или посмотреть видео ещё раз.');
  });
  progress.addEventListener('input', () => { if (Number.isFinite(video.duration)) video.currentTime = Number(progress.value); update(); });
  previous.addEventListener('click', () => go(index - 1)); next.addEventListener('click', () => go(index + 1));
  play.addEventListener('click', () => start()); cover.addEventListener('click', () => start());
  // The server also checks the session when issuing every file address.
  async function checkSession() {
    if (document.hidden) return;
    if (location.hostname === 'unclemik.github.io') { signIn(); return; }
    try {
      const session = await authRequest('session');
      if (!session.authenticated) signIn();
      else { login.hidden = true; play.disabled = false; cover.disabled = false;
        timestampButtons.forEach(button => { button.disabled = false; });
        if (!video.getAttribute('src')) { cover.hidden = false; cover.querySelector('.cover-label').textContent = 'Смотреть видео'; message(''); } }
    } catch { if (!video.paused) { video.pause(); message('Не удалось проверить вход. Попробуйте включить видео ещё раз.'); } }
  }
  update(); checkSession();
  let sessionTimer;
  function resumeChecks() { if (sessionTimer === undefined) sessionTimer = setInterval(checkSession, 30000); checkSession(); }
  resumeChecks();
  document.addEventListener('visibilitychange', checkSession);
  addEventListener('pageshow', resumeChecks);
  addEventListener('pagehide', () => { clearTimeout(timer); clearInterval(sessionTimer); sessionTimer = undefined; video.pause(); });
}
