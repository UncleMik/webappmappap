const scroller = document.querySelector('.reader-scroll');
const params = new URLSearchParams(location.search);
const library = window.articleLibrary;
const requestedWeek = Number(params.get('week'));
const momWeek = Number.isInteger(requestedWeek) && requestedWeek >= 1 && requestedWeek <= 42 ? requestedWeek : 27;
if (params.get('id') === 'mom-week') {
  const content = window.momWeekLibrary[momWeek];
  library['mom-week'] = { title: content.title, type: `${momWeek} неделя · Состояние мамы`, minutes: Math.max(1, Math.ceil(content.paragraphs.join(' ').split(/\s+/).length / 180)), intro: content.paragraphs[0], headings: content.paragraphs.slice(1).map(() => 'Что происходит'), paragraphs: content.paragraphs.slice(1), supplied: true };
}
const articleId = Object.hasOwn(library, params.get('id')) ? params.get('id') : 'dating';
const article = library[articleId];
const escapeText = text => text.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
if (article.pregnancy) {
  const finish = scroller.querySelector('.reader-finish').cloneNode(true);
  finish.querySelector('p').textContent = 'Вы дочитали статью. Можно перейти к следующему материалу или вернуться к подборке.';
  scroller.replaceChildren();
  let section = document.createElement('section');
  section.className = 'reader-section reader-intro';
  section.innerHTML = `<div><span class="reader-week">${escapeText(article.type)}</span><h1>${escapeText(article.title)}</h1><p class="reader-reading-time">≈ ${article.minutes} мин на чтение</p></div>`;
  scroller.append(section);
  let list = null;
  article.blocks.forEach(block => {
    if (block.type === 'heading') {
      section = document.createElement('section');
      section.className = 'reader-section';
      const heading = document.createElement('h2');
      heading.textContent = block.text;
      section.append(heading);
      scroller.append(section);
      list = null;
    } else if (block.type === 'list-item') {
      if (!list) { list = document.createElement('ul'); section.append(list); }
      const item = document.createElement('li');
      item.textContent = block.text;
      list.append(item);
    } else {
      list = null;
      const paragraph = document.createElement('p');
      paragraph.textContent = block.text;
      section.append(paragraph);
    }
  });
  scroller.append(finish);
  document.querySelector('.reader-toolbar > span').textContent = article.type;
} else if (articleId !== 'dating') {
  const finish = scroller.querySelector('.reader-finish').cloneNode(true);
  finish.querySelector('p').textContent = 'Процессы развиваются постепенно: описанные изменения могут появляться раньше или позже. Все сроки — акушерские.';
  scroller.innerHTML = `<section class="reader-section reader-intro"><div><span class="reader-week">${escapeText(article.type || '27 неделя')}</span><h1>${escapeText(article.title)}</h1><p>${escapeText(article.intro)}</p></div><p class="reader-reading-time">≈ ${article.minutes} мин на чтение</p></section>`;
  article.headings.forEach((heading, index) => {
    scroller.insertAdjacentHTML('beforeend', `<section class="reader-section"><h2>${escapeText(heading)}</h2><p>${escapeText(article.paragraphs[index])}</p></section>`);
  });
  scroller.append(finish);
  document.querySelector('.reader-toolbar > span').textContent = article.type || 'Статья';
}
document.title = article.title;
const sections = [...document.querySelectorAll('.reader-section')];
sections.forEach((section, index) => {
  const heading = section.querySelector('h1, h2');
  if (!heading.id) heading.id = `article-section-${index + 1}`;
  section.setAttribute('aria-labelledby', heading.id);
});
sections.slice(0, -1).forEach(section => {
  const more = document.createElement('aside');
  more.className = 'reader-social';
  more.innerHTML = '<p>Больше информации в нашем <a href="#" data-social="ТГ">тг</a> или <a href="#" data-social="ВК">вк</a></p><span class="reader-social-status" role="status" hidden></span>';
  more.addEventListener('click', event => {
    const link = event.target.closest('[data-social]');
    if (!link) return;
    event.preventDefault();
    const status = more.querySelector('.reader-social-status');
    status.textContent = 'Ссылка на ' + link.dataset.social + ' скоро появится.';
    status.hidden = false;
  });
  section.after(more);
});
const progress = document.querySelector('.reader-progress progress');
const counter = document.querySelector('.reader-progress output');
progress.max = sections.length;
let scheduled = false;
const readArticleId = article.pregnancy ? article.id : articleId === 'mom-week' ? `mom-week-${momWeek}` : articleId;
function updateProgress() {
  const top = scroller.getBoundingClientRect().top;
  const position = top + scroller.clientHeight * .45;
  let current = 0;
  sections.forEach((section, index) => {
    if (section.getBoundingClientRect().top <= position) current = index;
  });
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) current = sections.length - 1;
  else if (scroller.scrollTop < 2) current = 0;
  progress.value = current + 1;
  counter.value = `${current + 1}/${sections.length}`;
  scheduled = false;
}
scroller.addEventListener('scroll', () => {
  if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
    window.articleReadState.setRead(readArticleId);
  }
  if (!scheduled) { scheduled = true; requestAnimationFrame(updateProgress); }
}, { passive: true });
new ResizeObserver(updateProgress).observe(scroller);
const origins = { index: 'index.html#recommendations-title', journey: 'journey.html#weekly-articles-title', baby: 'baby.html#learn-title', mom: 'mom.html#mom-recommendations-title', articles: 'articles.html', 'club-motherhood': 'club.html#motherhood' };
const origin = Object.hasOwn(origins, params.get('from')) ? params.get('from') : 'index';
const returnWeek = article.pregnancy ? article.week : momWeek;
const returnUrl = article.supplied && ['mom', 'journey', 'baby'].includes(origin) ? `${origin}.html?week=${returnWeek}#${origin === 'mom' ? 'mom-changes-title' : origin === 'baby' ? 'learn-title' : 'weekly-articles-title'}` : origins[origin];
document.querySelectorAll('[data-reader-return]').forEach(link => { link.href = returnUrl; });
const ids = Object.keys(library).filter(id => origin !== 'club-motherhood' || library[id].group === 'motherhood');
document.querySelector('[data-reader-next]').href = `article.html?id=${ids[(ids.indexOf(articleId) + 1) % ids.length]}&from=${origin}`;
if (article.pregnancy) {
  const next = document.querySelector('[data-reader-next]');
  const following = window.pregnancyArticleList.find(item => item.number === article.number + 1);
  next.href = following ? `article.html?id=${following.id}&from=${origin}` : returnUrl;
  next.textContent = following ? 'Читать следующую статью →' : 'Вернуться к разделу';
} else if (article.supplied) {
  const next = document.querySelector('[data-reader-next]');
  next.href = momWeek < 42 ? `article.html?id=mom-week&week=${momWeek + 1}&from=${origin}` : returnUrl;
  next.textContent = momWeek < 42 ? `Читать о ${momWeek + 1}-й неделе →` : 'Вернуться к разделу';
}
if (origin === 'journey' || origin === 'club-motherhood') {
  document.querySelectorAll('.nav-item').forEach(link => {
    const active = link.getAttribute('href') === (origin === 'journey' ? 'journey.html' : 'club.html');
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}
updateProgress();
