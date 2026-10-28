(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('id') === 'breathing' && params.get('from') === 'index') {
    document.querySelector('.bottom-navigation').hidden = false;
    document.body.classList.add('breathing-navigation');
  }
  const titles = {
    'back-practice': 'Расслабление спины', breathing: 'Дыхательная практика',
    'practice-article': 'Расслабление тазового дна', 'birth-course': 'Подготовка к родам',
    'back-course': 'Здоровая спина', 'confidence-course': 'Эмоциональная уверенность',
    'baby-course': 'Уход за малышом', 'baby-birth-lesson': 'Как малыш проходит через родовые пути', 'contractions-lesson': 'Дыхание во время схваток',
    'birth-breathing-video': 'Дыхание в родах', 'back-relief-video': 'Как снять напряжение в спине',
    webinars: 'Запись вебинара'
  };
  const id = Object.hasOwn(titles, params.get('id')) ? params.get('id') : null;
  const origins = { index: 'index.html', mom: 'mom.html', baby: 'baby.html', journey: 'journey.html', 'my-courses': 'my-courses.html', club: 'club.html#events', articles: 'journey.html' };
  const revealPlayer = () => document.querySelector('.video-app').removeAttribute('data-video-pending');
  document.querySelector('.video-back').href = Object.hasOwn(origins, params.get('from')) ? origins[params.get('from')] : 'mom.html';
  if (params.get('from') === 'journey') {
    const week = Number(params.get('week'));
    document.querySelector('.video-back').href = `journey.html?week=${Number.isInteger(week) && week >= 1 && week <= 42 ? week : 27}#videos-title`;
  }
  if (!['contractions-lesson', 'back-relief-video', 'birth-breathing-video'].includes(id)) {
    import('./school-video-routes.js?v=20261028-free-breathing').then(module => {
      module.mountSchoolVideo(id);
    }).catch(() => {
      document.querySelector('.video-stage').hidden = true;
      document.querySelector('.video-panel').hidden = true;
      const message = document.createElement('p');
      message.setAttribute('role', 'status');
      message.textContent = 'Не удалось загрузить видео. Обновите страницу.';
      document.querySelector('main').append(message);
      revealPlayer();
    });
    return;
  }
  const favorite = document.querySelector('.video-favorite');
  const personal = window.personalDataApi;
  function setFavorite(value) {
    favorite.setAttribute('aria-pressed', String(value));
    favorite.setAttribute('aria-label', value ? 'Удалить из избранного' : 'Добавить в избранное');
  }
  favorite.disabled = true;
  personal.subscribe(data => { setFavorite(data.favorites.includes(id)); favorite.disabled = !personal.isLoaded(); });
  personal.load().catch(() => {
    favorite.disabled = true;
    const status = document.querySelector('#player-status');
    status.hidden = false; status.textContent = 'Не удалось загрузить избранное. Обновите страницу.';
  });
  favorite.addEventListener('click', async () => {
    const value = favorite.getAttribute('aria-pressed') !== 'true';
    favorite.disabled = true;
    try { await personal.write({ operation: 'setFavorite', id, favorite: value }); }
    catch (failure) {
      const status = document.querySelector('#player-status');
      status.hidden = false; status.textContent = failure.message;
    } finally { favorite.disabled = false; }
  });

  // Reveal only the selected lesson's image after it has loaded. An eager demo
  // image can otherwise stay painted while the weekly cover is downloading.
  const coverImage = document.querySelector('.video-cover > img');
  coverImage.addEventListener('load', () => {
    const stage = document.querySelector('.video-stage');
    if (coverImage.closest('.weekly-cover') && !stage.querySelector('video')?.videoWidth
        && coverImage.naturalWidth > 0 && coverImage.naturalHeight > 0) {
      stage.style.setProperty('--video-aspect-ratio', `${coverImage.naturalWidth} / ${coverImage.naturalHeight}`);
    }
    coverImage.hidden = false;
  });
  coverImage.addEventListener('error', () => { coverImage.hidden = true; });
  const weeklyIds = ['contractions-lesson', 'back-relief-video', 'birth-breathing-video'];
  if (weeklyIds.includes(id)) {
    import('./weekly-video-player.js?v=20261020-initial-content').then(module => {
      module.mountWeeklyVideo(id);
      revealPlayer();
    }).catch(() => {
      const status = document.querySelector('#player-status'); status.hidden = false;
      status.textContent = 'Не удалось загрузить плеер. Обновите страницу.';
      document.querySelector('.video-cover').disabled = true;
      document.querySelector('#video-play').disabled = true;
      document.querySelector('#video-next').disabled = true;
      revealPlayer();
    });
    return;
  }

})();
