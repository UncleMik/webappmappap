(() => {
  document.querySelectorAll('.content-carousel, .recommendations-carousel').forEach(carousel => {
    const list = carousel.querySelector('.article-list, .course-list, .video-list, .article-grid');
    let cover, pending;
    function update() {
      pending = false;
      if (!cover) return;
      const image = cover.getBoundingClientRect();
      if (!image.height) return;
      const center = image.top + image.height / 2 - carousel.getBoundingClientRect().top;
      carousel.style.setProperty('--carousel-cover-center', `${center}px`);
    }
    function schedule() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(update);
    }
    const resize = new ResizeObserver(schedule);
    resize.observe(carousel);
    function observeCover() {
      const next = list.querySelector('.journey-photo, .school-article-cover');
      if (next !== cover) {
        if (cover) resize.unobserve(cover);
        cover = next;
        if (cover) resize.observe(cover);
      }
      schedule();
    }
    new MutationObserver(observeCover).observe(list, { childList: true, subtree: true });
    observeCover();
  });
})();
