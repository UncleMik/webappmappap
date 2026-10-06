(() => {
  const library = window.babyWeekLibrary;
  const currentWeek = 27;
  const normalize = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 42 ? Number(value) : currentWeek;
  const todayCard = document.querySelector('.baby-card');
  if (todayCard) {
    const content = library[currentWeek];
    todayCard.href = `baby.html?week=${currentWeek}`;
    todayCard.querySelector('.baby-measurements').textContent = content.measurements;
    todayCard.querySelector('.baby-description').textContent = content.description;
    const note = document.createElement('span');
    note.className = 'baby-measurement-caption';
    note.textContent = `${content.measurementNote}. Размеры и вес приблизительные.`;
    todayCard.querySelector('.feature-copy').append(note);
  }
  const page = document.querySelector('.baby-page');
  if (!page) return;
  const select = page.querySelector('select');
  for (let week = 1; week <= 42; week++) select.add(new Option(`${week} неделя`, week));
  function render(week) {
    const content = library[week];
    const isCurrent = week === currentWeek;
    select.value = week;
    document.title = `Малыш · ${week}-я неделя`;
    page.querySelector('.eyebrow').textContent = isCurrent ? 'Ваш малыш сейчас' : 'Малыш на выбранной неделе';
    page.querySelector('#baby-overview-title').textContent = isCurrent ? '27 недель и 4 дня' : `${week} неделя`;
    page.querySelector('.overview-meta').hidden = !isCurrent;
    page.querySelector('.baby-week-measurements').textContent = content.measurements;
    page.querySelector('.baby-week-measurements').hidden = !content.measurements;
    page.querySelector('.baby-measurement-note').textContent = content.measurementNote ? `${content.measurementNote}. Размеры и вес приблизительные.` : '';
    page.querySelector('.baby-measurement-note').hidden = !content.measurementNote;
    const comparison = page.querySelector('.baby-size');
    comparison.hidden = !content.comparison;
    const image = page.querySelector('.baby-size-image');
    image.hidden = !content.comparison;
    if (content.comparison) {
      image.src = content.comparisonImage;
      comparison.querySelector('.baby-size-name').textContent = content.comparison;
    } else {
      image.removeAttribute('src');
    }
    page.querySelector('.baby-hero-art').hidden = !isCurrent;
    page.querySelector('#development-title').textContent = `Развитие малыша на ${week}-й неделе`;
    page.querySelector('.baby-development > p').textContent = content.description;
    page.querySelector('.development-link').href = `journey.html?week=${week}`;
    // Existing ultrasound, movements and recommendations are demo data for week 27.
    ['.baby-data', '.baby-movements', '.baby-learn', '.community-card'].forEach(selector => {
      page.querySelector(selector).hidden = !isCurrent;
    });
  }
  select.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('week', select.value);
    history.pushState(null, '', url);
    render(Number(select.value));
  });
  window.addEventListener('popstate', () => render(normalize(new URLSearchParams(location.search).get('week'))));
  render(normalize(new URLSearchParams(location.search).get('week')));
})();
