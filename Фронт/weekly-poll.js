(() => {
  const card = document.querySelector('#weekly-poll-card');
  const section = document.querySelector('#weekly-poll');
  const url = '/api/auth/weekly-poll';
  let refreshTimer;
  let requestedFocus = new URLSearchParams(location.search).has('poll');

  async function request(options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw Error(data.message || 'Голосование временно недоступно.');
    return data;
  }

  function render({ poll, points, accountId }) {
    if (card) {
      card.hidden = !poll?.open;
      if (!card.hidden) card.querySelector('.article-title').textContent = poll.question;
    }
    if (!section) return;
    const balance = document.querySelector('#weekly-poll-points');
    balance.hidden = false;
    balance.textContent = 'Баллы за голосования: ' + points;
    section.hidden = !poll;
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
    results.hidden = !poll.counts;
    results.replaceChildren(...(poll.counts || []).map((count, index) => {
      const item = document.createElement('li');
      item.textContent = poll.options[index] + ' — ' + count;
      return item;
    }));
    status.textContent = poll.open
      ? (poll.choice === null ? '' : 'Ответ принят: ' + poll.options[poll.choice])
      : poll.counts
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
        render({ poll: { ...poll, choice: vote.choice }, points, accountId });
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
        refreshTimer = setTimeout(load, Math.max(1000, Math.min(delay, 2_147_000_000)));
      } else if (data.poll && !data.poll.counts) {
        refreshTimer = setTimeout(load, 3000);
      }
    } catch {
      if (card) card.hidden = true;
    }
  }
  load();
})();
