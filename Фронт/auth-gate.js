/* The server enforces access. This gate also closes already loaded panels. */
(() => {
  const lock = document.querySelector('#account-lock');
  const owner = window.top;
  let checking, heartbeat, exiting = false, suspended = false, sessionUserId;
  let checkEpoch = 0;
  function hide() { lock.sheet.disabled = false; }
  function suspend() {
    suspended = true;
    // Navigation can cancel fetch. Its late failure must not replace the new page.
    checkEpoch++;
    checking = undefined;
    hide();
  }
  function login(reason) {
    if (exiting) return;
    exiting = true;
    window.webprilAnalyticsSession = null;
    window.dispatchEvent(new Event('webpril:analytics-session'));
    window.dispatchEvent(new Event('webpril:session-ended'));
    document.querySelectorAll('iframe.app-section-frame').forEach(frame => {
      try { frame.contentWindow.dispatchEvent(new Event('webpril:session-ended')); } catch {}
    });
    hide();
    clearInterval(heartbeat);
    if (owner !== window && owner.webprilSessionGate) {
      owner.webprilSessionGate.end(reason); return;
    }
    // Removing the preserved frames stops their media too; no cached section survives logout.
    document.querySelectorAll('video, audio').forEach(media => {
      media.pause();
      media.removeAttribute('src');
      media.querySelectorAll('source').forEach(source => source.remove());
      media.load();
    });
    document.querySelectorAll('iframe').forEach(frame => frame.remove());
    const destination = new URL('login.html', location.href);
    const current = new URL(owner.location.href);
    current.searchParams.delete('_app');
    destination.searchParams.set('next', current.pathname + current.search + current.hash);
    if (reason === 'session_replaced') destination.searchParams.set('reason', reason);
    owner.location.replace(destination.href);
  }
  async function check({ background = false } = {}) {
    if (exiting || suspended || document.hidden) return;
    if (!background) hide();
    if (checking) return checking;
    const epoch = checkEpoch;
    checking = (async () => {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        const session = response.ok ? await response.json() : null;
        if (epoch !== checkEpoch || suspended || document.hidden || exiting) return;
        if (session?.authenticated !== true || typeof session.user?.id !== 'string' ||
            typeof session.user?.email !== 'string') { login(session?.reason); return; }
        if (sessionUserId && sessionUserId !== session.user.id) { login('session_replaced'); return; }
        if (window.personalDataApi?.isLoaded() && window.personalDataApi.get().accountId !== session.user.id) {
          login('session_replaced'); return;
        }
        sessionUserId = session.user.id;
        window.webprilSessionAccountId = sessionUserId;
        const completed = !!session.user.profile?.completedAt;
        if (window.webprilAnalyticsSession?.id !== sessionUserId || window.webprilAnalyticsSession?.completed !== completed) {
          window.webprilAnalyticsSession = { id: sessionUserId, completed };
          window.dispatchEvent(new Event('webpril:analytics-session'));
        }
        if (!suspended && !document.hidden && !exiting) lock.sheet.disabled = true;
      } catch { if (epoch === checkEpoch && !suspended && !document.hidden) login(); }
      finally { if (epoch === checkEpoch) checking = undefined; }
    })();
    return checking;
  }
  function startHeartbeat() {
    // One timer per browser tab, including when navigation has several preserved iframes.
    if (owner === window && heartbeat === undefined && !exiting) {
      heartbeat = setInterval(() => {
        if (!document.hidden && !suspended) check({ background: true });
      }, 30000);
    }
  }
  if (owner === window) window.webprilSessionGate = { end: login };
  window.addEventListener('pagehide', () => {
    suspend(); clearInterval(heartbeat); heartbeat = undefined;
  });
  window.addEventListener('pageshow', event => {
    suspended = false;
    if (event.persisted) check();
    startHeartbeat();
  });
  window.addEventListener('focus', () => check({ background: lock.sheet.disabled && !suspended }));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspend();
    else { suspended = false; check(); }
  });
  if (location.hostname === 'unclemik.github.io') {
    const destination = new URL('https://app.legkie-rody.ru/login.html');
    destination.searchParams.set('next', location.pathname.replace(/^\/webappmappap\//, '/') + location.search + location.hash);
    owner.location.replace(destination.href);
  } else { check(); startHeartbeat(); }
})();
