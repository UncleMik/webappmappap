(() => {
  const params = new URLSearchParams(location.search);
  const titles = {
    'back-practice': 'Расслабление спины', breathing: 'Дыхательная практика',
    'practice-article': 'Расслабление тазового дна', 'birth-course': 'Подготовка к родам',
    'back-course': 'Здоровая спина', 'confidence-course': 'Эмоциональная уверенность',
    'baby-course': 'Уход за малышом', 'baby-birth-lesson': 'Как малыш проходит через родовые пути', 'contractions-lesson': 'Дыхание во время схваток',
    'birth-breathing-video': 'Дыхание в родах', 'back-relief-video': 'Как снять напряжение в спине',
    webinars: 'Запись вебинара'
  };
  const id = Object.hasOwn(titles, params.get('id')) ? params.get('id') : 'back-practice';
  const origins = { index: 'index.html', mom: 'mom.html', baby: 'baby.html', journey: 'journey.html', 'my-courses': 'my-courses.html', club: 'club.html#events', articles: 'articles.html' };
  document.title = titles[id];
  document.querySelector('#video-title').textContent = titles[id];
  document.querySelector('.video-back').href = Object.hasOwn(origins, params.get('from')) ? origins[params.get('from')] : 'mom.html';
  const favorite = document.querySelector('.video-favorite');
  const favoriteKey = `webpril.videoFavorite.${id}`;
  function setFavorite(value) {
    favorite.setAttribute('aria-pressed', String(value));
    favorite.setAttribute('aria-label', value ? 'Удалить из избранного' : 'Добавить в избранное');
  }
  try { setFavorite(localStorage.getItem(favoriteKey) === 'true'); } catch { /* Optional persistence. */ }
  favorite.addEventListener('click', () => {
    const value = favorite.getAttribute('aria-pressed') !== 'true';
    setFavorite(value);
    try { localStorage.setItem(favoriteKey, String(value)); } catch { /* Keep the current session usable. */ }
  });

  const chapters = [
    ['Устройтесь удобно', 'Выберите удобное место и включите видео. Можно смотреть в своём темпе и переключаться между разделами.'],
    ['В своём темпе', 'Второй раздел демонстрационного видео. Поставьте просмотр на паузу в любой момент.'],
    ['Продолжим вместе', 'Вы в середине просмотра. Полоска прогресса поможет вернуться к любому моменту.'],
    ['Ещё немного времени', 'Четвёртый раздел видео. Переключайтесь стрелками или выберите нужный раздел в списке ниже.'],
    ['Завершение', 'Последний раздел. Можно вернуться к началу или закончить просмотр и продолжить свой день.']
  ];
  const progress = document.querySelector('#video-progress');
  const play = document.querySelector('#video-play');
  const previous = document.querySelector('#video-prev');
  const next = document.querySelector('#video-next');
  const cover = document.querySelector('.video-cover');
  const status = document.querySelector('#player-status');
  let player, ready = false, started = false, failed = false, current = 0, duration = 0, pendingChapter = 0, timer;
  const time = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  const list = document.querySelector('#chapter-list');
  chapters.forEach(([title], index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${index + 1}. ${title}`;
    button.addEventListener('click', () => selectChapter(index));
    item.append(button);
    list.append(item);
  });
  function renderChapter(index) {
    current = index;
    document.querySelector('.step-count').textContent = `${index + 1} из ${chapters.length}`;
    document.querySelector('#step-title').textContent = chapters[index][0];
    document.querySelector('.step-description').textContent = chapters[index][1];
    previous.disabled = index === 0;
    next.disabled = index === chapters.length - 1;
    list.querySelectorAll('button').forEach((button, i) => button.setAttribute('aria-current', String(i === index)));
  }
  function selectChapter(index) {
    pendingChapter = Math.max(0, Math.min(chapters.length - 1, index));
    renderChapter(pendingChapter);
    if (ready && duration) {
      player.seekTo(duration * pendingChapter / chapters.length, true);
      updateTimeline(duration * pendingChapter / chapters.length);
    }
  }
  function updateTimeline(position) {
    progress.value = position;
    progress.style.setProperty('--progress', `${duration ? position / duration * 100 : 0}%`);
    document.querySelector('#video-time').value = time(Math.max(0, duration - position));
    progress.setAttribute('aria-valuetext', `${time(position)} из ${time(duration)}`);
  }
  function setPlaying(playing) {
    play.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести видео');
    document.querySelector('#play-icon').setAttribute('d', playing ? 'M5 4h5v16H5zm9 0h5v16h-5z' : 'm8 4 13 8-13 8Z');
  }
  function showError() {
    failed = true;
    ready = false;
    clearTimeout(timer);
    setPlaying(false);
    progress.disabled = true;
    status.hidden = false;
    status.textContent = 'Не удалось загрузить YouTube. Попробуйте ещё раз или откройте видео по ссылке ниже.';
    cover.hidden = false;
    document.querySelector('.cover-label').textContent = 'Попробовать ещё раз';
    cover.setAttribute('aria-label', 'Повторить загрузку видео');
  }
  function start() {
    if (ready) {
      started = true;
      cover.hidden = true;
      player.getPlayerState() === 1 ? player.pauseVideo() : player.playVideo();
      return;
    }
    if (started && !failed) return;
    started = true;
    failed = false;
    status.hidden = false;
    status.textContent = 'Загружаем видео…';
    clearTimeout(timer);
    timer = setTimeout(showError, 15000);
    if (window.YT?.Player) createPlayer();
    else {
      document.querySelector('#youtube-api')?.remove();
      const script = document.createElement('script');
      script.id = 'youtube-api';
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = showError;
      document.head.append(script);
    }
  }
  function createPlayer() {
    if (failed) return;
    if (player) player.destroy();
    player = new YT.Player('youtube-player', {
      host: 'https://www.youtube-nocookie.com', videoId: 'aqz-KE-bpKQ',
      playerVars: { playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady(event) {
          clearTimeout(timer);
          ready = true;
          failed = false;
          status.hidden = true;
          cover.hidden = true;
          event.target.getIframe().title = 'Демонстрационное видео — Big Buck Bunny';
          duration = event.target.getDuration();
          if (duration) {
            progress.max = duration;
            progress.disabled = false;
            document.querySelector('#video-duration').textContent = `${Math.ceil(duration / 60)} минут · демо`;
            selectChapter(pendingChapter);
          }
          event.target.playVideo();
        },
        onStateChange(event) {
          setPlaying(event.data === 1);
          if (event.data === 0) { updateTimeline(duration); renderChapter(chapters.length - 1); }
        },
        onError: showError
      }
    });
  }
  window.onYouTubeIframeAPIReady = createPlayer;
  setInterval(() => {
    if (!ready || !player?.getCurrentTime) return;
    if (!duration) {
      duration = player.getDuration();
      if (!duration) return;
      progress.max = duration;
      progress.disabled = false;
      document.querySelector('#video-duration').textContent = `${Math.ceil(duration / 60)} минут · демо`;
      selectChapter(pendingChapter);
    }
    if (player.getPlayerState() !== 1) return;
    const position = player.getCurrentTime();
    updateTimeline(position);
    const index = Math.min(chapters.length - 1, Math.floor(position / duration * chapters.length));
    if (index !== current) renderChapter(index);
  }, 400);
  progress.addEventListener('input', () => {
    if (!ready) return;
    const position = Number(progress.value);
    player.seekTo(position, true);
    updateTimeline(position);
    renderChapter(Math.min(chapters.length - 1, Math.floor(position / duration * chapters.length)));
  });
  previous.addEventListener('click', () => selectChapter(current - 1));
  next.addEventListener('click', () => selectChapter(current + 1));
  play.addEventListener('click', start);
  cover.addEventListener('click', start);
  renderChapter(0);
})();
