/* Personal records belong to the authenticated account. Browser storage is read only for an explicit legacy import. */
(() => {
  const empty = () => ({ weights: [], pressure: [], wellbeing: [], baby: {}, movements: [], readArticles: [], favorites: [] });
  let snapshot = empty();
  let loaded = false;
  let active = true;
  let pending;
  let revision = 0;
  let writeQueue = Promise.resolve();
  const listeners = new Set();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('webpril-personal-updates') : null;
  const validSnapshot = data => data && typeof data.accountId === 'string' &&
    ['weights', 'pressure', 'wellbeing', 'movements', 'readArticles', 'favorites'].every(key => Array.isArray(data[key])) &&
    data.baby && typeof data.baby === 'object' && !Array.isArray(data.baby);
  function notify() { listeners.forEach(listener => listener(snapshot)); }
  function reset() { revision++; pending = null; loaded = false; active = false; snapshot = empty(); notify(); }
  async function request(body) {
    if (!active) throw new Error('Сессия завершена. Войдите снова.');
    if (body && (!loaded || !snapshot.accountId)) throw new Error('Дождитесь загрузки аккаунта и повторите.');
    let response;
    try {
      response = await fetch('/api/auth/personal', {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json', 'X-Webpril-Account': snapshot.accountId } : {},
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error('Не удалось связаться с сервером. Проверьте интернет и повторите.'); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || (response.status === 409 && result.error === 'account_changed')) {
        reset(); window.top.webprilSessionGate?.end('session_replaced');
      }
      throw new Error(result.message || 'Не удалось сохранить данные. Попробуйте ещё раз.');
    }
    if (!validSnapshot(result)) throw new Error('Сервер вернул неполные личные записи. Обновите страницу.');
    return result;
  }
  async function load(force = false) {
    if (!active) throw new Error('Сессия завершена. Войдите снова.');
    if (loaded && !force) return snapshot;
    if (pending && !force) return pending;
    const current = ++revision;
    pending = request().then(data => {
      if (current !== revision || !active) throw new Error('Состояние аккаунта изменилось. Обновите страницу.');
      if (current === revision) {
        if (loaded && snapshot.accountId !== data.accountId ||
            window.webprilSessionAccountId && window.webprilSessionAccountId !== data.accountId) {
          reset(); window.top.webprilSessionGate?.end('session_replaced');
          throw new Error('Аккаунт изменился. Войдите снова.');
        }
        snapshot = data; loaded = true; notify();
      }
      return snapshot;
    }).finally(() => { if (current === revision) pending = null; });
    return pending;
  }
  function write(body) {
    // Preserve request order within a page; callers reuse a stable id when an acknowledgement is lost.
    const job = writeQueue.catch(() => {}).then(async () => {
      const current = ++revision;
      const data = await request(body);
      if (current !== revision) {
        channel?.postMessage('refresh');
        if (active) await load(true).catch(() => {});
        throw new Error('Состояние аккаунта изменилось. Обновите страницу и проверьте запись.');
      }
      if (data.accountId !== snapshot.accountId) {
        reset(); window.top.webprilSessionGate?.end('session_replaced');
        throw new Error('Аккаунт изменился. Войдите снова.');
      }
      snapshot = data;
      loaded = true;
      notify();
      channel?.postMessage('refresh');
      return snapshot;
    });
    writeQueue = job;
    return job;
  }
  function refreshAfterWrites() { writeQueue.catch(() => {}).then(() => { if (active) return load(true); }).catch(() => {}); }
  channel?.addEventListener('message', event => { if (event.data === 'refresh') refreshAfterWrites(); });
  window.addEventListener('pageshow', event => { if (event.persisted && active) refreshAfterWrites(); });
  window.addEventListener('webpril:session-ended', reset);
  window.personalDataApi = { load, write, subscribe(listener) { listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); }, get: () => snapshot, isLoaded: () => loaded, reset };

  // A shared browser profile cannot establish which account created old local records.
  const keys = ['webpril:mom-data:v1', 'webpril:baby-data:v1', 'webpril:movements:v1', 'webpril-read-articles-v1'];
  function legacy() {
    const found = {};
    try {
      for (const key of keys) if (localStorage.getItem(key) !== null) found[key] = localStorage.getItem(key);
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('webpril:baby-data:v2:week:') || key?.startsWith('webpril.videoFavorite.')) found[key] = localStorage.getItem(key);
      }
    } catch { return {}; }
    return found;
  }
  function payload(found) {
    const parse = key => { try { return JSON.parse(found[key]); } catch { return null; } };
    const mom = parse('webpril:mom-data:v1') || {};
    const baby = {};
    for (const key of Object.keys(found)) if (key.startsWith('webpril:baby-data:v2:week:')) {
      const week = key.split(':').at(-1);
      if (/^(?:[1-9]|[1-3][0-9]|4[0-2])$/.test(week) && parse(key)) baby[week] = parse(key);
    }
    if (!baby['27'] && found['webpril:baby-data:v1']) baby['27'] = parse('webpril:baby-data:v1');
    const favorites = Object.keys(found).filter(key => key.startsWith('webpril.videoFavorite.') && found[key] === 'true').map(key => key.slice('webpril.videoFavorite.'.length));
    return {
      weights: Array.isArray(mom.weights) ? mom.weights : [],
      pressure: mom.pressure || null,
      wellbeing: typeof mom.wellbeing === 'string' ? { state: '', comment: mom.wellbeing } : mom.wellbeing || null,
      baby, movements: parse('webpril:movements:v1') || [],
      readArticles: parse('webpril-read-articles-v1') || [], favorites,
    };
  }
  async function offerLegacyImport() {
    if (window !== top) return;
    try { if (sessionStorage.getItem('webpril:legacy-import-deferred')) return; } catch {}
    const found = legacy();
    if (!Object.keys(found).length) return;
    try { await load(); } catch { return; }
    if (!document.body || document.querySelector('#legacy-personal-import')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'legacy-personal-import';
    dialog.style.cssText = 'max-width:min(420px,calc(100vw - 32px));border:0;border-radius:18px;padding:24px;color:#303038;background:#fff;box-shadow:0 20px 55px #0004;font:inherit';
    const heading = document.createElement('h2'); heading.textContent = 'Записи из этого браузера';
    const message = document.createElement('p'); message.textContent = 'Здесь найдены прежние личные записи. Они могут принадлежать другому человеку, который пользовался этим браузером. Перенести их в ваш аккаунт, только если все записи ваши?';
    const old = payload(found);
    const summary = document.createElement('p');
    summary.textContent = `Найдено: вес — ${old.weights.length}, давление — ${old.pressure ? 1 : 0}, самочувствие — ${old.wellbeing ? 1 : 0}, недели малыша — ${Object.keys(old.baby).length}, шевеления — ${Array.isArray(old.movements) ? old.movements.length : 0}, статьи — ${Array.isArray(old.readArticles) ? old.readArticles.length : 0}, избранное — ${old.favorites.length}.`;
    const state = document.createElement('p'); state.setAttribute('role', 'status');
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = 'Да, все записи мои';
    const skip = document.createElement('button'); skip.type = 'button'; skip.textContent = 'Пока не переносить'; skip.style.marginLeft = '12px';
    dialog.append(heading, message, summary, state, confirm, skip); document.body.append(dialog); dialog.showModal();
    let importing = false;
    const defer = () => {
      if (importing) return;
      try { sessionStorage.setItem('webpril:legacy-import-deferred', '1'); } catch {}
      dialog.close(); dialog.remove();
    };
    skip.addEventListener('click', defer);
    dialog.addEventListener('cancel', event => { event.preventDefault(); defer(); });
    window.addEventListener('webpril:session-ended', () => { dialog.close(); dialog.remove(); }, { once: true });
    confirm.addEventListener('click', async () => {
      importing = true;
      confirm.disabled = true; skip.disabled = true; state.textContent = 'Переносим записи…';
      try {
        await write({ operation: 'import', confirmed: true, data: old });
        try {
          for (const [key, value] of Object.entries(found)) if (localStorage.getItem(key) === value) localStorage.removeItem(key);
        } catch { /* The server copy is already confirmed; stale browser data can be reviewed later. */ }
        state.textContent = 'Записи перенесены.';
        setTimeout(() => { dialog.close(); dialog.remove(); }, 800);
      } catch (error) { state.textContent = error.message; confirm.disabled = false; skip.disabled = false; importing = false; }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', offerLegacyImport, { once: true });
  else offerLegacyImport();
})();
