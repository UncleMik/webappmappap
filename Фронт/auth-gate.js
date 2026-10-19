/* The server enforces access. This gate also conceals restored/cached panels. */
(() => {
  const lock = document.querySelector('#account-lock');
  const owner = window.top;
  let checking;
  function hide() { lock.sheet.disabled = false; }
  function login() {
    const destination = new URL('login.html', location.href);
    const current = new URL(owner.location.href);
    current.searchParams.delete('_app');
    destination.searchParams.set('next', current.pathname + current.search + current.hash);
    owner.location.replace(destination.href);
  }
  async function check() {
    hide();
    if (checking) return checking;
    checking = (async () => {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        const session = response.ok ? await response.json() : null;
        if (session?.authenticated !== true || typeof session.user?.id !== 'string' ||
            typeof session.user?.email !== 'string') { login(); return; }
        lock.sheet.disabled = true;
      } catch { login(); }
      finally { checking = undefined; }
    })();
    return checking;
  }
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', event => { if (event.persisted) check(); });
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); else check(); });
  if (location.hostname === 'unclemik.github.io') {
    const destination = new URL('https://app.legkie-rody.ru/login.html');
    destination.searchParams.set('next', location.pathname.replace(/^\/webappmappap\//, '/') + location.search + location.hash);
    owner.location.replace(destination.href);
  } else { check(); }
})();
