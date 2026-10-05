const list = document.querySelector('.materials-list');
Object.entries(window.articleLibrary).forEach(([id, article]) => {
  if (!article.pregnancy && article.group !== 'motherhood' && id !== 'practice-article') return;
  const link = document.createElement('a');
  link.className = 'material-link';
  link.href = `article.html?id=${id}&from=articles`;
  const image = document.createElement(article.image ? 'img' : 'span');
  if (article.image) {
    image.src = `assets/${article.image}`;
    image.alt = '';
    image.loading = 'lazy';
  } else {
    image.className = 'material-cover-placeholder';
    image.setAttribute('aria-hidden', 'true');
  }
  const copy = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = article.title;
  const meta = document.createElement('p');
  meta.textContent = `${article.type || 'Статья'} · ${article.minutes} мин${article.supplied ? '' : ' · Пример материала'}`;
  copy.append(title, meta);
  link.append(image, copy);
  list.append(link);
});
const from = new URLSearchParams(location.search).get('from');
if (['index', 'baby', 'mom', 'journey'].includes(from)) document.querySelector('#materials-back').href = `${from}.html`;
