(() => {
  // One public catalogue for cards and the player. File URLs are issued by the server after sign-in.
  window.webprilWeeklyVideos = Object.freeze([
    Object.freeze({ id: 'contractions-lesson', title: 'Типы дыхания в схватках', duration: 703, label: '11:43' }),
    Object.freeze({ id: 'back-relief-video', title: 'Массаж, самомассаж', duration: 202, label: '3:22' }),
    Object.freeze({ id: 'birth-breathing-video', title: 'Позы и дыхание в потугах', duration: 602, label: '10:02' }),
  ]);
  document.querySelectorAll('.journey-page .video-card').forEach(card => {
    const item = window.webprilWeeklyVideos.find(video => video.id === card.dataset.action);
    if (!item) return;
    card.querySelector('h3').textContent = item.title;
    card.querySelector('.photo-duration').textContent = item.label;
  });
})();
