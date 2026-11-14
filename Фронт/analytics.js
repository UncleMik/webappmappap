/* First-party, account-bound telemetry. Never inspect form values, titles or URL parameters. */
(() => {
  if (window.webprilAnalytics) return;
  const pages = new Set('index.html journey.html ai.html club.html profile.html article.html articles.html baby.html club-chat.html courses.html favorites.html mom.html my-courses.html personal-data.html video.html about.html'.split(' '));
  const page = location.pathname.split('/').pop() || 'index.html';
  if (!pages.has(page) || location.pathname.includes('/admin/')) return;
  const types = new Set('page_view active_time content_open article_progress video_start video_progress video_completed action transition ai_request ai_result error'.split(' '));
  const actions = new Set('nav_open course_open lesson_open video_open external_video_open favorite_add favorite_remove points_open calendar_open poll_vote ai_open ai_voice_transcribed ai_limit ai_error network unavailable'.split(' '));
  const resourceTypes = new Set(['article', 'video', 'lesson', 'course']);
  const milestones = [25, 50, 75, 90];
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value);
  const uuid = () => crypto.randomUUID();
  let account = null, stopped = false, suspended = false, queue = [], flight = null, epoch = 0;
  let visitId = null, resource = {}, visibleBefore = false, lastSample = performance.now(), lastInput = lastSample;
  let activeMs = 0, dwell = 0, article = null, flushAgain = false;
  const media = new Set(), opened = new Set();
  function visible() {
    try {
      return !suspended && !document.hidden && !window.parent.document.hidden &&
        !window.frameElement?.hidden && !document.querySelector('[data-initial-section]')?.hidden;
    } catch { return false; }
  }
  function identity() {
    const hint = window.webprilAnalyticsSession;
    if (hint && typeof hint.id === 'string' && hint.id === window.webprilSessionAccountId) return hint.completed === true ? hint.id : null;
    const user = window.webprilAccount?.user;
    return user?.profile?.completedAt && typeof user.id === 'string' &&
      (!window.webprilSessionAccountId || window.webprilSessionAccountId === user.id) ? user.id : null;
  }
  function clear() {
    if (account) {
      resource = {}; article = null;
      for (const item of media) item.disabled = true;
      media.clear();
    }
    epoch++; flight?.controller.abort(); flight = null; queue = []; account = null;
    visitId = null; activeMs = dwell = 0; visibleBefore = false; flushAgain = false; opened.clear();
  }
  function syncIdentity() {
    if (stopped) return false;
    const id = identity();
    if (id !== account) { clear(); account = id; lastSample = lastInput = performance.now(); }
    return !!account;
  }
  function emit(type, data = {}) {
    if (!types.has(type) || !syncIdentity() || !visitId) return;
    const event = { eventId: uuid(), visitId, type, page: type === 'transition' && pages.has(data.page) ? data.page : page };
    if (resourceTypes.has(data.resourceType) && validId(data.resourceId)) {
      event.resourceType = data.resourceType; event.resourceId = data.resourceId;
    }
    if (['article_progress', 'video_progress'].includes(type) && [25, 50, 75, 90, 100].includes(data.progress)) event.progress = data.progress;
    if (type === 'active_time' && Number.isFinite(data.activeMs)) event.activeMs = Math.max(1, Math.min(60000, Math.round(data.activeMs)));
    if (['action', 'error'].includes(type) && actions.has(data.action)) event.action = data.action;
    if (['ai_request', 'ai_result'].includes(type)) {
      if (['text', 'file', 'voice'].includes(data.format)) event.format = data.format;
      if (['accepted', 'completed', 'failed', 'limit'].includes(data.outcome)) event.outcome = data.outcome;
    }
    if (type === 'transition' && pages.has(data.fromPage)) event.fromPage = data.fromPage;
    if (['content_open', 'article_progress', 'video_start', 'video_progress', 'video_completed'].includes(type) && !event.resourceId) return;
    if (type === 'article_progress' && (event.resourceType !== 'article' || !event.progress)) return;
    if (['video_start', 'video_progress', 'video_completed'].includes(type) && !['video', 'lesson'].includes(event.resourceType)) return;
    if (type === 'video_progress' && !event.progress || type === 'active_time' && !event.activeMs || type === 'transition' && !event.fromPage) return;
    if (['action', 'error'].includes(type) && !event.action) return;
    if (type === 'error' && !['ai_limit', 'ai_error', 'network', 'unavailable'].includes(event.action)) return;
    if (['ai_request', 'ai_result'].includes(type) && (!event.format || !event.outcome)) return;
    if (queue.length < 120) queue.push(event);
    if (queue.length >= 30) void flush();
  }
  async function flush(final = false) {
    if (!syncIdentity() || !queue.length) return;
    if (flight) { flushAgain ||= final; return; }
    const id = account, generation = epoch, batch = queue.slice(0, 30), controller = new AbortController();
    const pending = { controller }; flight = pending;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/auth/analytics/events', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: final,
        headers: { 'Content-Type': 'application/json', 'X-Webpril-Account': id },
        body: JSON.stringify({ events: batch }), signal: controller.signal,
      });
      if (generation !== epoch || account !== id || identity() !== id) return;
      if (response.ok) queue.splice(0, batch.length);
      else if ([401, 403].includes(response.status)) { clear(); return; }
      else if (response.status >= 400 && response.status < 500 && response.status !== 429) queue.splice(0, batch.length);
    } catch { /* Keep the same event IDs for a bounded retry; analytics never affects the product. */ }
    finally {
      clearTimeout(timeout);
      if (flight === pending) {
        flight = null;
        if (flushAgain) { flushAgain = false; void flush(true); }
      }
    }
  }
  function playing() {
    return [...media].some(item => item.video.isConnected && !item.video.paused && !item.video.ended &&
      !item.video.closest('[hidden]') && (item.video.element || item.video).getBoundingClientRect?.().height > 0);
  }
  function timeEvent(final = true) {
    while (activeMs >= 60000) { activeMs -= 60000; emit('active_time', { ...resource, activeMs: 60000 }); }
    if (final && activeMs >= 1) { const remainder = activeMs; activeMs = 0; emit('active_time', { ...resource, activeMs: remainder }); }
  }
  function sample(now = performance.now()) {
    const elapsed = Math.max(0, Math.min(15000, now - lastSample));
    if (visibleBefore && account && !stopped) {
      const active = playing() ? elapsed : Math.max(0, Math.min(elapsed, lastInput + 60000 - lastSample));
      activeMs += active; dwell += active;
      if (activeMs >= 60000) timeEvent(false);
      if (activeMs > 0 && now >= lastInput + 60000 && !playing()) timeEvent();
    }
    lastSample = now;
  }
  function startView() {
    visitId = uuid(); dwell = activeMs = 0; opened.clear();
    if (article) article.seen.clear();
    for (const item of media) { item.previous = null; item.started = false; item.seen.clear(); item.ranges = []; }
    emit('page_view');
    if (resource.resourceId) openResource();
    if (page === 'ai.html') emit('action', { action: 'ai_open' });
  }
  function syncVisibility() {
    sample();
    if (visibleBefore) checkArticle();
    const canSee = syncIdentity() && visible();
    if (canSee && !visibleBefore) { lastInput = lastSample = performance.now(); visibleBefore = true; startView(); }
    if (!canSee && visibleBefore) { timeEvent(); void flush(true); }
    if (!canSee) for (const item of media) item.previous = null;
    visibleBefore = canSee;
    if (canSee) checkArticle();
  }
  function openResource() {
    const key = resource.resourceType + ':' + resource.resourceId;
    if (visibleBefore && !opened.has(key)) {
      opened.add(key); emit('content_open', resource);
      const action = { course: 'course_open', lesson: 'lesson_open' }[resource.resourceType];
      if (action) emit('action', { ...resource, action });
    }
  }
  function setResource(resourceType, resourceId) {
    if (!resourceTypes.has(resourceType) || !validId(resourceId)) return;
    sample();
    if (resource.resourceType === resourceType && resource.resourceId === resourceId) { openResource(); return; }
    const changed = !!resource.resourceId;
    timeEvent(); resource = { resourceType, resourceId }; dwell = 0;
    if (visibleBefore) { if (changed) { visitId = uuid(); emit('page_view'); } openResource(); }
  }
  function checkArticle() {
    if (!article || resource.resourceType !== 'article' || !visibleBefore || !article.scroller.isConnected) return;
    const scroller = article.scroller;
    const range = scroller.scrollHeight - scroller.clientHeight;
    const depth = range <= 2 ? 100 : Math.min(100, 100 * scroller.scrollTop / range);
    for (const progress of [...milestones, 100]) {
      if (depth >= progress && (progress !== 100 || dwell >= 10000) && !article.seen.has(progress)) {
        article.seen.add(progress); emit('article_progress', { ...resource, progress });
      }
    }
  }
  function trackArticle(scroller, id, resourceType = 'article') {
    setResource(resourceType, id);
    if (article?.scroller === scroller && article.id === id) return;
    article = { scroller, id, seen: new Set() };
    let scheduled = false;
    scroller.addEventListener('scroll', () => {
      if (scheduled) return; scheduled = true;
      requestAnimationFrame(() => { scheduled = false; checkArticle(); });
    }, { passive: true });
    checkArticle();
  }
  function trackVideo(video, id, duration, resourceType = 'video') {
    if (!validId(id) || !['video', 'lesson'].includes(resourceType) || [...media].some(item => item.video === video)) return;
    const item = { video, seen: new Set(), started: false, previous: null, ranges: [] }; media.add(item);
    function update() {
      if (item.disabled || stopped) return;
      sample(); syncVisibility();
      if (!visibleBefore || !video.isConnected || video.closest('[hidden]')) { item.previous = null; return; }
      const data = { resourceType, resourceId: id };
      if (!video.paused && !item.started) { item.started = true; emit('video_start', data); }
      // Only observed foreground playback counts. Seeking and background playback add no range.
      const length = Number.isFinite(video.duration) ? video.duration : duration;
      if (!item.started || !(length > 0) || !Number.isFinite(video.currentTime)) return;
      const now = performance.now(), previous = item.previous;
      if (previous && !video.seeking) {
        const delta = video.currentTime - previous.time, wall = (now - previous.stamp) / 1000;
        if (wall > 0 && wall <= 3 && delta > 0 && delta <= wall * 2 + .15) {
          item.ranges.push([previous.time, video.currentTime]); item.ranges.sort((a, b) => a[0] - b[0]);
          item.ranges = item.ranges.reduce((all, range) => {
            const last = all.at(-1);
            if (last && range[0] <= last[1] + .025) last[1] = Math.max(last[1], range[1]); else all.push(range);
            return all;
          }, []).slice(0, 512);
        }
      }
      item.previous = video.paused || video.seeking || video.ended ? null : { time: video.currentTime, stamp: now };
      const watched = item.ranges.reduce((total, [start, end]) => total + end - start, 0);
      const percent = Math.min(100, watched / length * 100);
      for (const progress of milestones) if (percent >= progress && !item.seen.has(progress)) {
        item.seen.add(progress); emit('video_progress', { ...data, progress });
      }
      if (video.ended && percent >= 90 && !item.seen.has(100)) { item.seen.add(100); emit('video_completed', { ...data, progress: 100 }); }
    }
    ['playing', 'pause', 'ended', 'timeupdate', 'seeking'].forEach(name => video.addEventListener(name, update));
  }
  function track(type, data) {
    syncVisibility();
    const transitionVisible = type === 'transition' && !suspended && !document.hidden && !parent.document.hidden;
    if (transitionVisible && account && !visitId) visitId = uuid();
    if (visibleBefore || transitionVisible || ['ai_request', 'ai_result', 'error'].includes(type)) emit(type, data);
  }
  window.webprilAnalytics = { track, setResource, trackArticle, trackVideo };
  window.addEventListener('account:change', syncVisibility);
  window.addEventListener('webpril:analytics-session', syncVisibility);
  window.addEventListener('webpril:session-ended', () => { stopped = true; clear(); });
  window.addEventListener('pagehide', () => { sample(); timeEvent(); void flush(true); suspended = true; visibleBefore = false; });
  window.addEventListener('pageshow', () => { suspended = false; lastSample = performance.now(); syncVisibility(); });
  document.addEventListener('visibilitychange', syncVisibility);
  if (parent !== window) parent.document.addEventListener('visibilitychange', syncVisibility);
  const observeVisibility = () => {
    const panel = window.frameElement || document.querySelector('.app');
    if (panel) new MutationObserver(syncVisibility).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    syncVisibility();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeVisibility, { once: true });
  else observeVisibility();
  const input = () => { sample(); lastInput = performance.now(); syncVisibility(); };
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(name => document.addEventListener(name, input, { passive: true, capture: true }));
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (link) {
      let url; try { url = new URL(link.href); } catch { return; }
      const destination = url.pathname.split('/').pop() || 'index.html';
      if (url.origin !== location.origin || !pages.has(destination)) return;
      const action = link.closest('.bottom-navigation') || ['courses.html', 'my-courses.html', 'article.html'].includes(destination) ? 'nav_open' : destination === 'video.html' ? 'video_open' : null;
      if (action) {
        // The outer bottom nav remains visible while its initial panel is hidden.
        const activeFrame = !visible() && link.closest('.bottom-navigation') ? document.querySelector('iframe.app-section-frame:not([hidden])') : null;
        if (activeFrame) activeFrame.contentWindow.webprilAnalytics?.track('action', { action });
        else track('action', { action });
      }
      const primaryTab = ['index.html', 'journey.html', 'ai.html', 'club.html', 'profile.html'].includes(destination) && window.navigateApp;
      if (destination !== page && !primaryTab) track('transition', { page: destination, fromPage: page });
    }
    if (event.target.closest('#points-trigger')) track('action', { action: 'points_open' });
    if (event.target.closest('[data-action="calendar"], [data-calendar-open]')) track('action', { action: 'calendar_open' });
  }, true);
  setInterval(() => { sample(); syncVisibility(); checkArticle(); for (const item of media) if (!item.video.isConnected) media.delete(item); }, 15000);
  setInterval(() => { void flush(); }, 30000);
})();
