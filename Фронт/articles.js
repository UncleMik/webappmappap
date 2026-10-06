(async () => {
await window.articlesReady;
const list = document.querySelector('.materials-list');
Object.entries(window.articleLibrary).forEach(([id, article]) => {
  if (id === 'dating') return;
  if (!article.pregnancy) return;
  list.append(window.createSchoolArticleCard(article, 'articles'));
});
if (!window.pregnancyArticleList.length) window.showArticleLoadError(list);
const from = new URLSearchParams(location.search).get('from');
if (['index', 'baby', 'mom', 'journey'].includes(from)) document.querySelector('#materials-back').href = `${from}.html`;

})();
