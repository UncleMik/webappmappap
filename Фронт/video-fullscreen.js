(() => {
  const stage = document.querySelector('.video-stage');
  const button = document.querySelector('#video-fullscreen');
  if (!stage || !button) return;
  const hint = document.querySelector('#video-rotate-hint');
  const tools = stage.querySelector('.video-fullscreen-tools');
  const nativeHint = document.createElement('p');
  nativeHint.className = 'video-orientation-note'; nativeHint.hidden = true;
  nativeHint.textContent = 'Для горизонтального просмотра поверните телефон.';
  stage.after(nativeHint);
  const timeline = document.querySelector('.video-timeline');
  const controls = document.querySelector('.video-controls');
  const timelineHome = document.createComment('timeline');
  const controlsHome = document.createComment('controls');
  timeline.before(timelineHome); controls.before(controlsHome);
  const portrait = matchMedia('(orientation: portrait)');
  const mobile = matchMedia('(pointer: coarse)');
  let video, active = false, native = false, pending = false, locked = false;
  let needsRotation = false, attempt = 0;

  function render() {
    button.disabled = !active && (video ? video.readyState < 1 : !stage.querySelector('iframe'));
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active ? 'Выйти из полного экрана' : 'На весь экран');
    button.querySelector('path').setAttribute('d', active
      ? 'M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5'
      : 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5');
    hint.hidden = !(active && needsRotation && portrait.matches);
    // Safari's native player cannot display page overlays: show its cue before
    // the user enters fullscreen, while the page is still visible.
    nativeHint.hidden = !(mobile.matches && portrait.matches && video?.webkitEnterFullscreen
      && video.videoWidth > video.videoHeight);
  }
  function unlock() {
    if (locked) { try { screen.orientation?.unlock(); } catch { /* Browser-owned orientation. */ } }
    locked = false;
  }
  function enter(isNative = false) {
    hint.textContent = 'Поверните телефон для горизонтального просмотра';
    active = true; native = isNative;
    if (!native) {
      tools.append(timeline, controls); tools.hidden = false;
      stage.classList.add('video-is-fullscreen');
    }
    render();
  }
  function leave() {
    ++attempt; active = false; native = false; needsRotation = false;
    unlock();
    timelineHome.after(timeline); controlsHome.after(controls);
    tools.hidden = true; stage.classList.remove('video-is-fullscreen'); render();
  }
  async function rotate(token) {
    // Portrait recordings retain their natural orientation.
    if (!mobile.matches || (video?.videoWidth && video.videoWidth <= video.videoHeight)) return;
    try {
      if (!screen.orientation?.lock) throw new Error('orientation unavailable');
      await screen.orientation.lock('landscape');
      locked = true;
      if (!active || token !== attempt) unlock();
    } catch {
      if (active && token === attempt) { needsRotation = true; render(); }
    }
  }
  function changed() {
    const element = document.fullscreenElement || document.webkitFullscreenElement;
    if (element === stage) {
      if (!active) { enter(); void rotate(attempt); }
    } else if (active && !native) leave();
  }
  function observePlayer() {
    const current = stage.querySelector('video');
    if (current && current !== video) {
      video = current;
      video.addEventListener('loadedmetadata', render);
      video.addEventListener('emptied', render);
      video.addEventListener('webkitbeginfullscreen', () => {
        enter(true);
        needsRotation = mobile.matches && video.videoWidth > video.videoHeight;
        render();
      });
      video.addEventListener('webkitendfullscreen', leave);
    }
    button.disabled = !active && (video ? video.readyState < 1 : !stage.querySelector('iframe'));
  }
  new MutationObserver(observePlayer).observe(stage, { childList: true, subtree: true });
  observePlayer();
  button.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    const token = ++attempt;
    try {
      if (active) {
        if (native) video.webkitExitFullscreen();
        else if (document.exitFullscreen) await document.exitFullscreen();
        else await document.webkitExitFullscreen();
        return;
      }
      hint.textContent = 'Поверните телефон для горизонтального просмотра';
      try {
        if (stage.requestFullscreen) await stage.requestFullscreen();
        else if (stage.webkitRequestFullscreen) await stage.webkitRequestFullscreen();
        else throw new Error('fullscreen unavailable');
        if ((document.fullscreenElement || document.webkitFullscreenElement) !== stage) return;
        if (!active) { enter(); void rotate(token); }
      } catch (failure) {
        if (!video?.webkitEnterFullscreen) throw failure;
        // Native iPhone fullscreen owns its controls and overlays. Keep the
        // instruction in the page as well, since it cannot overlay native video.
        needsRotation = mobile.matches && video.videoWidth > video.videoHeight;
        hint.hidden = !needsRotation || !portrait.matches;
        video.webkitEnterFullscreen();
      }
    } catch {
      hint.textContent = active ? 'Не удалось выйти. Используйте кнопку выхода браузера.'
        : 'Браузер не разрешил полный экран. Попробуйте повернуть телефон.';
      hint.hidden = false;
    } finally { pending = false; }
  });
  portrait.addEventListener('change', render);
  document.addEventListener('fullscreenchange', changed);
  document.addEventListener('webkitfullscreenchange', changed);
  addEventListener('pagehide', leave);
})();
