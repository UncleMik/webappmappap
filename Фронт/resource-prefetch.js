/* Warm static resources only: do not run hidden pages or request personal data. */
(() => {
  if (window !== window.top) return;
  const connection = navigator.connection;
  const allowed = () => document.visibilityState === 'visible' && navigator.onLine &&
    !connection?.saveData && !['slow-2g', '2g', '3g'].includes(connection?.effectiveType);
  const routes = ['journey.html', 'baby.html', 'mom.html', 'index.html', 'ai.html', 'club.html', 'profile.html'];
  const current = location.pathname.split('/').pop() || 'index.html';
  const seen = new Set();
  let remaining = 16;
  let started = false;

  async function warm(url) {
    if (!allowed() || remaining <= 0 || seen.has(url.href)) return null;
    seen.add(url.href);
    remaining--;
    try {
      const response = await fetch(url, {
        priority: 'low', credentials: 'same-origin', signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return null;
      // Finish one resource before starting the next, keeping background traffic small.
      return await response.text();
    } catch { return null; }
  }

  async function start() {
    if (started || !allowed()) return;
    started = true;
    performance.getEntriesByType('resource').forEach(entry => seen.add(entry.name));
    document.querySelectorAll('script[src], link[href]').forEach(node => {
      seen.add(new URL(node.src || node.href, document.baseURI).href);
    });
    // Prefer the actual visible links, preserving week parameters on detail pages.
    const links = [...document.querySelectorAll('a[href]')];
    const targets = new Map();
    for (const link of links) {
      const url = new URL(link.href);
      const file = url.pathname.split('/').pop();
      if (url.origin !== location.origin || file === current || !routes.includes(file)) continue;
      url.hash = '';
      targets.set(file, targets.get(file) || url);
    }
    for (const url of routes.filter(file => targets.has(file)).slice(0, 3).map(file => targets.get(file))) {
      const html = await warm(url);
      if (!html || !allowed()) continue;
      // A template remains inert: images, frames and scripts are never executed.
      const template = document.createElement('template');
      template.innerHTML = html;
      for (const node of template.content.querySelectorAll('link[rel="stylesheet"][href], script[src]')) {
        const asset = new URL(node.getAttribute('href') || node.getAttribute('src'), url);
        if (asset.origin === location.origin && /\.(css|js)$/.test(asset.pathname)) await warm(asset);
      }
    }
  }

  function schedule() {
    if ('requestIdleCallback' in window) window.requestIdleCallback(start, { timeout: 3000 });
    else setTimeout(start, 1500);
  }
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (document.readyState === 'complete' && !started && allowed()) schedule();
  });
})();
