/* Aggregate reports only; authorization is checked by the server for every request. */
window.WebprilAnalyticsAdmin = ({root, api}) => {
  const node = (tag, text, cls) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (cls) element.className = cls;
    return element;
  };
  const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const count = value => number(value).toLocaleString('ru-RU');
  const duration = value => {
    if (number(value) < 60000) return `${Math.round(number(value) / 1000)} с`;
    const minutes = Math.floor(number(value) / 60000);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : `${minutes} мин`;
  };
  const date = value => {
    const parsed = value && new Date(value);
    return parsed && Number.isFinite(parsed.getTime())
      ? new Intl.DateTimeFormat('ru-RU', {dateStyle:'short', timeStyle:'short', timeZone:'Europe/Moscow'}).format(parsed) + ' МСК'
      : 'пока не определено';
  };
  const labels = {
    today:'Сегодня', home:'Сегодня', index:'Сегодня', path:'Мой путь', my_path:'Мой путь',
    articles:'Статьи', article:'Статья', videos:'Видео', video:'Видео', lesson:'Урок курса', courses:'Курсы',
    club:'Клуб', ai:'Лара', chat:'Лара', profile:'Профиль', calendar:'Календарь',
    text:'Текст', file:'Файл', analysis:'Анализ', voice:'Голос', success:'Успешно', error:'Ошибка',
    ai_limit:'Лимит вопросов Ларе', ai_error:'Ошибка ответа Лары', network:'Ошибка сети', unavailable:'Недоступно',
    'index.html':'Сегодня', 'journey.html':'Мой путь', 'ai.html':'Лара', 'club.html':'Клуб', 'profile.html':'Профиль', 'article.html':'Статья', 'articles.html':'Статьи', 'baby.html':'Малыш', 'mom.html':'Мама', 'club-chat.html':'Чат клуба', 'courses.html':'Курсы', 'favorites.html':'Избранное', 'my-courses.html':'Мои курсы', 'personal-data.html':'Личные данные', 'video.html':'Видео', 'about.html':'О приложении',
    nav_open:'Переход из навигации', course_open:'Открытие курса', lesson_open:'Открытие урока', video_open:'Открытие видео', favorite_add:'Добавление в избранное', favorite_remove:'Удаление из избранного', points_open:'Открытие звёздочек', calendar_open:'Открытие календаря', poll_vote:'Голосование', ai_open:'Открытие Лары', ai_voice_transcribed:'Распознавание голоса', accepted:'Принят', completed:'Ответ получен', failed:'Не выполнен', limit:'Достигнут лимит',
    external_video_open:'Открытие внешнего видео', video_external_open:'Открытие внешнего видео'
  };
  const title = value => labels[value] || String(value || 'Не указано');
  let days = 30, request = 0, report, notice, filter, refresh, enabled = false;
  function clear() { enabled = false; ++request; root.replaceChildren(); root.removeAttribute('aria-busy'); }
  function build() {
    root.replaceChildren(node('h2', 'Аналитика'));
    root.append(node('p', 'Общая активность в приложении. Без истории отдельных учениц.', 'muted'));
    const toolbar = node('div', undefined, 'toolbar');
    const label = node('label', 'Период'); filter = node('select'); filter.setAttribute('aria-label', 'Период');
    for (const value of [7,30,90]) { const option = node('option', `${value} дней`); option.value = value; filter.append(option); }
    filter.value = days; label.append(filter); toolbar.append(label);
    refresh = node('button', 'Обновить'); refresh.type = 'button'; toolbar.append(refresh); root.append(toolbar);
    notice = node('p', '', 'status'); notice.setAttribute('role','status'); notice.setAttribute('aria-live','polite'); root.append(notice);
    report = node('div'); report.id = 'analytics-report'; root.append(report);
    filter.addEventListener('change', () => { days = Number(filter.value); void load(); });
    refresh.addEventListener('click', () => void load());
  }
  function block(heading, explanation) {
    const box = node('section', undefined, 'surface analytics-block'); box.append(node('h3', heading));
    if (explanation) box.append(node('p', explanation, 'muted'));
    report.append(box); return box;
  }
  function rows(heading, values, render, explanation) {
    const box = block(heading, explanation), list = node('ul', undefined, 'list');
    const bounded = Array.isArray(values) ? values.slice(0, 100) : [];
    for (const row of bounded) { const item = node('li'); render(item,row); list.append(item); }
    if (!bounded.length) box.append(node('p', 'За этот период данных нет.', 'muted'));
    else box.append(list);
    if (values?.length >= 100) box.append(node('p', 'Показаны первые 100 строк.', 'muted'));
  }
  function detail(item, text) { item.append(node('span', text, 'meta')); }
  function render(data) {
    const info = block('Период и актуальность');
    info.append(node('p', `${data.period.from} — ${data.period.to} · по Москве`));
    info.append(node('p', 'Сбор начат: ' + date(data.collectionStartedAt), 'muted'));
    info.append(node('p', 'Отчёт обновлён: ' + date(data.generatedAt), 'muted'));
    info.append(node('p', 'События хранятся 90 дней. Данные появляются по мере посещений.', 'muted'));
    const overview = data.overview;
    if (!number(overview.users) && !number(overview.screenViews) && !number(overview.visits)) {
      const empty = node('p', 'Данные появятся после посещений.', 'surface'); empty.id = 'analytics-empty'; report.append(empty); return;
    }
    const summary = block('Активность'), grid = node('dl', undefined, 'analytics-metrics');
    for (const [label,value] of [['Активные пользователи',count(overview.users)],['Открытия экранов',count(overview.screenViews)],['Активное время',duration(overview.activeMs)]]) {
      const cell = node('div'); cell.append(node('dt',label),node('dd',value)); grid.append(cell);
    }
    summary.append(grid,node('p','Активное время — приблизительная оценка времени с открытым видимым приложением и недавними действиями. Это не подтверждение прочтения или просмотра.', 'muted'));
    rows('По дням', data.daily, (item,row) => {
      item.append(node('strong',row.day)); detail(item, `${count(row.users)} пользователей · ${count(row.views)} открытий · ${duration(row.activeMs)}`);
    });
    rows('Популярные разделы', data.screens, (item,row) => {
      item.append(node('strong',title(row.page))); detail(item, `${count(row.users)} пользователей · ${count(row.views)} открытий · ${duration(row.activeMs)}`);
    });
    rows('Материалы', data.content, (item,row) => {
      item.append(node('strong',row.title || `${title(row.type)} · ${row.id}`)); detail(item, `${title(row.type)} · ${count(row.users)} пользователей · ${count(row.opens)} открытий · ${duration(row.activeMs)}`);
      if (row.type === 'article') {
        detail(item, `Прокрутка до 25%: ${count(row.progress25)} · 50%: ${count(row.progress50)} · 75%: ${count(row.progress75)} · 90%: ${count(row.progress90)}`);
        detail(item, `Конец страницы с активным чтением: ${count(row.completed)}`);
      }
    }, 'Открытие и прокрутка материала не подтверждают прочтение. Название берётся из каталога; если оно недоступно, показан номер материала.');
    rows('Видео и уроки', data.videos, (item,row) => {
      item.append(node('strong',row.title || `${title(row.type)} · ${row.id}`));
      detail(item, `${count(row.users)} пользователей · ${count(row.opens)} открытий · ${count(row.starts)} запусков плеера`);
      detail(item, `Достигли 25%: ${count(row.progress25)} · 50%: ${count(row.progress50)} · 75%: ${count(row.progress75)} · 90%: ${count(row.progress90)}`);
      detail(item, `Завершений: ${count(row.completed)}`);
    }, 'Запуски и прогресс доступны у встроенного плеера. Достижение отметки не подтверждает непрерывный просмотр. Открытие внешнего видео показано в нажатиях и не считается просмотром.');
    rows('Важные нажатия', data.actions, (item,row) => { item.append(node('strong',title(row.action))); detail(item, `${count(row.count)} нажатий · ${count(row.users)} пользователей`); });
    rows('Основные переходы', data.transitions, (item,row) => { item.append(node('strong',`${title(row.from)} → ${title(row.to)}`)); detail(item, `${count(row.count)} переходов · ${count(row.users)} пользователей`); });
    rows('Использование Лары', data.ai, (item,row) => { item.append(node('strong',`${title(row.format)} · ${title(row.outcome)}`)); detail(item, `${count(row.count)} событий · ${count(row.users)} пользователей`); }, 'Принятие запроса и получение ответа показаны отдельно: их нельзя складывать как число вопросов. Тексты вопросов, ответов и файлы сюда не передаются.');
    rows('Ошибки и ограничения', data.errors, (item,row) => { item.append(node('strong',title(row.action))); detail(item, `${count(row.count)} событий · ${count(row.users)} пользователей`); });
  }
  async function load() {
    if (!enabled) { enabled = true; build(); }
    const current = ++request;
    report.replaceChildren(); notice.classList.remove('error'); notice.textContent = 'Загружаем отчёт…'; refresh.disabled = true;
    root.setAttribute('aria-busy','true');
    try {
      const data = await api('analytics?days=' + days);
      if (!enabled || current !== request) return;
      if (!data?.overview || !data?.period || !data.generatedAt) throw new Error('invalid_report');
      render(data); notice.textContent = '';
    } catch {
      if (!enabled || current !== request) return;
      report.replaceChildren(); notice.textContent = 'Не удалось загрузить отчёт. Нажмите «Обновить», чтобы повторить.'; notice.classList.add('error');
    } finally {
      if (enabled && current === request) { refresh.disabled = false; root.removeAttribute('aria-busy'); }
    }
  }
  return {load, clear};
};
