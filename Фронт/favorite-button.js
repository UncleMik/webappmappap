(() => {
  const api = window.personalDataApi;
  window.bindFavoriteButton = (button, status) => {
    let material = null;
    let saving = false;
    const render = () => {
      button.hidden = !material;
      button.disabled = saving || !api.isLoaded();
      const selected = !!material && api.get().favorites.includes(material.id);
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', selected ? 'Удалить из избранного' : 'Добавить в избранное');
    };
    api.subscribe(render);
    function showError(message) {
      status.textContent = message;
      status.hidden = false;
    }
    button.addEventListener('click', async () => {
      if (!material || saving || !api.isLoaded()) return;
      const current = material;
      const { id, title } = current;
      const favorite = !api.get().favorites.includes(id);
      saving = true;
      status.hidden = true;
      render();
      try {
        await api.write({ operation: 'setFavorite', id, favorite, ...(favorite && title ? { title } : {}) });
      } catch (error) {
        if (material === current) showError(error.message);
      } finally {
        saving = false;
        render();
      }
    });
    return next => {
      if (material?.id === next?.id) return;
      material = next;
      status.hidden = true;
      render();
      if (material) api.load().catch(() => {
        if (material && !api.isLoaded()) showError('Не удалось загрузить избранное. Обновите страницу.');
      });
    };
  };
})();
