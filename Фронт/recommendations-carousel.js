(() => {
  document.querySelectorAll('.recommendations-carousel').forEach(carousel => {
    const list = carousel.querySelector('.article-grid');
    carousel.querySelectorAll('button').forEach(button => {
      button.addEventListener('click', () => {
        const card = list.querySelector('.school-article-card');
        if (!card) return;
        const distance = card.getBoundingClientRect().width + parseFloat(getComputedStyle(list).gap);
        list.scrollBy({
          left: distance * (button.classList.contains('recommendations-next') ? 1 : -1),
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
        });
      });
    });
  });
})();
