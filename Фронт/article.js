const scroller = document.querySelector('.reader-scroll');
const params = new URLSearchParams(location.search);
const library = window.articleLibrary;
const articleId = Object.hasOwn(library, params.get('id')) ? params.get('id') : 'dating';
const article = library[articleId];
const escapeText = text => text.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
if (articleId !== 'dating') {
  const finish = scroller.querySelector('.reader-finish').cloneNode(true);
  finish.querySelector('p').textContent = 'Вы дочитали пример материала. Сохраните интересные мысли и переходите к следующей теме в удобном темпе.';
  scroller.innerHTML = `<section class="reader-section reader-intro"><div><span class="reader-week">${escapeText(article.type || '27 неделя')}</span><span class="reader-demo">Пример материала</span><h1>${escapeText(article.title)}</h1><p>${escapeText(article.intro)}</p></div><figure class="reader-cover reader-example-cover"><img src="assets/${article.image}" alt="${escapeText(article.title)}"><figcaption class="reader-duration">${article.minutes} минут на чтение</figcaption></figure></section>`;
  article.headings.forEach((heading, index) => {
    scroller.insertAdjacentHTML('beforeend', `<section class="reader-section"><h2>${escapeText(heading)}</h2><p>${escapeText(article.paragraphs[index])}</p>${index === 1 ? `<img class="reader-inline-photo" src="assets/${article.image}" alt="Иллюстрация к материалу" loading="lazy">` : ''}</section>`);
  });
  scroller.insertAdjacentHTML('beforeend', `<section class="reader-section"><h2>Что можно сохранить</h2><p>Небольшая памятка по теме статьи, к которой удобно вернуться позже.</p><aside class="reader-callout reader-checklist"><h3>Ваш список</h3><ul>${article.checklist.map(item => `<li>${escapeText(item)}</li>`).join('')}</ul></aside></section>`);
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
const progress = document.querySelector('.reader-progress progress');
const counter = document.querySelector('.reader-progress output');
let scheduled = false;
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
  if (!scheduled) { scheduled = true; requestAnimationFrame(updateProgress); }
}, { passive: true });
new ResizeObserver(updateProgress).observe(scroller);
const origins = { index: 'index.html#recommendations-title', journey: 'journey.html#weekly-articles-title', baby: 'baby.html#learn-title', mom: 'mom.html#mom-recommendations-title', articles: 'articles.html' };
const origin = Object.hasOwn(origins, params.get('from')) ? params.get('from') : 'index';
const returnUrl = origins[origin];
document.querySelectorAll('[data-reader-return]').forEach(link => { link.href = returnUrl; });
const ids = Object.keys(library);
document.querySelector('[data-reader-next]').href = `article.html?id=${ids[(ids.indexOf(articleId) + 1) % ids.length]}&from=${origin}`;
if (origin === 'journey') {
  document.querySelectorAll('.nav-item').forEach(link => {
    const active = link.getAttribute('href') === 'journey.html';
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}
updateProgress();
