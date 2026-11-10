(() => {
  const api = window.personalDataApi;
  window.bindFavoriteButton = (controls, status) => {
    const buttons = Array.isArray(controls) ? controls : [controls];
    let material = null;
    let saving = false;
    const render = () => {
      const selected = !!material && api.get().favorites.includes(material.id);
      for (const button of buttons) {
        button.hidden = !material;
        button.disabled = saving || !api.isLoaded();
        button.setAttribute('aria-pressed', String(selected));
        button.setAttribute('aria-label', selected ? 'Удалить из избранного' : 'Добавить в избранное');
      }
    };
    api.subscribe(render);
    function showError(message) {
      status.textContent = message;
      status.hidden = false;
    }
    async function toggleFavorite() {
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
    }
    for (const button of buttons) button.addEventListener('click', toggleFavorite);
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
