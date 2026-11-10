(() => {
 const carousel = document.querySelector('.speaker-carousel');
 if (carousel) {
  const slides = [...carousel.querySelectorAll('.speaker-slide')];
  const dots = [...carousel.querySelectorAll('[data-speaker]')];
  const biographies = [...carousel.querySelectorAll('.speaker-full-bio')];
  const toggle = carousel.querySelector('#speaker-toggle');
  let current = 0, timer, expanded = false;
  function expand(value) {
   if (!toggle || !biographies[current]) return;
   expanded = value;
   biographies.forEach((bio, i) => { bio.hidden = !expanded || i !== current; });
   slides.forEach((slide, i) => {
    slide.querySelector('.speaker-description').hidden = expanded && i === current;
    slide.querySelector('.speaker-role').hidden = expanded && i === current;
   });
   toggle.textContent = expanded ? 'Свернуть' : 'Подробнее';
   toggle.setAttribute('aria-expanded', String(expanded));
   toggle.setAttribute('aria-controls', biographies[current].id);
   if (!expanded && document.activeElement === toggle) {
    const box = toggle.getBoundingClientRect(), bottom = document.querySelector('.bottom-navigation')?.getBoundingClientRect().top ?? innerHeight;
    if (box.top < 0 || box.bottom > Math.min(innerHeight, bottom)) toggle.scrollIntoView({ block: 'nearest' });
   }
  }
  function show(index) {
   current = index; expand(false);
   slides.forEach((slide, i) => {
    slide.classList.toggle('is-active', i === current);
    slide.setAttribute('aria-hidden', String(i !== current));
    slide.inert = i !== current;
   });
   dots.forEach((dot, i) => {
    if (i === current) dot.setAttribute('aria-current', 'true');
    else dot.removeAttribute('aria-current');
   });
  }
  function schedule() {
   clearInterval(timer);
   if (!document.hidden && !expanded) timer = setInterval(() => show((current + 1) % slides.length), 5000);
  }
  dots.forEach(dot => dot.addEventListener('click', () => { show(Number(dot.dataset.speaker)); schedule(); }));
  toggle?.addEventListener('click', () => { expand(!expanded); schedule(); });
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('pagehide', () => clearInterval(timer));
  window.addEventListener('pageshow', schedule);
  schedule();
 }
 const tabs = [...document.querySelectorAll('[data-tab]')];
 const empty = document.querySelector('.club-empty');
 let active = 'participants';
 function updatePanels() {
  let hasEntries = false;
  document.querySelectorAll('[data-category]').forEach(panel => {
   panel.hidden = panel.dataset.category !== active;
   if (panel.hidden) return;
   panel.querySelectorAll('.community-section, .club-section').forEach(section => {
    section.hidden = !section.querySelector('.club-entry');
    hasEntries ||= !section.hidden;
   });
  });
  empty.hidden = active === 'events' || hasEntries;
  empty.textContent = 'Чаты пока не подключены.';
 }
 function select(name) {
  active = tabs.some(tab => tab.dataset.tab === name) ? name : 'participants';
  tabs.forEach(tab => {
   const selected = tab.dataset.tab === active;
   tab.setAttribute('aria-selected', selected);
   tab.tabIndex = selected ? 0 : -1;
  });
  document.querySelector('#community-content').setAttribute('aria-labelledby', active + '-tab');
  updatePanels();
 }
 tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => { history.pushState(null, '', '#' + tab.dataset.tab);
   select(tab.dataset.tab); });
  tab.addEventListener('keydown', event => {
   if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
   event.preventDefault();
   const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
   tabs[index].focus();
   history.pushState(null, '', '#' + tabs[index].dataset.tab);
   select(tabs[index].dataset.tab);
  });
 });
 window.addEventListener('hashchange', () => select(location.hash.slice(1)));
 window.addEventListener('popstate', () => select(location.hash.slice(1)));
 document.addEventListener('club:entries-changed', updatePanels);
 select(location.hash.slice(1));
})();
