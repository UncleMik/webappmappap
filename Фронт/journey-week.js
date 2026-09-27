(() => {
  const page = document.querySelector('#journey');
  if (!page) return;
  const currentWeek = 27;
  const heading = page.querySelector('.journey-week');
  const grid = page.querySelector('.journey-weeks-grid');
  const templates = [...grid.children].map(card => card.cloneNode(true));
  const weeklySections = ['continue-title', 'weekly-articles-title', 'videos-title'].map(id => document.getElementById(id).closest('section'));
  const empty = document.createElement('p');
  empty.className = 'journey-week-empty';
  empty.textContent = 'Материалы этой недели пока не добавлены.';
  empty.hidden = true;
  heading.after(empty);
  const dateFormat = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const normalize = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 40 ? Number(value) : currentWeek;
  const fromUrl = () => normalize(new URLSearchParams(location.search).get('week'));
  function dates(week) {
    const start = Date.UTC(2026, 8, 8 + (week - currentWeek) * 7);
    return `${dateFormat.format(start)} — ${dateFormat.format(start + 6 * 86400000)}`;
  }
  function render(week) {
    page.dataset.week = week;
    document.title = `Мой путь · ${week}-я неделя`;
    heading.setAttribute('aria-label', `${week}-я неделя беременности${week === currentWeek ? ', текущая' : ''}`);
    heading.querySelector('h2').textContent = `${week}-я неделя беременности`;
    heading.querySelector('p').textContent = dates(week);
    weeklySections.forEach(section => { section.hidden = week !== currentWeek; });
    empty.hidden = week === currentWeek;
    grid.replaceChildren();
    [week - 1, week + 1].forEach((neighbor, index) => {
      if (neighbor < 1 || neighbor > 40) return;
      const card = templates[index].cloneNode(true);
      card.dataset.action = `week-${neighbor}`;
      card.querySelector('.week-title strong').textContent = `${neighbor}-я неделя`;
      card.querySelector('.week-title > span').textContent = dates(neighbor);
      card.setAttribute('aria-label', `Открыть ${neighbor}-ю неделю`);
      const detail = card.querySelector('.week-completed, .week-focus');
      if (neighbor !== 26 && neighbor !== 28) {
        detail.className = 'week-focus';
        detail.textContent = neighbor === currentWeek ? 'Ваша текущая неделя' : 'Открыть неделю';
      } else if (neighbor === 26) {
        detail.className = 'week-completed';
        detail.textContent = '3 из 3 выполнено';
      } else {
        detail.className = 'week-focus';
        detail.textContent = 'Фокус недели: комфорт тела и профилактика отеков.';
      }
      grid.append(card);
    });
  }
  function select(week) {
    week = normalize(week);
    if (week !== Number(page.dataset.week)) {
      const url = new URL(location.href);
      url.searchParams.set('week', week);
      url.hash = '';
      history.pushState(null, '', url);
    }
    render(week);
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  grid.addEventListener('click', event => {
    const card = event.target.closest('[data-action^="week-"]');
    if (card) select(Number(card.dataset.action.slice(5)));
  });
  window.addEventListener('journey:select-week', event => select(event.detail.week));
  window.addEventListener('popstate', () => render(fromUrl()));
  render(fromUrl());
})();
