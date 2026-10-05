(() => {
  const storageKey = 'webpril-read-articles-v1';
  let read = new Set();
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (Array.isArray(saved)) read = new Set(saved.filter(id => typeof id === 'string'));
    } catch { /* Keep the in-memory state when browser storage is unavailable. */ }
  }
  function sync() {
    document.querySelectorAll('[data-read-article-id]').forEach(checkbox => {
      checkbox.checked = read.has(checkbox.dataset.readArticleId);
    });
  }
  function setRead(id, completed = true) {
    load();
    if (completed) read.add(id);
    else read.delete(id);
    try { localStorage.setItem(storageKey, JSON.stringify([...read])); } catch { /* Session state still works. */ }
    sync();
  }
  load();
  window.articleReadState = {
    setRead,
    bindCheckbox(checkbox, id) {
      checkbox.dataset.readArticleId = id;
      checkbox.checked = read.has(id);
    }
  };
  document.addEventListener('change', event => {
    const checkbox = event.target.closest('input[data-read-article-id]');
    if (checkbox) setRead(checkbox.dataset.readArticleId, checkbox.checked);
  });
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) { load(); sync(); }
  });
  window.addEventListener('pageshow', () => { load(); sync(); });
})();
