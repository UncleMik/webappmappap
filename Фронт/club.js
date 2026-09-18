(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const query = document.querySelector('#club-query');
  const empty = document.querySelector('.club-empty');
  const notice = document.querySelector('.club-notice');
  let active = 'chats';

  function filterEntries() {
    const text = query.value.trim().toLocaleLowerCase('ru');
    const access = document.querySelector('[name="access"]:checked').value;
    let count = 0;
    document.querySelectorAll(`#${active}-panel .club-section`).forEach(section => {
      let visible = 0;
      section.querySelectorAll('.club-entry').forEach(entry => {
        entry.hidden = (access !== 'all' && section.dataset.access !== access) || !entry.textContent.toLocaleLowerCase('ru').includes(text);
        if (!entry.hidden) visible++;
      });
      section.hidden = visible === 0;
      count += visible;
    });
    empty.hidden = count > 0;
    notice.hidden = true;
  }

  function selectTab(name, updateUrl = true) {
    active = name === 'events' ? 'events' : 'chats';
    tabs.forEach(tab => {
      const selected = tab.id === `${active}-tab`;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    });
    if (updateUrl) history.replaceState(null, '', active === 'events' ? '#events' : location.pathname + location.search);
    filterEntries();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.id.replace('-tab', '')));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[1 - index];
      next.focus();
      selectTab(next.id.replace('-tab', ''));
    });
  });
  for (const kind of ['search', 'filter']) {
    const button = document.getElementById(`${kind}-toggle`);
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    button.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      button.setAttribute('aria-expanded', String(!panel.hidden));
      if (kind === 'search') {
        if (!panel.hidden) query.focus();
        else { query.value = ''; filterEntries(); }
      }
    });
  }
  query.addEventListener('input', filterEntries);
  document.querySelectorAll('[name="access"]').forEach(input => input.addEventListener('change', filterEntries));
  document.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click', () => {
    notice.querySelector('p').textContent = button.dataset.preview;
    notice.hidden = false;
  }));
  notice.querySelector('button').addEventListener('click', () => { notice.hidden = true; });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    notice.hidden = true;
    for (const button of document.querySelectorAll('.club-tool[aria-expanded="true"]')) {
      button.click();
      button.focus();
    }
  });
  window.addEventListener('hashchange', () => selectTab(location.hash.slice(1), false));
  selectTab(location.hash.slice(1), false);
})();
