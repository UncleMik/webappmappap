(() => {
  const $ = selector => document.querySelector(selector);
  const workspace = $('#workspace'), status = $('#status');
  const dates = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' });
  const preview = $('#preview'), previewCopy = $('#preview-copy'), previewStatus = $('#preview-status');
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const describeDate = value => dates.format(new Date(value)) + ' МСК';
  let account, section = 'articles', loading = 0, previewAction, leaving = false;

  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function button(text, click, label) {
    const item = node('button', text);
    item.type = 'button';
    if (label) item.setAttribute('aria-label', label);
    item.addEventListener('click', click);
    return item;
  }
  function label(text, field) {
    const item = node('label');
    item.append(node('span', text), field);
    return item;
  }
  function message(text, error = false, target = status) {
    target.textContent = text;
    target.classList.toggle('error', error);
  }
  function leave(hash = '') {
    if (leaving) return;
    leaving = true;
    workspace.replaceChildren();
    if (preview.open) preview.close();
    previewCopy.replaceChildren();
    $('#identity').textContent = '';
    $('#logout').hidden = true;
    location.replace('/admin/login' + hash);
  }
  async function api(path, body) {
    const headers = {};
    if (account) headers['X-Webpril-Account'] = account.id;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/admin/' + path, { method: body === undefined ? 'GET' : 'POST',
      headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (response.status === 401 || data.error === 'account_changed') leave();
    else if (data.error === 'admin_forbidden' && path !== 'staff') leave('#access');
    throw new Error(data.message || 'Не удалось выполнить действие. Попробуйте ещё раз.');
  }
  async function act(control, run, target = status) {
    if (control.disabled) return;
    control.disabled = true;
    message('', false, target);
    try { await run(); }
    catch (error) { message(error.message, true, target); }
    finally { control.disabled = false; }
  }
  function setList(selector, rows, render, empty) {
    $(selector).replaceChildren(...(rows.length ? rows.map(render) : [node('li', empty, 'muted')]));
  }
  function showPreview(title, content, submitLabel, action) {
    $('#preview-title').textContent = title;
    previewCopy.replaceChildren(...content);
    message('', false, previewStatus);
    $('#confirm-preview').textContent = submitLabel;
    previewAction = action;
    preview.showModal();
    $('#close-preview').focus();
  }
  $('#confirm-preview').addEventListener('click', event => {
    const action = previewAction;
    if (!action) return;
    const close = $('#close-preview');
    close.disabled = true;
    void act(event.currentTarget, action, previewStatus).finally(() => { close.disabled = false; });
  });
  $('#close-preview').addEventListener('click', () => preview.close());
  preview.addEventListener('cancel', event => { if ($('#confirm-preview').disabled) event.preventDefault(); });
  preview.addEventListener('close', () => { previewAction = undefined; });

  const filter = $('#article-filter'), sort = $('#article-sort'), articleForm = $('#article-form'), coverInput = $('#article-cover');
  const blockContainer = $('#article-blocks'), coverPreview = $('#cover-preview');
  const articlePreview = articleForm.querySelector('[type=submit]');
  const typeLabels = { paragraph: 'Абзац', heading: 'Подзаголовок', 'list-item': 'Пункт списка' };
  let articles = [], article, cover, coverUrl, removeCover = false, coverChange = 0;
  const articlesPerPage = 10;
  let articlePage = 1;
  filter.add(new Option('Все недели', 'all'));
  for (let week = 1; week <= 42; week++) {
    filter.add(new Option(String(week), String(week)));
    articleForm.elements.week.add(new Option(String(week), String(week)));
  }
  function addBlock(block = { type: 'paragraph', text: '' }) {
    const row = node('div', undefined, 'block');
    const type = node('select'), content = node('textarea'), actions = node('div', undefined, 'actions');
    Object.entries(typeLabels).forEach(([key, title]) => type.add(new Option(title, key)));
    type.value = block.type;
    content.value = block.text;
    content.maxLength = 20_000;
    content.rows = 3;
    content.required = true;
    actions.append(button('Выше', () => row.previousElementSibling?.before(row), 'Переместить блок выше'),
      button('Ниже', () => row.nextElementSibling?.after(row), 'Переместить блок ниже'),
      button('Удалить', () => { row.remove(); if (!blockContainer.childElementCount) addBlock(); }, 'Удалить блок'));
    row.append(label('Тип блока', type), label('Текст блока', content), actions);
    blockContainer.append(row);
    return content;
  }
  function setCoverSource(src) {
    coverPreview.hidden = !src;
    $('#remove-cover').hidden = !src;
    if (src) coverPreview.src = src;
    else coverPreview.removeAttribute('src');
  }
  function resetCover() {
    coverChange++;
    if (coverUrl) URL.revokeObjectURL(coverUrl);
    cover = coverUrl = undefined;
    coverInput.value = '';
    articlePreview.disabled = false;
  }
  function openArticle(item) {
    article = item;
    resetCover();
    removeCover = false;
    $('#article-editor-title').textContent = item ? 'Редактирование статьи' : 'Новая статья';
    articleForm.elements.title.value = item?.title ?? '';
    articleForm.elements.week.value = String(item?.week ?? (filter.value === 'all' ? 1 : filter.value));
    const imageName = item?.image?.match(/^\/uploads\/articles\/([a-z0-9-]+\.webp)$/)?.[1];
    setCoverSource(imageName ? '/admin/cover/' + imageName : '');
    blockContainer.replaceChildren();
    (item?.blocks.length ? item.blocks : [undefined]).forEach(addBlock);
    articleForm.hidden = false;
    articleForm.elements.title.focus();
  }
  $('#new-article').addEventListener('click', () => openArticle());
  $('#add-block').addEventListener('click', () => addBlock().focus());
  $('#close-article').addEventListener('click', () => { articleForm.hidden = true; resetCover(); });
  $('#remove-cover').addEventListener('click', () => { resetCover(); removeCover = true; setCoverSource(''); });
  coverInput.addEventListener('change', async () => {
    const file = coverInput.files[0];
    if (!file) return;
    const ticket = ++coverChange;
    articlePreview.disabled = true;
    try {
      if (file.size > 15_000_000) throw new Error();
      const image = await createImageBitmap(file);
      const ratio = Math.min(1, 960 / Math.max(image.width, image.height));
      const canvas = node('canvas');
      canvas.width = Math.max(1, Math.round(image.width * ratio));
      canvas.height = Math.max(1, Math.round(image.height * ratio));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.82));
      if (!blob || blob.type !== 'image/webp' || blob.size > 450_000) throw new Error();
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      if (ticket !== coverChange) return;
      if (coverUrl) URL.revokeObjectURL(coverUrl);
      cover = data.split(',')[1];
      coverUrl = URL.createObjectURL(blob);
      removeCover = false;
      setCoverSource(coverUrl);
      message('');
    } catch {
      if (ticket === coverChange) message('Не удалось подготовить обложку. Выберите другое изображение.', true);
    } finally {
      if (ticket === coverChange) articlePreview.disabled = false;
    }
  });
  articleForm.addEventListener('submit', event => {
    event.preventDefault();
    const item = article;
    const body = { title: articleForm.elements.title.value, week: Number(articleForm.elements.week.value),
      blocks: Array.from(blockContainer.children, row => ({ type: row.querySelector('select').value, text: row.querySelector('textarea').value })),
      revision: item?.revision, requestId: crypto.randomUUID(), cover, removeCover };
    const content = [node('p', 'Неделя ' + body.week, 'meta'), node('h3', body.title)];
    if (!coverPreview.hidden) {
      const image = node('img', undefined, 'cover');
      image.alt = '';
      image.src = coverPreview.src;
      content.push(image);
    }
    let list;
    for (const block of body.blocks) {
      if (block.type === 'list-item') {
        if (!list) { list = node('ul'); content.push(list); }
        list.append(node('li', block.text, 'body-copy'));
      } else {
        list = null;
        content.push(node(block.type === 'heading' ? 'h3' : 'p', block.text, 'body-copy'));
      }
    }
    showPreview('Предпросмотр статьи', content, 'Опубликовать статью', async () => {
      const saved = await api('articles' + (item ? '/' + item.id : ''), body);
      preview.close();
      openArticle(saved);
      await reload();
      message('Статья опубликована.');
    });
  });
  function renderArticles() {
    const rows = articles.filter(item => filter.value === 'all' || String(item.week) === filter.value);
    // Article numbers increase with each new article, independently of its week or edits.
    rows.sort((a, b) => sort.value === 'oldest' ? a.number - b.number : b.number - a.number);
    const pageCount = Math.max(1, Math.ceil(rows.length / articlesPerPage));
    articlePage = Math.min(Math.max(1, articlePage), pageCount);
    const start = (articlePage - 1) * articlesPerPage;
    $('#article-pages').hidden = pageCount === 1;
    $('#articles-prev').disabled = articlePage === 1;
    $('#articles-next').disabled = articlePage === pageCount;
    $('#articles-page').textContent = 'Страница ' + articlePage + ' из ' + pageCount;
    setList('#article-list', rows.slice(start, start + articlesPerPage), item => {
      const row = node('li'), actions = node('div', undefined, 'actions'), visible = item.status === 'published';
      actions.append(button('Редактировать', event => void act(event.currentTarget, async () => openArticle(await api('articles/' + item.id)))),
        button(visible ? 'Скрыть' : 'Вернуть', () => {
          const body = { visible: !visible, revision: item.revision, requestId: crypto.randomUUID() };
          showPreview(visible ? 'Скрыть статью?' : 'Вернуть статью?', [node('p', item.title)], visible ? 'Скрыть' : 'Вернуть', async () => {
            const saved = await api('articles/' + item.id + '/visibility', body);
            preview.close();
            if (!articleForm.hidden && article?.id === item.id) openArticle(saved);
            await reload();
            message(visible ? 'Статья скрыта.' : 'Статья снова доступна.');
          });
        }));
      row.append(node('strong', item.title), node('span', 'Неделя ' + item.week + ' · ' + (visible ? 'Опубликована' : 'Скрыта'), 'meta'), actions);
      return row;
    }, 'На этой неделе пока нет статей.');
  }
  filter.addEventListener('change', () => { articlePage = 1; renderArticles(); });
  sort.addEventListener('change', () => { articlePage = 1; renderArticles(); });
  $('#articles-prev').addEventListener('click', () => { articlePage--; renderArticles(); });
  $('#articles-next').addEventListener('click', () => { articlePage++; renderArticles(); });

  const announcementForm = $('#announcement-form');
  announcementForm.addEventListener('submit', event => {
    event.preventDefault();
    const body = { ...Object.fromEntries(new FormData(announcementForm)), id: crypto.randomUUID() };
    const content = [node('p', 'Получатели: все ученицы с аккаунтом', 'meta'),
      node('h3', body.title), node('p', body.body, 'body-copy')];
    if (body.link.trim()) content.push(node('p', body.link, 'meta'));
    showPreview('Предпросмотр объявления', content, 'Опубликовать для всех', async () => {
      await api('announcements', body);
      preview.close();
      announcementForm.reset();
      await reload();
      message('Объявление опубликовано.');
    });
  });
  function renderAnnouncements(rows) {
    setList('#announcement-list', rows, item => {
      const row = node('li');
      row.append(node('strong', item.title), node('span', describeDate(item.publishedAt) + (item.hiddenAt ? ' · Снято' : ' · Опубликовано'), 'meta'),
        node('p', item.body, 'body-copy'));
      if (!item.hiddenAt) row.append(button('Снять', () => {
        showPreview('Снять объявление?', [node('p', item.title)], 'Снять', async () => {
          await api('announcements/' + item.id + '/hide', {});
          preview.close();
          await reload();
          message('Объявление снято.');
        });
      }));
      return row;
    }, 'Пока нет объявлений.');
  }

  const pollForm = $('#poll-form'), pollOptions = $('#poll-options');
  const pollStatuses = { scheduled: 'Запланировано', open: 'Открыто', closed: 'Завершено' };
  let poll;
  function renumberOptions() {
    [...pollOptions.children].forEach((row, index) => {
      row.querySelector('label').firstChild.textContent = 'Вариант ' + (index + 1);
      row.querySelector('button').hidden = pollOptions.childElementCount <= 2;
    });
    $('#add-option').disabled = pollOptions.childElementCount >= 8;
  }
  function addOption(value = '') {
    const row = node('div', undefined, 'option'), field = node('input');
    field.value = value;
    field.required = true;
    field.maxLength = 150;
    row.append(label('', field), button('Удалить вариант', () => { row.remove(); renumberOptions(); }));
    pollOptions.append(row);
    renumberOptions();
    return field;
  }
  function editPoll(item) {
    poll = item;
    pollForm.reset();
    const now = new Date(Date.now() + 3 * 3600_000);
    const nextMonday = new Date(+now + ((8 - now.getUTCDay()) % 7 || 7) * 86_400_000).toISOString().slice(0, 10);
    pollForm.elements.week.value = item?.id ?? nextMonday;
    pollForm.elements.week.readOnly = Boolean(item);
    pollForm.elements.question.value = item?.question ?? '';
    $('#poll-editor-title').textContent = item ? 'Изменить запланированное голосование' : 'Новое голосование';
    $('#reset-poll').hidden = !item;
    pollOptions.replaceChildren();
    (item?.options ?? ['', '']).forEach(addOption);
    if (item) pollForm.elements.question.focus();
  }
  editPoll();
  $('#add-option').addEventListener('click', () => addOption().focus());
  $('#reset-poll').addEventListener('click', () => editPoll());
  pollForm.addEventListener('submit', event => {
    event.preventDefault();
    void act(event.submitter, async () => {
      await api('polls', { week: pollForm.elements.week.value, question: pollForm.elements.question.value,
        options: [...pollOptions.querySelectorAll('input')].map(input => input.value), revision: poll?.revision });
      editPoll();
      await reload();
      message('Голосование запланировано.');
    });
  });
  function renderPolls(rows) {
    setList('#poll-list', rows, item => {
      const row = node('li'), options = node('ul', undefined, 'poll-results');
      item.options.forEach((option, index) => {
        options.append(node('li', option + (item.status === 'scheduled' ? '' : ' · ' + item.counts[index])));
      });
      row.append(node('strong', item.question), node('span', pollStatuses[item.status], 'meta'),
        node('span', describeDate(item.opensAt) + ' — ' + describeDate(item.closesAt), 'meta'), options);
      if (item.status === 'scheduled') row.append(button('Изменить', () => editPoll(item)));
      return row;
    }, 'Пока нет голосований.');
  }

  const staffForm = $('#staff-form');
  staffForm.addEventListener('submit', event => {
    event.preventDefault();
    void act(event.submitter, async () => {
      renderStaff(await api('staff', { email: staffForm.elements.email.value, grant: true }));
      staffForm.reset();
      message('Доступ выдан.');
    });
  });
  function renderStaff(rows) {
    setList('#staff-list', rows, item => {
      const row = node('li');
      row.append(node('strong', item.email), node('span', 'Выдан ' + describeDate(item.grantedAt), 'meta'), button('Отозвать доступ', () => {
        showPreview('Отозвать доступ?', [node('p', item.email)], 'Отозвать доступ', async () => {
          renderStaff(await api('staff', { email: item.email, grant: false }));
          preview.close();
          message('Доступ отозван.');
        });
      }));
      return row;
    }, 'Доступ есть только у владельца.');
  }

  const actionLabels = {
    article_published: 'Статья опубликована', article_hidden: 'Статья скрыта', article_restored: 'Статья возвращена',
    announcement_published: 'Объявление опубликовано', announcement_hidden: 'Объявление снято',
    poll_scheduled: 'Голосование запланировано', staff_granted: 'Доступ выдан', staff_revoked: 'Доступ отозван',
  };
  function renderHistory(rows) {
    setList('#history-list', rows, item => {
      const row = node('li');
      row.append(node('strong', actionLabels[item.action]), node('span', item.target, 'meta'),
        node('span', (item.actor ?? 'Аккаунт удалён') + ' · ' + describeDate(item.occurredAt), 'meta'));
      return row;
    }, 'Действий пока нет.');
  }
  const renderers = { articles: rows => { articles = rows; renderArticles(); },
    announcements: renderAnnouncements, polls: renderPolls, staff: renderStaff, history: renderHistory };
  async function reload() {
    const id = ++loading, selected = section;
    try {
      const data = await api(selected);
      if (id === loading && !leaving) renderers[selected](data);
    } catch (error) {
      if (id === loading && !leaving) message(error.message, true);
    }
  }
  for (const tab of tabs) tab.addEventListener('click', () => {
    if (section === tab.dataset.tab) return;
    section = tab.dataset.tab;
    for (const button of tabs) {
      const active = button === tab;
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
      $('#' + button.dataset.tab).hidden = !active;
    }
    message('');
    void reload();
  });
  $('#logout').addEventListener('click', event => void act(event.currentTarget, async () => {
    await api('logout', {});
    leave();
  }));
  let checking = false;
  async function check() {
    if (checking || leaving) return;
    checking = true;
    try {
      const user = await api('session');
      if (account && user.id !== account.id) { leave(); return; }
      const wasHidden = workspace.hidden;
      account = user;
      $('#identity').textContent = (user.role === 'owner' ? 'Владелец' : 'Редактор') + ' · ' + user.email;
      $('[data-tab=staff]').hidden = user.role !== 'owner';
      $('#logout').hidden = false;
      workspace.hidden = false;
      if (wasHidden) { message(''); await reload(); }
    } catch (error) {
      if (!leaving) { workspace.hidden = true; if (preview.open) preview.close(); message(error.message, true); }
    } finally { checking = false; }
  }
  void check();
  setInterval(check, 30_000);
  addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
})();
