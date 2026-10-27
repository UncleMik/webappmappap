(() => {
  const api = window.personalDataApi;
  let read = new Set();
  let loaded = false;
  const lists = new Map();
  const pending = new Set();
  function load() { read = new Set(api.get().readArticles.filter(id => typeof id === 'string')); }
  function sync() {
    const focusedId = document.activeElement?.dataset.readArticleId;
    lists.forEach(render => render());
    document.querySelectorAll('[data-read-article-id]').forEach(checkbox => {
      checkbox.checked = read.has(checkbox.dataset.readArticleId);
      if (focusedId === checkbox.dataset.readArticleId) checkbox.focus({ preventScroll: true });
    });
  }
  async function setRead(id, completed = true) {
    if (!loaded) return;
    if (read.has(id) === completed) return;
    if (pending.has(id)) return;
    pending.add(id);
    try { await api.write({ operation: 'setArticleRead', id, read: completed }); }
    finally { pending.delete(id); }
  }
  window.articleReadState = {
    setRead,
    // Stable partition: preserve the source order inside each read-state group.
    unreadFirst(articles) {
      return articles.filter(article => !read.has(article.id))
        .concat(articles.filter(article => read.has(article.id)));
    },
    bindList(list, render) {
      lists.set(list, render);
      if (loaded) render();
      else { list.setAttribute('aria-busy', 'true'); list.textContent = 'Загружаем отметки статей…'; }
    },
    bindCheckbox(checkbox, id) {
      checkbox.dataset.readArticleId = id;
      checkbox.checked = read.has(id);
    }
  };
  document.addEventListener('change', async event => {
    const checkbox = event.target.closest('input[data-read-article-id]');
    if (!checkbox) return;
    checkbox.disabled = true;
    try { await setRead(checkbox.dataset.readArticleId, checkbox.checked); }
    catch (failure) {
      checkbox.checked = read.has(checkbox.dataset.readArticleId);
      const status = document.createElement('span');
      status.setAttribute('role', 'alert'); status.textContent = failure.message;
      checkbox.after(status); setTimeout(() => status.remove(), 5000);
    } finally { checkbox.disabled = false; }
  });
  api.subscribe(() => {
    if (!api.isLoaded()) { loaded = false; read.clear(); return; }
    if (!loaded) return;
    load(); sync();
  });
  window.articleReadState.ready = api.load().then(() => {
    loaded = true; load();
    lists.forEach((render, list) => list.removeAttribute('aria-busy'));
    sync();
  }).catch(error => {
    lists.forEach((_, list) => {
      list.removeAttribute('aria-busy');
      list.textContent = 'Не удалось загрузить отметки статей. Обновите страницу.';
    });
    throw error;
  });
  window.articleReadState.ready.catch(() => {});
})();
