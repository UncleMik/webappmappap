// Article text and illustrations are served by wep_pril; no embedded corpus.
window.articlesApiBase = 'https://129.101.119.250';
window.articleLibrary = {};
window.pregnancyArticleList = [];
window.articleImageUrl = image => image ? new URL(image, window.articlesApiBase).href : '';

window.showArticleLoadError = container => {
  if (!container) return;
  container.removeAttribute('aria-busy');
  const message = document.createElement('p');
  message.className = 'article-load-status';
  message.setAttribute('role', 'status');
  message.textContent = 'Не удалось загрузить статьи. Проверьте соединение и попробуйте ещё раз.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'article-load-retry';
  retry.textContent = 'Повторить';
  retry.addEventListener('click', () => location.reload());
  container.replaceChildren(message, retry);
};

async function requestArticleData(path) {
  const response = await fetch(window.articlesApiBase + path, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Article request failed');
  return response.json();
}

let articleLoadingError = null;
const decorateArticle = article => Object.assign(article, { type: `${article.week} неделя`, supplied: true, pregnancy: true });
window.articlesReady = requestArticleData('/api/articles').then(payload => {
  if (!Array.isArray(payload.articles)) throw new Error('Invalid article list');
  window.pregnancyArticleList = payload.articles.map(decorateArticle);
  window.pregnancyArticleList.forEach(article => { window.articleLibrary[article.id] = article; });
  window.articleLibrary.dating = window.pregnancyArticleList[0];
}).catch(error => { articleLoadingError = error; });

window.loadSchoolArticle = async id => {
  await window.articlesReady;
  if (articleLoadingError) throw articleLoadingError;
  const article = decorateArticle(await requestArticleData(`/api/articles/${id}`));
  window.articleLibrary[id] = article;
  return article;
};

const pendingArticleLists = new WeakMap();
function renderWhenArticlesReady(list, render) {
  if (!list) return;
  const request = {};
  pendingArticleLists.set(list, request);
  list.setAttribute('aria-busy', 'true');
  const loading = document.createElement('p');
  loading.className = 'article-load-status';
  loading.setAttribute('role', 'status');
  loading.textContent = 'Загружаем статьи…';
  list.replaceChildren(loading);
  window.articlesReady.then(() => {
    if (pendingArticleLists.get(list) !== request) return;
    list.removeAttribute('aria-busy');
    if (articleLoadingError) { window.showArticleLoadError(list); return; }
    render();
  });
}

function articleCover(article, className) {
  if (!article.image) return null;
  const image = document.createElement('img');
  image.className = className;
  image.src = window.articleImageUrl(article.image);
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  return image;
}

window.createSchoolArticleCard = (article, from) => {
  const card = document.createElement('article');
  card.className = 'journey-content-card school-article-card';
  card.innerHTML = '<a class="content-open"><h3></h3></a><div class="content-footer"><span class="content-type"><svg aria-hidden="true" viewBox="0 0 18 22"><path d="M3 1h7l5 5v14H3ZM10 1v6h5M6 11h6M6 15h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Статья</span><input class="read-checkbox" type="checkbox"></div>';
  const link = card.querySelector('a');
  link.href = `article.html?id=${encodeURIComponent(article.id)}&from=${from}`;
  const cover = articleCover(article, 'journey-photo school-article-cover');
  if (cover) link.prepend(cover);
  card.querySelector('h3').textContent = article.title;
  const checkbox = card.querySelector('input');
  window.articleReadState.bindCheckbox(checkbox, article.id);
  checkbox.setAttribute('aria-label', `Отметить статью ${article.title} прочитанной`);
  return card;
};

window.renderPregnancyWeekArticles = (list, week) => renderWhenArticlesReady(list, () => {
  const cards = window.pregnancyArticleList.filter(article => article.week === week).map(article => window.createSchoolArticleCard(article, 'journey'));
  list.replaceChildren(...cards);
  list.scrollLeft = 0;
});

window.renderPregnancyRecommendations = (list, week, from) => renderWhenArticlesReady(list, () => {
  list.replaceChildren(...window.pregnancyArticleList.filter(article => article.week === week).map(article => window.createSchoolArticleCard(article, from)));
});
const todayArticles = document.querySelector('.today-page .article-grid, #today .article-grid');
if (todayArticles) renderWhenArticlesReady(todayArticles, () => {
  const cards = window.pregnancyArticleList.filter(article => article.week === 27).slice(0, 2)
    .map(article => window.createSchoolArticleCard(article, 'index'));
  const practice = document.createElement('article');
  practice.className = 'journey-content-card school-article-card today-practice-card';
  practice.innerHTML = '<a class="content-open" href="video.html?id=back-practice&from=index"><span class="today-practice-cover" aria-hidden="true"></span><h3>Расслабление спины</h3></a><div class="content-footer"><span class="content-type"><svg aria-hidden="true" viewBox="0 0 18 22"><path d="m5 4 10 7-10 7Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>Практика</span><span class="today-practice-time">8 мин</span></div>';
  todayArticles.replaceChildren(...cards, practice);
});
