(() => {
  const page = document.querySelector('#journey');
  if (!page) return;
  const currentWeek = 27;
  const heading = page.querySelector('.journey-week');
  const selected = heading.querySelector('.week-selected');
  const neighbors = [...heading.querySelectorAll('[data-week-offset]')];
  const weeklySections = ['weekly-articles-title', 'videos-title'].map(id => document.getElementById(id).closest('section'));
  const empty = document.createElement('p');
  empty.className = 'journey-week-empty';
  empty.textContent = 'Материалы этой недели пока не добавлены.';
  heading.after(empty);
  const normalize = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 40 ? Number(value) : currentWeek;
  const fromUrl = () => normalize(new URLSearchParams(location.search).get('week'));
  function render(week) {
    page.dataset.week = week;
    document.title = `Мой путь · ${week}-я неделя`;
    heading.setAttribute('aria-label', `${week}-я неделя беременности${week === currentWeek ? ', текущая' : ''}`);
    selected.textContent = `${week} неделя`;
    selected.setAttribute('aria-label', `${week} неделя. Открыть календарь`);
    neighbors.forEach(button => {
      const neighbor = week + Number(button.dataset.weekOffset);
      button.disabled = neighbor < 1 || neighbor > 40;
      button.textContent = button.disabled ? '—' : `${neighbor} неделя`;
    });
    heading.querySelector('.week-prev').disabled = week === 1;
    heading.querySelector('.week-next').disabled = week === 40;
    weeklySections.forEach(section => { section.hidden = week !== currentWeek; });
    empty.hidden = week === currentWeek;
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
    selected.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  heading.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const offset = button.dataset.weekOffset || (button.classList.contains('week-prev') ? -1 : button.classList.contains('week-next') ? 1 : 0);
    if (Number(offset)) select(Number(page.dataset.week) + Number(offset));
  });
  page.querySelectorAll('.content-carousel').forEach(carousel => {
    const list = carousel.querySelector('.article-list, .video-list');
    carousel.querySelectorAll('.round-arrow').forEach(button => {
      button.addEventListener('click', () => {
        const distance = list.firstElementChild.getBoundingClientRect().width + parseFloat(getComputedStyle(list).gap);
        list.scrollBy({ left: distance * (button.classList.contains('carousel-next') ? 1 : -1), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      });
    });
  });
  window.addEventListener('journey:select-week', event => select(event.detail.week));
  window.addEventListener('popstate', () => render(fromUrl()));
  render(fromUrl());
})();
