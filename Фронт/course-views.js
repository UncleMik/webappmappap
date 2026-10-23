export const positiveId = value => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));

export function courseErrorText(error) {
  if (error?.status === 401) return 'Войдите, чтобы открыть курсы.';
  if (error?.status === 403) return 'Доступ к этому материалу не найден.';
  if (error?.status === 404) return 'Материал не найден.';
  if (error?.status === 503) return 'Проверка доступа временно недоступна.';
  return 'Не удалось проверить доступ. Попробуйте снова.';
}

// A view owns only its current response. Materials disappear on expiry, an
// inactive tab, a failed check, or a page restored from the back-forward cache.
export function createCourseView({ url, clear, loading, render, error }) {
  let revision = 0;
  let controller = null;
  let expiryTimer = null;
  let active = false;
  let requesting = false;

  function invalidate() {
    ++revision;
    controller?.abort();
    controller = null;
    requesting = false;
    clearTimeout(expiryTimer);
    expiryTimer = null;
    clear();
  }

  async function refresh() {
    if (!active || document.visibilityState === 'hidden' || requesting) return;
    invalidate();
    const current = revision;
    requesting = true;
    controller = new AbortController();
    const requestController = controller;
    const requestTimeout = setTimeout(() => requestController.abort(), 15_000);
    loading();
    const started = performance.now();
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: requestController.signal });
      if (current !== revision) return;
      if (!response.ok) throw Object.assign(new Error('access_error'), { status: response.status });
      const data = await response.json();
      if (current !== revision) return;
      const server = Date.parse(data?.serverTime);
      const expires = Date.parse(data?.expiresAt);
      const valid = Date.parse(data?.validUntil);
      if (![server, expires, valid].every(Number.isFinite)) throw new Error('invalid_deadline');
      if (expires - server > 300_000) throw new Error('invalid_deadline');
      const remaining = Math.min(expires, valid) - server - (performance.now() - started);
      if (remaining <= 0) throw new Error('expired');
      const deadline = performance.now() + remaining;
      clear();
      render(data);
      if (current !== revision) return;
      const displayFor = deadline - performance.now();
      if (displayFor <= 0) throw new Error('expired');
      expiryTimer = setTimeout(() => { invalidate(); refresh(); }, Math.min(displayFor, 2_147_483_647));
    } catch (caught) {
      if (current !== revision) return;
      clear();
      error(caught, refresh);
    } finally {
      clearTimeout(requestTimeout);
      if (current === revision) requesting = false;
    }
  }

  function showAgain() { if (active && document.visibilityState !== 'hidden') refresh(); }
  return {
    start() {
      if (active) return;
      active = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') invalidate();
        else showAgain();
      });
      window.addEventListener('pagehide', invalidate);
      window.addEventListener('pageshow', event => { if (event.persisted) showAgain(); });
      window.addEventListener('focus', showAgain);
      refresh();
    },
    refresh,
  };
}
