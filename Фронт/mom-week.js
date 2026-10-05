(() => {
  const library = window.momWeekLibrary;
  const normalize = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 42 ? Number(value) : 27;
  const articleUrl = (week, from) => `article.html?id=mom-week&week=${week}&from=${from}`;
  window.renderMomWeekCard = week => {
    const card = document.querySelector('.article-list .journey-content-card');
    if (!card) return;
    card.querySelector('a').href = articleUrl(week, 'journey');
    card.querySelector('h3').textContent = library[week].title;
    const checkbox = card.querySelector('input');
    window.articleReadState.bindCheckbox(checkbox, `mom-week-${week}`);
    checkbox.setAttribute('aria-label', `Отметить материал о маме на ${week}-й неделе прочитанным`);
  };
  const summary = document.querySelector('.mom-description');
  if (summary) summary.textContent = library[27].paragraphs[0].split(/(?<=[.!?])\s/)[0];
  const panel = document.querySelector('.mom-changes');
  if (!panel) return;
  const select = panel.querySelector('select');
  for (let week = 1; week <= 42; week++) select.add(new Option(`${week} неделя`, week));
  function render(week) {
    const content = library[week];
    select.value = week;
    panel.querySelector('h2').textContent = `Что происходит на ${week}-й неделе`;
    let subtitle = panel.querySelector('.mom-changes-subtitle');
    if (!subtitle) {
      subtitle = document.createElement('h3');
      subtitle.className = 'mom-changes-subtitle';
      panel.querySelector('.section-heading').after(subtitle);
    }
    subtitle.textContent = content.title;
    const copy = panel.querySelector('.mom-changes-copy');
    copy.replaceChildren(...content.paragraphs.map(text => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    }));
    panel.querySelector('.mom-information p').textContent = 'Процессы развиваются постепенно: описанные изменения могут появляться раньше или позже. Все сроки — акушерские.';
    const article = document.querySelector('.mom-week-article');
    article.href = articleUrl(week, 'mom');
    article.querySelector('.article-title').textContent = content.title;
    article.querySelector('.article-meta').lastElementChild.textContent = `≈ ${Math.max(1, Math.ceil(content.paragraphs.join(' ').split(/\s+/).length / 180))} мин`;
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
