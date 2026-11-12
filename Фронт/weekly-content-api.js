(() => {
  const base = window.articlesApiBase || (location.hostname === '129.101.119.250'
    ? 'https://129.101.119.250' : 'https://app.legkie-rody.ru');
  let pending, revision = 0;
  const statuses = new WeakMap();

  function load() {
    if (pending) return pending;
    const current = revision;
    pending = (async () => {
      const expected = window.webprilSessionAccountId || window.webprilAccount?.user?.id || (await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)}).then(response=>response.json())).user?.id;
      if (!expected || current !== revision) throw new Error('Account changed');
      const response = await fetch(`${base}/api/weekly-content`, {credentials:'same-origin',cache:'no-store',headers:{'X-Webpril-Account':expected},signal:AbortSignal.timeout(15000)});
      if (current !== revision || window.webprilSessionAccountId && window.webprilSessionAccountId !== expected) throw new Error('Account changed');
      return response;
    })()
      .then(response => {
        if (!response.ok) throw new Error(`Weekly content HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        if (current !== revision) throw new Error('Account changed');
        if (!data || !data.baby || !data.mom || !data.calendar ||
            Array.from({ length: 42 }, (_, i) => String(i + 1)).some(week => !Array.isArray(data.calendar[week]))) {
          throw new Error('Incomplete weekly content');
        }
        window.webprilWeeklyAccess = data.access || null;
        window.dispatchEvent(new CustomEvent('weekly:access', {detail:data.access}));
        return data;
      })
      .catch(error => { if (current === revision) pending = null; throw error; });
    return pending;
  }

  window.addEventListener('account:change', () => { revision++; pending = null; window.webprilWeeklyAccess = null; });
  window.addEventListener('webpril:session-ended', () => { revision++; pending = null; window.webprilWeeklyAccess = null; });
  window.addEventListener('stars:changed', () => { revision++; pending = null; });
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
