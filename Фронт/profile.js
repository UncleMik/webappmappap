(() => {
  const notice = document.querySelector('.profile-notice');
  document.querySelectorAll('[data-pending]').forEach(button => {
    button.addEventListener('click', () => {
      notice.querySelector('p').textContent = `Раздел «${button.dataset.pending}» пока в разработке.`;
      notice.hidden = false;
    });
  });
  notice.querySelector('button').addEventListener('click', () => { notice.hidden = true; });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') notice.hidden = true;
  });
})();
