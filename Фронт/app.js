/* Integration point for future screens. Existing pages use native page links.
   Host applications can subscribe to `today:navigate` and supply their router. */
document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  window.dispatchEvent(new CustomEvent('today:navigate', {
    detail: { destination: control.dataset.action },
  }));
});
