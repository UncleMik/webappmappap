(async () => {
await window.articlesReady;
const list = document.querySelector('.materials-list');
window.articleReadState.bindList(list, () => {
  list.replaceChildren(...window.articleReadState.unreadFirst(window.pregnancyArticleList)
    .map(article => window.createSchoolArticleCard(article, 'articles')));
});
if (!window.pregnancyArticleList.length) window.showArticleLoadError(list);
const from = new URLSearchParams(location.search).get('from');
if (['index', 'baby', 'mom', 'journey'].includes(from)) document.querySelector('#materials-back').href = `${from}.html`;

})();
