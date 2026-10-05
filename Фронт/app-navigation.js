/* Keep primary sections alive in isolated panels; detail pages retain native navigation. */
(() => {
  const sections = new Map([
    ['index.html', 'Сегодня'], ['journey.html', 'Мой путь'],
    ['ai.html', 'AI врач'], ['club.html', 'Клуб'], ['profile.html', 'Профиль']
  ]);
  const version = new URL(document.currentScript.src).searchParams.get('v') || '1';
  const fileOf = url => url.pathname.split('/').pop() || 'index.html';
  const ordinaryClick = event => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  const parentPanel = window.frameElement?.dataset.appPanel;
  if (parentPanel) {
    document.documentElement.classList.add('embedded-section');
    const notify = (type, url = location.href) => {
      const address = new URL(url);
      address.searchParams.delete('_app');
      parent.postMessage({ appSection: true, type, url: address.href, title: document.title }, location.origin);
    };
    window.navigateApp = destination => notify('navigate', new URL(destination, location.href).href);
    const replace = history.replaceState.bind(history);
    // Only the outer application owns browser history entries.
    history.pushState = (state, unused, url) => { replace(state, unused, url); notify('push'); };
    history.replaceState = (state, unused, url) => { replace(state, unused, url); notify('replace'); };
    window.addEventListener('hashchange', () => notify('replace'));
    document.addEventListener('click', event => {
      const link = event.target.closest('a[href]');
      if (!link || !ordinaryClick(event) || link.hasAttribute('download') || link.target) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search && url.hash && !link.closest('.bottom-navigation')) return;
      event.preventDefault();
      if (sections.has(fileOf(url))) notify(link.closest('.bottom-navigation') ? 'tab' : 'navigate', url.href);
      else parent.location.href = url.href;
    });
    window.addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'section-restore') return;
      const url = new URL(event.data.url);
      if (url.origin !== location.origin || fileOf(url) !== parentPanel) return;
      replace(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => notify('ready'), { once: true });
    else notify('ready');
    return;
  }
  const initialFile = fileOf(new URL(location.href));
  if (!sections.has(initialFile)) return;
  const initialPanel = document.querySelector('.app');
  const nav = document.querySelector('.bottom-navigation');
  if (!initialPanel || !nav) return;
  const initialTitle = document.title;
  const panels = new Map([[initialFile, { element: initialPanel, url: location.href, ready: true }]]);
  let activeFile = initialFile;
  let serial = 0;
  let restoring = false;
  initialPanel.dataset.initialSection = initialFile;
  document.body.classList.add('app-shell');
  document.body.append(nav);
  nav.querySelectorAll('a').forEach((link, index) => { link.href = [...sections.keys()][index]; });
  const status = document.createElement('div');
  status.className = 'section-loading';
  status.setAttribute('role', 'status');
  status.hidden = true;
  status.textContent = 'Открываем раздел…';
  document.body.append(status);
  const updateHeight = () => {
    const height = window.visualViewport?.height ?? innerHeight;
    document.documentElement.style.setProperty('--section-nav-height', `${nav.getBoundingClientRect().height}px`);
    document.documentElement.style.setProperty('--section-viewport-height', `${height}px`);
    document.documentElement.style.setProperty('--section-viewport-bottom', `${Math.max(0, innerHeight - height - (window.visualViewport?.offsetTop ?? 0))}px`);
  };
  window.visualViewport?.addEventListener('resize', updateHeight);
  window.addEventListener('resize', updateHeight);
  new ResizeObserver(updateHeight).observe(nav);
  updateHeight();
  function setActive(file) {
    nav.querySelectorAll('a').forEach(link => {
      const active = fileOf(new URL(link.href)) === file;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }
  function makePanel(url) {
    const file = fileOf(url);
    const frame = document.createElement('iframe');
    frame.className = 'app-section-frame';
    frame.dataset.appPanel = file;
    frame.title = sections.get(file);
    frame.hidden = true;
    const panel = { element: frame, url: url.href, ready: false };
    panel.loaded = new Promise(resolve => {
      panel.resolve = resolve;
      frame.addEventListener('load', () => {
      try {
        if (!frame.contentDocument?.querySelector('.app')) { resolve(false); return; }
        panel.ready = true;
        resolve(true);
      } catch { resolve(false); }
    }, { once: true });
    });
    panels.set(file, panel);
    const source = new URL(url);
    source.searchParams.set('_app', version);
    frame.src = source.href;
    document.body.append(frame);
    return panel;
  }
  async function navigate(url, push = true, restoreTab = false) {
    const file = fileOf(url);
    if (!sections.has(file) || url.origin !== location.origin) { location.href = url.href; return; }
    url.searchParams.set('v', version);
    if (file === activeFile && push && restoreTab) return;
    const request = ++serial;
    const old = panels.get(activeFile);
    if (activeFile === initialFile) { if (push) old.url = location.href; old.scroll = [scrollX, scrollY]; }
    let panel = panels.get(file);
    if (!panel) panel = makePanel(url);
    status.hidden = panel.ready;
    nav.setAttribute('aria-busy', String(!panel.ready));
    if (!panel.ready) {
      const loaded = await Promise.race([panel.loaded, new Promise(resolve => setTimeout(() => resolve(false), 15000))]);
      if (request !== serial) return;
      if (!loaded) { location.href = url.href; return; }
    }
    if (request !== serial) return;
    // Reopening a tab restores its last week, search, scroll and demo chat.
    const target = push && restoreTab ? new URL(panel.url) : url;
    if (push) history.pushState(null, '', target);
    old.element.hidden = true;
    panel.element.hidden = false;
    activeFile = file;
    setActive(file);
    status.hidden = true;
    nav.setAttribute('aria-busy', 'false');
    if (file === initialFile) {
      document.title = initialTitle;
      restoring = true;
      window.dispatchEvent(new PopStateEvent('popstate'));
      restoring = false;
      if (panel.scroll) window.scrollTo(...panel.scroll);
    } else {
      document.title = panel.element.contentDocument.title;
      if (!push || panel.url !== target.href) panel.element.contentWindow.postMessage({ type: 'section-restore', url: target.href }, location.origin);
    }
    panel.url = target.href;
  }
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || !ordinaryClick(event)) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || !sections.has(fileOf(url))) return;
    const tab = !!link.closest('.bottom-navigation');
    if (!tab && url.pathname === location.pathname && url.search === location.search && url.hash) return;
    event.preventDefault();
    navigate(url, true, tab);
  });
  window.navigateApp = destination => navigate(new URL(destination, location.href));
  window.addEventListener('popstate', () => { if (!restoring) navigate(new URL(location.href), false); });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || !event.data?.appSection) return;
    const panelEntry = [...panels.entries()].find(([, panel]) => panel.element.contentWindow === event.source);
    if (!panelEntry) return;
    const [file, panel] = panelEntry;
    if (event.data.type === 'ready') { panel.ready = true; panel.resolve?.(true); return; }
    const url = new URL(event.data.url);
    if (url.origin !== location.origin) return;
    if (['navigate', 'tab'].includes(event.data.type)) { navigate(url, true, event.data.type === 'tab'); return; }
    panel.url = url.href;
    if (file !== activeFile) return;
    if (event.data.type === 'push') history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    document.title = event.data.title;
  });
})();
