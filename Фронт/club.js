(() => {
 const tabs = [...document.querySelectorAll('[data-tab]')];
 const query = document.querySelector('#club-query');
 const notice = document.querySelector('.club-notice');
 let active = 'pregnancy';
 function filter() {
  const text = query.value.trim().toLocaleLowerCase('ru');
  let count = 0;
  document.querySelectorAll('[data-category]').forEach(panel => {
   panel.hidden = panel.dataset.category !== active;
   if (panel.hidden) return;
   panel.querySelectorAll('.community-section, .club-section').forEach(section => {
    let visible = 0;
    section.querySelectorAll('.club-entry').forEach(row => {
     row.hidden = !row.textContent.toLocaleLowerCase('ru').includes(text);
     if (!row.hidden) visible++;
    });
    section.hidden = !visible;
    count += visible;
   });
  });
  document.querySelector('.club-empty').hidden = count > 0;
 }
 function select(name) {
  active = tabs.some(tab => tab.dataset.tab === name) ? name : 'pregnancy';
  tabs.forEach(tab => {
   const selected = tab.dataset.tab === active;
   tab.setAttribute('aria-selected', selected);
   tab.tabIndex = selected ? 0 : -1;
  });
  document.querySelector('#community-content').setAttribute('aria-labelledby', active + '-tab');
  filter();
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
 const search = document.querySelector('#search-toggle');
 search.addEventListener('click', () => {
  const panel = document.querySelector('#club-search');
  panel.hidden = !panel.hidden;
  search.setAttribute('aria-expanded', !panel.hidden);
  if (!panel.hidden) query.focus();
  else { query.value = ''; filter(); }
 });
 query.addEventListener('input', filter);
 document.querySelectorAll('[data-notice], [data-preview]').forEach(button => button.addEventListener('click', () => {
  notice.querySelector('p').textContent = button.dataset.notice || button.dataset.preview;
  notice.hidden = false;
 }));
 notice.querySelector('button').addEventListener('click', () => { notice.hidden = true; });
 document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
   notice.hidden = true;
   if (search.getAttribute('aria-expanded') === 'true') { search.click(); search.focus(); }
  }
 });
 window.addEventListener('hashchange', () => select(location.hash.slice(1)));
 window.addEventListener('popstate', () => select(location.hash.slice(1)));
 select(location.hash.slice(1));
})();
