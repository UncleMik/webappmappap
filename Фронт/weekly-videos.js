(() => {
  // One public catalogue for cards and the player. File URLs are issued by the server after sign-in.
  window.webprilWeeklyVideos = Object.freeze([
    Object.freeze({ id: 'contractions-lesson', title: 'Витамины и дефициты во время беременности', duration: 506, label: '8:26', image: 'assets/weekly-vitamins.png' }),
    Object.freeze({ id: 'back-relief-video', title: 'Самомассаж головы и расслабление', duration: 298, label: '4:58', image: 'assets/weekly-head-massage.png' }),
    Object.freeze({ id: 'birth-breathing-video', title: 'Практика поддержки и уверенности в себе', duration: 153, label: '2:33', image: 'assets/weekly-confidence.png' }),
  ]);
  document.querySelectorAll('.journey-page .video-card').forEach(card => {
    const item = window.webprilWeeklyVideos.find(video => video.id === card.dataset.action);
    if (!item) return;
    const photo = card.querySelector('.video-photo');
    photo.classList.add('weekly-video-photo');
    const image = document.createElement('img');
    image.src = item.image; image.alt = ''; image.width = 1200; image.height = 800;
    image.loading = 'lazy'; image.decoding = 'async'; photo.prepend(image);
    card.querySelector('h3').textContent = item.title;
    card.querySelector('.photo-duration').textContent = item.label;
  });
})();
