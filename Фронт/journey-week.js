(() => {
  const page = document.querySelector('#journey');
  if (!page) return;
  const currentWeek = 27;
  const heading = page.querySelector('.journey-week');
  const wheel = heading.querySelector('.week-wheel');
  const dots = heading.querySelector('.week-dots');
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const options = Array.from({ length: 42 }, (_, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'week-option';
    button.dataset.week = index + 1;
    button.dataset.action = 'calendar';
    button.textContent = `${index + 1} неделя`;
    wheel.append(button);
    return button;
  });
  const weeklySections = ['weekly-articles-title', 'videos-title'].map(id => document.getElementById(id).closest('section'));
  const normalize = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 42 ? Number(value) : currentWeek;
  const fromUrl = () => normalize(new URLSearchParams(location.search).get('week'));
  let settleTimer, animationFrame, scrollingTo = null;
  function paintWheel() {
    const center = wheel.getBoundingClientRect().left + wheel.clientWidth / 2;
    options.forEach(button => {
      const distance = (button.getBoundingClientRect().left + button.offsetWidth / 2 - center) / button.offsetWidth;
      const proximity = Math.max(0, 1 - Math.abs(distance));
      button.style.setProperty('--scale', .82 + proximity * .18);
      button.style.setProperty('--opacity', .55 + proximity * .45);
      button.style.setProperty('--turn', `${Math.max(-25, Math.min(25, distance * -18))}deg`);
    });
    animationFrame = null;
  }
  function align(week, smooth) {
    scrollingTo = week;
    const button = options[week - 1];
    wheel.scrollTo({ left: button.offsetLeft - options[0].offsetLeft, behavior: smooth && !reducedMotion() ? 'smooth' : 'instant' });
    paintWheel();
  }
  function render(week) {
    page.dataset.week = week;
    document.title = `Мой путь · ${week}-я неделя`;
    heading.setAttribute('aria-label', `${week}-я неделя беременности${week === currentWeek ? ', текущая' : ''}`);
    options.forEach(button => {
      const selected = Number(button.dataset.week) === week;
      button.classList.toggle('week-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', selected ? `${week} неделя. Открыть календарь` : `${button.dataset.week} неделя`);
    });
    heading.querySelector('.week-prev').disabled = week === 1;
    heading.querySelector('.week-next').disabled = week === 42;
    const stage = week <= 14 ? 0 : week <= 28 ? 1 : 2;
    [...dots.children].forEach((dot, index) => dot.classList.toggle('active', index === stage));
    dots.setAttribute('aria-label', ['1–14 недели', '15–28 недели', '29–42 недели'][stage]);
    weeklySections[0].hidden = false;
    weeklySections[1].hidden = week !== currentWeek;
    window.renderPregnancyWeekArticles(weeklySections[0].querySelector('.article-list'), week);
    weeklySections[0].querySelector('p').textContent = '3 статьи, которые помогут сейчас';
  }
  function select(week, smooth = true) {
    week = normalize(week);
    if (week !== Number(page.dataset.week)) {
      const url = new URL(location.href);
      url.searchParams.set('week', week);
      url.hash = '';
      history.pushState(null, '', url);
    }
    render(week);
    align(week, smooth);
  }
  heading.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.week) {
      if (Number(button.dataset.week) !== Number(page.dataset.week)) select(Number(button.dataset.week));
    } else {
      select(Number(page.dataset.week) + (button.classList.contains('week-prev') ? -1 : 1));
    }
  });
  wheel.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const week = event.key === 'Home' ? 1 : event.key === 'End' ? 42 : Math.max(1, Math.min(42, Number(page.dataset.week) + (event.key === 'ArrowRight' ? 1 : -1)));
    select(week);
    options[week - 1].focus({ preventScroll: true });
  });
  wheel.addEventListener('scroll', () => {
    if (!animationFrame) animationFrame = requestAnimationFrame(paintWheel);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const distance = button => Math.abs(button.offsetLeft - options[0].offsetLeft - wheel.scrollLeft);
      const closest = options.reduce((best, button) => distance(button) < distance(best) ? button : best);
      const week = Number(closest.dataset.week);
      if (scrollingTo && week !== scrollingTo) return;
      scrollingTo = null;
      if (week !== Number(page.dataset.week)) select(week, false);
    }, 140);
  }, { passive: true });
  wheel.addEventListener('pointerdown', () => { scrollingTo = null; });
  wheel.addEventListener('wheel', () => { scrollingTo = null; }, { passive: true });
  let mouseDrag = null, suppressClick = false;
  wheel.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    mouseDrag = { x: event.clientX, left: wheel.scrollLeft, id: event.pointerId, moved: false };
  });
  wheel.addEventListener('pointermove', event => {
    if (!mouseDrag) return;
    const delta = event.clientX - mouseDrag.x;
    if (!mouseDrag.moved && Math.abs(delta) < 5) return;
    mouseDrag.moved = true;
    wheel.setPointerCapture(mouseDrag.id);
    wheel.style.scrollSnapType = 'none';
    wheel.scrollLeft = mouseDrag.left - delta;
  });
  function finishDrag() {
    if (!mouseDrag) return;
    suppressClick = mouseDrag.moved;
    if (wheel.hasPointerCapture(mouseDrag.id)) wheel.releasePointerCapture(mouseDrag.id);
    wheel.style.removeProperty('scroll-snap-type');
    mouseDrag = null;
    setTimeout(() => { suppressClick = false; }, 0);
  }
  wheel.addEventListener('pointerup', finishDrag);
  wheel.addEventListener('pointercancel', finishDrag);
  wheel.addEventListener('click', event => {
    if (suppressClick) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  page.querySelectorAll('.content-carousel').forEach(carousel => {
    const list = carousel.querySelector('.article-list, .video-list, .course-list');
    carousel.querySelectorAll('.round-arrow').forEach(button => {
      button.addEventListener('click', () => {
        const distance = list.firstElementChild.getBoundingClientRect().width + parseFloat(getComputedStyle(list).gap);
        list.scrollBy({ left: distance * (button.classList.contains('carousel-next') ? 1 : -1), behavior: reducedMotion() ? 'instant' : 'smooth' });
      });
    });
  });
  window.addEventListener('journey:select-week', event => select(event.detail.week));
  window.addEventListener('popstate', () => { render(fromUrl()); align(fromUrl(), false); });
  window.addEventListener('resize', () => align(Number(page.dataset.week), false));
  render(fromUrl());
  requestAnimationFrame(() => align(fromUrl(), false));
})();
