(() => {
  const api = window.personalDataApi;
  const main = document.querySelector('.favorites-list');
  const status = main.querySelector('.favorites-status');
  const groups = main.querySelector('.favorites-groups');
  if (new URLSearchParams(location.search).get('from') === 'mom') document.querySelector('.reader-back').href = 'mom.html';
  const legacyVideos = {
    'back-practice': 'Расслабление спины',
    breathing: 'Дыхательная практика',
    'practice-article': 'Расслабление тазового дна',
    'birth-course': 'Подготовка к родам',
    'back-course': 'Здоровая спина',
    'confidence-course': 'Эмоциональная уверенность',
    'baby-course': 'Уход за малышом',
    'baby-birth-lesson': 'Как малыш проходит через родовые пути',
    webinars: 'Запись вебинара',
  };
  const weeklyTitles = new Map(window.webprilWeeklyVideos.map(video => [video.id, video.title]));

  function materialLink(id) {
    const course = /^course:([1-9][0-9]*):([1-9][0-9]*):([a-f0-9]{64})$/.exec(id);
    if (course) return { type: 'Видео', href: 'article.html?' + new URLSearchParams({
      course: course[1], courseLesson: course[2], video: course[3], from: 'favorites',
    }), fallback: 'Видео урока' };
    if (id.startsWith('article:')) return { type: 'Статьи',
      href: 'article.html?' + new URLSearchParams({ id: id.slice(8), from: 'favorites' }), fallback: 'Статья' };
    if (/^mom-week:[1-9][0-9]?$/.test(id)) return { type: 'Статьи', href: 'article.html?' +
      new URLSearchParams({ id: 'mom-week', week: id.split(':')[1], from: 'favorites' }), fallback: 'Состояние мамы' };
    return { type: 'Видео', href: 'video.html?' + new URLSearchParams({ id, from: 'favorites' }),
      fallback: weeklyTitles.get(id) || (Object.hasOwn(legacyVideos, id) ? legacyVideos[id] : 'Видео') };
  }

  function render(data) {
    groups.replaceChildren();
    if (!api.isLoaded()) {
      main.setAttribute('aria-busy', 'true');
      status.textContent = 'Загружаем избранное…';
      return;
    }
    main.removeAttribute('aria-busy');
    status.textContent = data.favorites.length ? '' : 'В избранном пока ничего нет. Нажмите сердечко в видео или статье, чтобы сохранить материал.';
    const lists = new Map([['Видео', []], ['Статьи', []]]);
    for (const id of data.favorites) {
      const item = materialLink(id);
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = item.href;
      link.textContent = Object.hasOwn(data.favoriteTitles ?? {}, id) ? data.favoriteTitles[id] : item.fallback;
      row.append(link);
      lists.get(item.type).push(row);
    }
    for (const [label, rows] of lists) {
      if (!rows.length) continue;
      const section = document.createElement('section');
      const heading = document.createElement('h2');
      heading.textContent = label;
      const list = document.createElement('ul');
      list.append(...rows);
      section.append(heading, list);
      groups.append(section);
    }
  }

  function load() {
    api.load().catch(() => {
      main.removeAttribute('aria-busy');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Повторить';
      retry.addEventListener('click', () => { render(api.get()); load(); });
      status.replaceChildren('Не удалось загрузить избранное.', retry);
    });
  }
  api.subscribe(render);
  load();
})();
