(() => {
  // One public catalogue for cards and the player. File URLs are issued by the server after sign-in.
  window.webprilWeeklyVideos = Object.freeze([
    Object.freeze({
      id: "contractions-lesson",
      title: "Витамины и дефициты во время беременности",
      duration: 506,
      label: "8:26",
      image: "assets/weekly-vitamins.png",
      description: "В уроке разбираются витамины и микроэлементы во время беременности. Вы узнаете, как выявляют дефициты и что в уроке говорится о приёме нутрицевтиков без анализов.",
      chapters: Object.freeze([
        Object.freeze({"seconds": 88, "label": "Из-за чего происходит дефицит витаминов в организме?"}),
        Object.freeze({"seconds": 141, "label": "Что мы должны получать с едой?"}),
        Object.freeze({"seconds": 158, "label": "Почему витамины так важны для нас?"}),
        Object.freeze({"seconds": 288, "label": "Дефицит витаминов группы В"}),
        Object.freeze({"seconds": 393, "label": "Омега 3 жирные кислоты, Магний, Витамин Д"}),
      ]),
    }),
    Object.freeze({
      id: "back-relief-video",
      title: "Самомассаж головы и расслабление",
      duration: 298,
      label: "4:58",
      image: "assets/weekly-head-massage.png",
      description: "В видео показан самомассаж головы. Практика посвящена проработке мышц головы и расслаблению.",
      chapters: Object.freeze([
      ]),
    }),
    Object.freeze({
      id: "birth-breathing-video",
      title: "Практика поддержки и уверенности в себе",
      duration: 153,
      label: "2:33",
      image: "assets/weekly-confidence.png",
      description: "В видео — практика поддержки и уверенности в себе. Она посвящена ситуациям, когда не хватает поддержки и ресурса, одиноко или грустно.",
      chapters: Object.freeze([
      ]),
    }),
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
