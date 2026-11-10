(() => {
  const card = document.querySelector('#weekly-poll-card');
  const section = document.querySelector('#weekly-poll');
  const url = '/api/auth/weekly-poll';
  const discussion = document.querySelector('#weekly-poll-discussion');
  const voteForms = { one: 'голос', few: 'голоса', many: 'голосов' };
  const plural = new Intl.PluralRules('ru');
  const numbers = new Intl.NumberFormat('ru');
  let refreshTimer;
  let requestedFocus = new URLSearchParams(location.search).has('poll');

  async function request(options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw Error(data.message || 'Голосование временно недоступно.');
    return data;
  }

  function render({ poll, accountId }) {
    if (card) {
      card.hidden = !poll?.open;
      if (!card.hidden) card.querySelector('.article-title').textContent = poll.question;
    }
    if (!section) return;
    section.hidden = !poll;
    discussion.hidden = !poll?.open || poll.choice === null;
    if (discussion.hidden) discussion.removeAttribute('href');
    else discussion.href = 'club-chat.html?room=' + encodeURIComponent('weekly-poll:' + poll.id);
    if (!poll) return;

    const question = section.querySelector('h2');
    question.textContent = poll.question;
    if (requestedFocus && location.hash === '#events') {
      requestedFocus = false;
      question.focus();
    }
    const form = section.querySelector('form');
    const status = section.querySelector('[role="status"]');
    const fieldset = form.querySelector('fieldset');
    const submit = form.querySelector('button');
    const results = section.querySelector('ol');
    form.hidden = !poll.open || poll.choice !== null;
    submit.disabled = true;
    const counts = poll.counts || [];
    const total = counts.reduce((sum, count) => sum + count, 0);
    const totalLabel = section.querySelector('.weekly-poll-total');
    totalLabel.hidden = results.hidden = !poll.counts;
    totalLabel.textContent = numbers.format(total) + ' ' + voteForms[plural.select(total)];
    results.replaceChildren(...counts.map((count, index) => {
      const item = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'weekly-poll-result-row';
      const option = document.createElement('span');
      option.textContent = poll.options[index];
      if (index === poll.choice) {
        item.classList.add('is-own-vote');
        const mark = document.createElement('span');
        mark.className = 'weekly-poll-vote-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = '✓';
        option.append(' ', mark);
      }
      const share = total ? count / total * 100 : 0;
      const percent = document.createElement('strong');
      percent.textContent = Math.round(share) + '%';
      const bar = document.createElement('progress');
      bar.max = 100;
      bar.value = share;
      bar.setAttribute('aria-hidden', 'true');
      row.append(option, percent);
      item.append(row, bar);
      return item;
    }));
    status.textContent = poll.open
      ? (poll.choice === null ? '' : 'Ответ принят: ' + poll.options[poll.choice])
      : poll.settled
        ? (poll.points === null ? 'Голосование завершено.' : 'Начислено баллов: ' + poll.points)
        : 'Голосование завершено. Подводим итоги.';
    fieldset.disabled = false;
    fieldset.replaceChildren(...poll.options.map((option, index) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'choice';
      input.value = index;
      input.required = true;
      label.append(input, option);
      return label;
    }));
    form.onchange = () => { submit.disabled = false; };
    form.onsubmit = async event => {
      event.preventDefault();
      const selected = new FormData(form).get('choice');
      if (selected === null || submit.disabled) return;
      submit.disabled = true;
      fieldset.disabled = true;
      try {
        const vote = await request({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webpril-Account': accountId },
          body: JSON.stringify({ pollId: poll.id, choice: Number(selected) })
        });
        render({ poll: { ...poll, choice: vote.choice, counts: vote.counts }, accountId });
        if (!discussion.hidden) {
          if (window.navigateApp) window.navigateApp(discussion.href);
          else location.assign(discussion.href);
        }
      } catch (error) {
        status.textContent = error.message;
        submit.disabled = false;
        fieldset.disabled = false;
      }
    };
  }

  async function load() {
    clearTimeout(refreshTimer);
    try {
      const data = await request();
      render(data);
      if (data.poll?.open) {
        const delay = new Date(data.poll.closesAt).getTime() - Date.now();
        refreshTimer = setTimeout(() => {
          if (discussion && Date.now() >= new Date(data.poll.closesAt).getTime()) discussion.hidden = true;
          load();
        }, Math.max(1000, Math.min(delay, 2_147_000_000)));
      } else if (data.poll && !data.poll.settled) {
        refreshTimer = setTimeout(load, 3000);
      }
    } catch {
      if (card) card.hidden = true;
      if (discussion) discussion.hidden = true;
    }
  }
  window.addEventListener('pageshow', event => { if (event.persisted) load(); });
  load();
})();
