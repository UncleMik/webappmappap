const scroller = document.querySelector('.reader-scroll');
const sections = [...document.querySelectorAll('.reader-section')];
const progress = document.querySelector('.reader-progress progress');
const counter = document.querySelector('.reader-progress output');
let scheduled = false;
function updateProgress() {
  const top = scroller.getBoundingClientRect().top;
  const position = top + scroller.clientHeight * .45;
  let current = 0;
  sections.forEach((section, index) => {
    if (section.getBoundingClientRect().top <= position) current = index;
  });
  progress.value = current + 1;
  counter.value = `${current + 1}/${sections.length}`;
  scheduled = false;
}
scroller.addEventListener('scroll', () => {
  if (!scheduled) { scheduled = true; requestAnimationFrame(updateProgress); }
}, { passive: true });
new ResizeObserver(updateProgress).observe(scroller);
const fromJourney = new URLSearchParams(location.search).get('from') === 'journey';
const returnUrl = fromJourney ? 'journey.html#weekly-articles-title' : 'index.html#recommendations-title';
document.querySelectorAll('[data-reader-return]').forEach(link => { link.href = returnUrl; });
if (fromJourney) {
  document.querySelectorAll('.nav-item').forEach(link => {
    const active = link.getAttribute('href') === 'journey.html';
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}
updateProgress();
