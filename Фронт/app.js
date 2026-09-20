/* Video destinations share the same player, including practice and course cards. */
(() => {
  const videoActions = new Set(['back-practice', 'breathing', 'practice-article', 'birth-course', 'back-course', 'confidence-course', 'baby-course', 'contractions-lesson', 'birth-breathing-video', 'back-relief-video', 'webinars']);
  const from = location.pathname.split('/').pop().replace('.html', '') || 'index';
  const videoUrl = id => `video.html?id=${encodeURIComponent(id === 'birth-course' && ['baby', 'articles', 'article'].includes(from) ? 'baby-birth-lesson' : id)}&from=${encodeURIComponent(from === 'article' ? 'articles' : from)}`;
  document.querySelectorAll('a[href*="article.html?"]').forEach(link => {
    const id = new URL(link.href).searchParams.get('id');
    if (videoActions.has(id)) link.href = videoUrl(id);
  });
  document.addEventListener('click', event => {
    const control = event.target.closest('[data-action], [data-preview]');
    if (!control) return;
    const id = control.dataset.action || (control.dataset.preview?.includes('вебинар') ? 'webinars' : '');
    if (id === 'my-lessons') {
      event.stopPropagation();
      location.href = 'my-courses.html';
    } else if (videoActions.has(id)) {
      event.preventDefault();
      event.stopPropagation();
      location.href = videoUrl(id);
    }
  }, true);
})();

/* Integration point for future screens. Existing pages use native page links.
   Host applications can subscribe to `today:navigate` and supply their router. */
document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  window.dispatchEvent(new CustomEvent('today:navigate', {
    detail: { destination: control.dataset.action },
  }));
});
