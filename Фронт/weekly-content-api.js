(() => {
  const base = window.articlesApiBase || 'https://129.101.119.250';
  let pending;
  const statuses = new WeakMap();

  function load() {
    if (!pending) pending = fetch(`${base}/api/weekly-content`, { signal: AbortSignal.timeout(15000) })
      .then(response => {
        if (!response.ok) throw new Error(`Weekly content HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        if (!data || !data.baby || !data.mom || !data.calendar ||
            Array.from({ length: 42 }, (_, i) => String(i + 1)).some(week => !data.baby[week] || !data.mom[week] || !Array.isArray(data.calendar[week]))) {
          throw new Error('Incomplete weekly content');
        }
        return data;
      })
      .catch(error => { pending = null; throw error; });
    return pending;
  }

  window.weeklyImageUrl = path => path && path.startsWith('/') ? `${base}${path}` : path;
  window.loadWeeklyContent = load;
  window.withWeeklyContent = async (container, render) => {
    if (!container) return;
    container.setAttribute('aria-busy', 'true');
    let status = statuses.get(container);
    if (!status) {
      status = document.createElement('div');
      status.className = 'weekly-load-status';
      status.setAttribute('role', 'status');
      container.before(status);
      statuses.set(container, status);
    }
    status.textContent = 'Загружаем данные по неделям…';
    try {
      const data = await load();
      render(data);
      status.remove();
      statuses.delete(container);
    } catch {
      status.replaceChildren();
      status.append('Не удалось загрузить данные по неделям. ');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Повторить';
      retry.addEventListener('click', () => window.withWeeklyContent(container, render), { once: true });
      status.append(retry);
    } finally {
      container.removeAttribute('aria-busy');
    }
  };
})();
