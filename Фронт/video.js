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
  const requestedId = params.get('id');
  const weeklyItem = window.webprilWeeklyVideos?.find(item => item.id === requestedId);
  const id = weeklyItem?.id ?? (Object.hasOwn(titles, requestedId) ? requestedId : null);
  const origins = { index: 'index.html', mom: 'mom.html', baby: 'baby.html', journey: 'journey.html', 'my-courses': 'my-courses.html', club: 'club.html#events', articles: 'journey.html', favorites: 'favorites.html' };
  const revealPlayer = () => document.querySelector('.video-app').removeAttribute('data-video-pending');
  document.querySelector('.video-back').href = Object.hasOwn(origins, params.get('from')) ? origins[params.get('from')] : 'mom.html';
  if (params.get('from') === 'journey') {
    const week = Number(params.get('week'));
    document.querySelector('.video-back').href = `journey.html?week=${Number.isInteger(week) && week >= 1 && week <= 42 ? week : weeklyItem?.week ?? 27}#videos-title`;
  }
  if (!weeklyItem) {
    import('./school-video-routes.js?v=20261110-favorites').then(module => module.mountSchoolVideo(id)).catch(() => {
      document.querySelector('.video-stage').hidden = true;
      document.querySelector('.video-panel').hidden = true;
      document.querySelector('.video-header p').hidden = true;
      document.querySelector('.video-favorite').remove();
      const message = document.createElement('p');
      message.setAttribute('role', 'status');
      message.textContent = 'Не удалось загрузить видео. Обновите страницу.';
      document.querySelector('main').append(message);
      revealPlayer();
    });
    return;
  }
  window.bindFavoriteButton(document.querySelector('.video-favorite'), document.querySelector('.favorite-status'))({ id });

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
  import('./weekly-video-player.js?v=20261110-access-note').then(module => {
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

})();
