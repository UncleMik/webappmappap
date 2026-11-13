import * as api from './gamification-api.js?v=20261112-stars';

const page = document.querySelector('.app');
const main = page?.querySelector('main');
const file = location.pathname.split('/').pop() || 'index.html';
const isToday = file === 'index.html';
const money = value => new Intl.NumberFormat('ru-RU').format(Number(value) || 0);
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const button = (text, activate, primary = false) => { const node = el('button', 'stars-button' + (primary ? ' primary' : ''), text); node.type = 'button'; node.dataset.starsFocus = text; node.addEventListener('click', activate); return node; };
const card = (title, parent) => { const box = el('section', 'stars-card'); if (title) box.append(el('h3', '', title)); parent.append(box); return box; };
const text = (parent, value, muted = false) => { if (value) parent.append(el('p', muted ? 'stars-muted' : '', value)); };
const row = parent => { const node = el('div', 'stars-row'); parent.append(node); return node; };
const list = value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.entries(value).map(([id, item]) => ({ id, ...item })) : [];
const available = value => value === true || value?.available === true || value?.enabled === true;
let state, modal, body, modalStatus, enhancedUi, legacyUi, presentationHost, tab = 'wallet', mutation = false, refreshId = 0;
let presentationBusy=false,presentationTimer,pendingPresentation=null,presentationDialog=null,hintNode=null,hintDeferred=false,wasTodayVisible=false;
const presentationAttempts=new Set(),presentationSessionId=crypto.randomUUID();
let walletState = null, quota = null, historyRows = null, historyCursor = null, notificationPrefs = null, visitAccount = null, packPurchasesRemaining = null;
const root = el('section', 'stars-shell'); root.hidden = true; root.setAttribute('aria-label', 'Твой день и звёздочки');
// Activities render only inside the explicitly opened points window.
const globalStatus = el('p', 'stars-status'); globalStatus.setAttribute('role', 'status'); globalStatus.setAttribute('aria-live', 'polite'); root.append(globalStatus);
const content = el('div'); root.append(content);
const trigger = document.querySelector('#points-trigger');

function feature(name) {
  const alias = {peekNextWeek:'peek_next_week',capsule:'time_capsule',firstKick:'first_kick',kickRecord:'kicks_daily'}[name] || name;
  if (typeof state?.settings?.features?.[name] === 'boolean') return state.settings.features[name];
  return available(state?.features?.[alias]);
}
function paused() { return state?.preferences?.babyPause === true; }
function notice(message) { (modal?.open ? modalStatus : globalStatus).textContent = message; }
function rewardMessage(result) {
  const reward = result?.reward;
  const amount = reward?.actualAmount ?? reward?.amount ?? (typeof reward === 'number' ? reward : null);
  return amount !== null ? (amount > 0 ? `+${money(amount)} ★` : reward?.duplicate ? 'Сохранено без повторной награды.' : state?.wallet?.dailyRemaining === 0 ? 'Сохранено. Дневной запас звёздочек уже использован.' : 'Сохранено. Новых звёздочек за это действие нет.') : 'Сохранено';
}
async function run(target, execute, success) {
  if (mutation) return;
  mutation = true; target.disabled = true;
  const id = state?.accountId;
  const focusKey = target.dataset.starsFocus || target.getAttribute('aria-label') || target.name;
  const previous = target.textContent; target.textContent = 'Сохраняем…';
  notice('');
  try {
    const result = await execute();
    if (state?.accountId !== id) return;
    notice(success || rewardMessage(result));
    window.dispatchEvent(new CustomEvent('stars:changed'));
    if (state?.preferences) {
      const owner = window.top;
      for (const view of [owner, ...Array.from(owner.frames)]) if (view !== window) {
        try { view.dispatchEvent(new CustomEvent('stars:privacy', { detail: {accountId:state.accountId,babyPause:paused()} })); } catch {}
      }
    }
  } catch (error) {
    if (error.code === 'account_changed' || [401,403].includes(error.status) && error.code === 'sign_in_required') { reset(); return; }
    notice(error.message || 'Не удалось сохранить. Повторите действие.');
  } finally {
    mutation = false; if (target.isConnected) { target.disabled = false; target.textContent = previous; }
    else if (state?.accountId===id && focusKey && document.activeElement===document.body) {
      const scope = modal?.open ? body : content;
      [...scope.querySelectorAll('button,input,textarea')].find(node=>(node.dataset.starsFocus || node.getAttribute('aria-label') || node.name)===focusKey)?.focus({preventScroll:true});
    }
  }
}
function actionButton(parent, title, payload, primary = false) {
  const node = button(title, () => run(node, () => api.action(payload)), primary); parent.append(node); return node;
}
function createModal() {
  if (modal) return;
  modal = document.querySelector('#points-dialog') || el('dialog');
  legacyUi = el('div'); legacyUi.dataset.legacyPointsUi='';legacyUi.append(...modal.childNodes);modal.append(legacyUi);
  enhancedUi=el('div');enhancedUi.dataset.starsUi='';modal.append(enhancedUi);
  modal.classList.add('stars-dialog');modal.setAttribute('aria-labelledby','stars-title');legacyUi.hidden=true;
  const header = el('header'); header.append(el('h2', '', 'Звёздочки и твой день')); header.firstChild.id = 'stars-title';
  const close = button('×', () => modal.close()); close.setAttribute('aria-label', 'Закрыть'); header.append(close);
  const tabs = el('div', 'stars-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Звёздочки и возможности');
  for (const [id, label] of [['wallet','Баллы'],['today','Твой день'],['tools','Мои дела'],['letters','Письма'],['preferences','Настройки']]) {
    const item = button(label, () => switchTab(id)); item.className = 'stars-tab'; item.dataset.tab = id; item.id = 'stars-tab-' + id; item.setAttribute('role','tab'); item.setAttribute('aria-controls','stars-panel');
    item.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); const items = [...tabs.children], index = items.indexOf(item);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
      items[next].click(); items[next].focus();
    }); tabs.append(item);
  }
  modalStatus = el('p', 'stars-status'); modalStatus.setAttribute('role','status'); modalStatus.setAttribute('aria-live','polite');
  body = el('div'); body.id = 'stars-panel'; body.setAttribute('role', 'tabpanel');
  presentationHost=el('div');presentationHost.className='stars-presentation-host';
  enhancedUi.append(header,tabs,modalStatus,presentationHost,body);if(!modal.isConnected)document.body.append(modal);
  modal.addEventListener('close',()=>{presentationDialog?.close();hintNode?.remove();hintNode=null;hintDeferred=false;wasTodayVisible=false;});
  modal.addEventListener('click', event => { if (event.target !== modal) return; const rect = modal.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) modal.close(); });
}
async function open(which = 'wallet') {
  if (!state?.enabled) return;
  packPurchasesRemaining = null; createModal();legacyUi.hidden=true;enhancedUi.hidden=false;modal.classList.add('stars-dialog');modal.setAttribute('aria-labelledby','stars-title');switchTab(which);if(!modal.open)modal.showModal();modal.scrollTop=0;schedulePresentation();
  const version = ++refreshId, account = state.accountId;
  try {
    const [value, quotaResult, historyResult, notifications] = await Promise.all([api.wallet(), api.aiQuota().catch(() => null), api.history().catch(() => null), api.notificationState().catch(() => null)]);
    if (version !== refreshId || state?.accountId !== account) return;
    const purchasesRemaining = await availablePackPurchases(historyResult,quotaResult?.quota);
    if (version !== refreshId || state?.accountId !== account) return;
    if (quotaResult?.quota) quota = quotaResult.quota;
    packPurchasesRemaining=purchasesRemaining; notificationPrefs=notifications; walletState = value; historyRows = historyResult?.history || value.wallet?.history || []; historyCursor = historyResult?.nextCursor ?? null; if (tab === 'wallet' || tab === 'preferences') renderModal();
  } catch (error) { if (version === refreshId && modal.open && state?.accountId === account) notice(error.message); }
}
async function availablePackPurchases(first, currentQuota) {
  if (!first?.history || !currentQuota?.serverTime || !state) return null;
  const day = timestamp => new Date(Date.parse(timestamp)+3*3600000).toISOString().slice(0,10);
  const today=day(currentQuota.serverTime),limit=state.tier==='course' ? state.settings?.ai?.coursePurchases ?? 1 : state.settings?.ai?.freePurchases ?? 2;
  let page=first,count=0;
  const seen=new Set();
  while(page) {
    for(const item of page.history) if(item.kind==='ai_pack'&&!seen.has(item.id)&&day(item.occurredAt)===today){count++;seen.add(item.id);}
    if(count>=limit || !page.nextCursor || !page.history.length || day(page.history.at(-1).occurredAt)<today)break;
    page=await api.history(page.nextCursor);
  }
  return Math.max(0,limit-count);
}
function switchTab(which) {
  tab = which; modalStatus.textContent = '';
  modal.querySelectorAll('[data-tab]').forEach(item => { const selected = item.dataset.tab === tab; item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1; });
  body.setAttribute('aria-labelledby', 'stars-tab-' + tab); renderModal();
}
function instruction(parent) {
  const details = el('details', 'stars-guide'); details.append(el('summary', '', 'Инструкция')); const box = el('div');
  const r = state.settings?.rewards || {}, limits = state.settings?.limits || {}, prices = state.settings?.prices || {}, ai = state.settings?.ai || {};
  const rules = [
    'Звёздочки не сгорают. Их нельзя купить за деньги, обменять на деньги, курс или скидку.',
    `За первое заполнение срока — ${r.welcome ?? 100} ★ один раз. Старый баланс сохраняется.`,
    `Самочувствие — ${r.checkin ?? 5} ★, сюрприз — ${r.surprise ?? 5} ★, первое сообщение в Клубе за день — ${r.clubMessage ?? 5} ★. Ответ на вопрос — ${r.mythAnswer ?? 5} ★ и ещё ${r.mythCorrect ?? 5} ★ за правильный.`,
    `Статья — ${r.article ?? 10} ★: дочитайте до конца и проведите за активным чтением 30 секунд. Бесплатное видео — ${r.video ?? 20} ★ после 80% уникального просмотра. Урок купленного курса — ${r.courseLesson ?? 30} ★ после 80% каждого обязательного видео.`,
    `Дневной запас — ${limits.freeDaily ?? 100} ★ без курса, ${limits.courseDaily ?? 150} ★ с курсом. Недельного предела нет. Начисляется только остаток; прогресс засчитывается даже при нулевой награде. Повтор материала награду не добавляет.`,
    `Все доступные материалы недели — ${r.weekComplete ?? 50} ★ и письмо. За недели до знакомства — только письмо. Изученное заранее даёт прогресс; недельный бонус приходит после наступления срока. За материал, завершённый заранее, награды позже не будет.`,
    `Голосование — ${r.poll ?? 20} ★ сразу и ещё ${r.pollMajority ?? 10} ★ за вариант большинства после закрытия. При ничьей выигрывают все лидирующие варианты. Голосование открыто с понедельника 10:00 до воскресенья 18:00 МСК.`,
    `Квест — ${r.quest ?? 15} ★, первое шевеление — ${r.firstKick ?? 15} ★ и запечатанная капсула — ${r.capsule ?? 15} ★ один раз; завершение триместра — ${r.trimester ?? 30} ★. Запись шевелений с 28-й недели — ${r.kicks ?? 5} ★ в день. Бонусы недели, голосования, квестов, капсулы и триместра сверх дневного запаса.`,
    `За ${prices.peekNextWeek ?? 100} ★ можно открыть только следующую за текущей неделю; доступ сохраняется. Календарь доступен на весь срок. Купленные курсы открываются по своим условиям.`,
    `Без курса: ${ai.freeDaily ?? 5} бесплатных вопросов AI в день, пакет ${ai.freePack ?? 3} вопроса за ${prices.aiPackFree ?? 50} ★, до ${ai.freePurchases ?? 2} покупок и до ${ai.freePaidDaily ?? 6} купленных вопросов в день. С курсом: ${ai.courseDaily ?? 30} бесплатных, пакет ${ai.coursePack ?? 10} за ${prices.aiPackCourse ?? 100} ★, до ${ai.coursePurchases ?? 1} покупки и до ${ai.coursePaidDaily ?? 10} купленных вопросов в день.`,
    'Все обращения к AI входят в общий лимит: сообщение, фото или файл расходует один запрос. Сначала расходуются бесплатные запросы, затем полученные за баллы. Купленный запас не сгорает; сбой ответа возвращает расход. День начинается в 00:00 МСК.',
    'Новые возможности появляются постепенно по сроку и времени знакомства. Пауза сообщений о малыше сохраняет накопления и обучение.'
  ];
  for (const rule of rules) text(box, rule); details.append(box); parent.append(details);
}
function renderWallet() {
  const w = walletState?.wallet || state.wallet || {};
  text(body, money(w.balance) + ' ★'); body.lastChild.className = 'stars-balance';
  if (Number.isFinite(w.dailyRemaining)) text(body, `Можно получить сегодня: ${money(w.dailyRemaining)} из ${money(w.dailyLimit)} ★`, true);
  const offers = card('Возможности', body);
  const next = state.currentWeek + 1;
  const purchased = walletState?.purchasedWeeks || state.purchasedWeeks || [];
  const nextWeek = (walletState?.weekProgress || state.weekProgress || state.weeks || []).find(item=>item.week===next);
  if (feature('peekNextWeek') && next <= 42 && nextWeek?.locked === true && !purchased.includes(next)) {
    const cost = state.settings?.prices?.peekNextWeek ?? 100;
    text(offers, `${next}-я неделя раньше срока — ${cost} ★. Баланс после покупки: ${money(Math.max(0, w.balance - cost))} ★.`);
    const buy = button(`Открыть ${next}-ю неделю за ${cost} ★`, () => confirmPurchase({kind:'peek_next_week',week:next}, `${next}-я неделя`, cost), true);
    buy.disabled = w.balance < cost; offers.append(buy);
    text(offers, 'Статьи, видео и описания «Мама» и «Малыш». Изученные заранее материалы дают прогресс без награды за просмотр.', true);
  }
  const ai = state.settings?.ai || {}, paid = state.tier === 'course';
  const stock = quota?.paidRemaining ?? walletState?.aiCredits ?? state.aiCredits;
  if (stock !== undefined) text(offers, `Купленных вопросов в запасе: ${money(stock)}. Они не сгорают.`);
  if (feature('aiPacks') && state.settings?.aiBudgetApproved !== false && (quota?.paidDailyRemaining ?? 1) > 0 && (state.aiPurchasesRemaining ?? packPurchasesRemaining ?? 0) > 0) {
    const units = paid ? ai.coursePack ?? 10 : ai.freePack ?? 3, price = paid ? state.settings?.prices?.aiPackCourse ?? 100 : state.settings?.prices?.aiPackFree ?? 50;
    const today = Math.min(units, quota?.paidDailyRemaining ?? (paid ? ai.coursePaidDaily ?? 10 : ai.freePaidDaily ?? 6));
    text(offers, `${units} вопроса AI — ${price} ★. Из нового пакета сегодня можно использовать до ${today}. Баланс после покупки: ${money(Math.max(0, w.balance - price))} ★.`);
    const buy = button(`Купить пакет за ${price} ★`, () => confirmPurchase({kind:'ai_pack'}, `${units} вопроса AI`, price), true); buy.disabled = w.balance < price; offers.append(buy);
  }
  if (quota?.paidDailyRemaining === 0) text(offers, 'Купленный запас сохранён. Дневной предел его использования обновится в полночь по Москве.', true);
  const history = card('История звёздочек', body), rows = historyRows || w.history || [];
  const ul = el('ul','stars-history');
  const names = {welcome:'Знакомство',checkin:'Как ты сегодня',surprise:'Сюрприз',myth_answer:'Ответ на вопрос',myth_correct:'Верный ответ',article_read:'Прочтение статьи',video_watch:'Просмотр видео',course_lesson:'Урок курса',week_complete:'Все материалы недели',weekly_poll:'Голосование',poll:'Голосование',poll_majority:'Вариант большинства',club_message:'Сообщение в Клубе',kick_record:'Запись шевелений',kicks:'Запись шевелений',quest:'Квест',first_kick:'Первое шевеление',capsule:'Капсула времени',trimester:'Завершение триместра',peek_next_week:'Открытие недели',ai_pack:'Пакет вопросов AI'};
  for (const item of rows) {
    const li = el('li'); li.append(el('span','',names[item.kind] || item.label || 'Звёздочки'));
    const date = new Date(item.occurredAt); if (Number.isFinite(+date)) { const time = el('time','',new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Moscow'}).format(date) + ' МСК'); time.dateTime = item.occurredAt; li.append(time); }
    li.append(el('strong','',(item.amount > 0 ? '+' : '') + money(item.amount) + ' ★')); ul.append(li);
  }
  if (!rows.length) text(history,'Операций пока нет.',true); history.append(ul);
  if (historyCursor) {
    const more = button('Показать ещё',async()=>{
      more.disabled=true;const account=state.accountId;
      try {const page=await api.history(historyCursor);if(state?.accountId!==account)return;historyRows=[...new Map([...historyRows,...page.history].map(row=>[row.id,row])).values()];historyCursor=page.nextCursor;renderModal();}catch(error){notice(error.message);more.disabled=false;}
    });history.append(more);
  }
  instruction(body);
}
function confirmPurchase(payload, title, cost) {
  body.replaceChildren(); text(body, title); text(body, `Стоимость: ${cost} ★. Подтвердить покупку?`);
  const actions = row(body); const confirm = button(`Подтвердить — ${cost} ★`, () => run(confirm, async () => {
    const result = await api.purchase(payload);
    const [value,q,h] = await Promise.all([api.wallet(),api.aiQuota(),api.history()]);
    walletState=value;quota=q.quota;historyRows=h.history;historyCursor=h.nextCursor;packPurchasesRemaining=await availablePackPurchases(h,quota);renderModal();return result;
  }, 'Покупка сохранена. Возможность уже доступна.'), true);
  actions.append(confirm, button('Назад', () => renderModal()));
}
function renderLetters() {
  if (paused()) { text(body,'Сообщения о малыше на паузе. Письма и прогресс сохраняются.'); return; }
  const values = list(state.letters);
  if (!values.length) text(body,'Завершите доступные материалы недели, чтобы получить письмо.',true);
  for (const letter of values) {
    const box = card(`${letter.week}-я неделя`, body); box.classList.add('stars-letter');
    text(box, letter.text);
    const share = button('Поделиться открыткой', async () => {
      try {
        const data = {title:`Моя ${letter.week}-я неделя`,text:letter.text};
        if (navigator.share) await navigator.share(data);
        else { await navigator.clipboard.writeText(`${data.title}\n\n${data.text}`); notice('Текст открытки скопирован.'); }
      } catch (error) { if (error.name !== 'AbortError') notice('Не удалось поделиться. Вы можете выделить и скопировать текст письма.'); }
    }); box.append(share);
  }
}
function renderChecklists(parent) {
  for (const [listId, items] of Object.entries(state.checklists || {})) {
    if (!items.length) continue;
    const checklist = {id:listId,items};
    if (checklist.available === false) continue;
    const id = checklist.id || checklist.list;
    const box = card(checklist.title || (id === 'bag' ? 'Сумка в роддом' : 'Вопросы врачу'),parent);
    if (id === 'bag') text(box,'Отметьте 80% подходящих пунктов. Пункты «Не относится ко мне» не входят в цель; повторный квест не добавляет награду.',true);
    for (const item of list(checklist.items)) {
      const label = el('label','stars-check'), check = el('input'); check.type = 'checkbox'; check.checked = item.status === 'done'; check.setAttribute('aria-label',item.text || item.title);
      const copy = el('span','',item.text || item.title); label.append(check,copy);
      check.addEventListener('change', () => run(check, () => api.action({type:'checklist_update',list:id,itemId:item.id,status:check.checked?'done':'todo'}))); box.append(label);
      if (id === 'doctor') {
        const details = el('details'), summary = el('summary','','Мои заметки к вопросу'), note = el('textarea'); note.value = item.note || ''; note.maxLength = 2000; note.setAttribute('aria-label','Заметка: ' + item.text);
        const save = button('Сохранить заметку', () => run(save, () => api.action({type:'checklist_update',list:id,itemId:item.id,status:item.status || 'todo',note:note.value}))); details.append(summary,note,save); box.append(details);
      }
      if (item.conditional) { const skip = button(item.status === 'na' ? 'Снова относится ко мне' : 'Не относится ко мне', () => run(skip, () => api.action({type:'checklist_update',list:id,itemId:item.id,status:item.status === 'na'?'todo':'na'}))); box.append(skip); }
    }
  }
}
function renderTools() {
  for (const quest of list(state.quests)) {
    if (quest.available === false) continue;
    if (quest.type === 'bag') continue;
    const box = card(quest.title || quest.text,body); text(box,quest.description || quest.text);
    if (quest.medical || quest.personalRecord) text(box,'Это ваша личная отметка, а не подтверждение медицинской процедуры школой.',true);
    if (quest.done || quest.completed) text(box,'Выполнено ✓'); else actionButton(box,'Отметить выполнение',{type:'quest_done',questId:quest.id},true);
  }
  renderChecklists(body);
  if (feature('firstKick') && !paused()) {
    const box = card('Первое шевеление',body); if (state.firstKick) text(box,'Первое шевеление сохранено.'); else actionButton(box,'Я почувствовала первое шевеление',{type:'first_kick'},true);
  }
  if (feature('kickRecord') && !paused()) { const box = card('Шевеления',body); if (state.kicks) text(box,'Сегодняшняя запись сохранена.');
    actionButton(box,'Сохранить запись шевелений',{type:'kick_record'},true); }
  if (state.capsule && !paused() && feature('capsule')) {
    const capsule = state.capsule, box = card('Капсула времени',body);
    if (capsule.opened) text(box,capsule.text);
    else if (capsule.saved) {
      text(box,'Письмо запечатано. Оно откроется через месяц после указанной в профиле даты рождения малыша.');
      const remove = button('Удалить письмо', () => { const confirm = button('Подтвердить удаление', () => run(confirm, () => api.action({type:'capsule_delete'}))); box.append(confirm); remove.disabled = true; }); box.append(remove);
    } else {
      text(box,'Личное письмо себе до 2000 знаков. После запечатывания его можно удалить, прочитать — через месяц после рождения малыша.');
      const form = el('form'), label = el('label','','Письмо себе'), input = el('textarea'); input.required = true; input.maxLength = 2000; input.name = 'capsule'; label.append(input);
      const count = el('p','stars-muted','0 / 2000'); input.addEventListener('input', () => { count.textContent = `${input.value.length} / 2000`; });
      const save = button('Запечатать письмо', () => {} ,true); save.type = 'submit'; form.append(label,count,save);
      form.addEventListener('submit',event => { event.preventDefault(); if (form.reportValidity()) void run(save, () => api.action({type:'capsule_save',text:input.value.trim()})); }); box.append(form);
    }
  }
  if (!body.children.length) text(body,'Все текущие дела завершены. Доступные материалы можно посмотреть в «Моём пути».',true);
}
function renderPreferences() {
  const prefs = state.preferences || {};
  text(body,'Вы выбираете, какие сообщения видеть. Накопления, прогресс, купленные курсы и AI сохраняются.');
  for (const [key,label] of [['babyPause','Приостановить сообщения о малыше'],['quiet','Тихий режим подсказок']]) {
    const wrapper = el('label','stars-check'), input = el('input'); input.type = 'checkbox'; input.checked = prefs[key] === true; input.dataset.starsFocus = key;
    wrapper.append(input,el('span','',label)); input.addEventListener('change', () => run(input, () => api.preferences({[key]:input.checked}))); body.append(wrapper);
  }
  renderNotificationPreferences(body);
  const link = el('a','stars-button','Изменить срок или отметить рождение малыша'); link.href = 'profile.html'; body.append(link);
  text(body,'Дата рождения и этап меняются в профиле. Они используются для открытия капсулы и прекращения напоминаний о беременности.',true);
}
let pushHelpers;
function loadPushHelpers() {
  if (window.WebprilPush) return Promise.resolve(window.WebprilPush);
  if (!pushHelpers) pushHelpers = new Promise((resolve,reject)=>{const script=el('script');script.src='push-subscription.js?v=20261112-stars';script.onload=()=>resolve(window.WebprilPush);script.onerror=()=>{pushHelpers=null;reject(new Error('Не удалось загрузить настройки уведомлений. Повторите попытку.'));};document.head.append(script);});
  return pushHelpers;
}
function renderNotificationPreferences(parent) {
  if (!notificationPrefs?.preferences) return;
  const prefs=notificationPrefs.preferences, box=card('Уведомления',parent);
  const account=state.accountId;
  const call=async(path,payload)=>{const result=await api.notificationAction(path,payload);if(state?.accountId!==account)throw new Error('Аккаунт изменился.');return result;};
  if (notificationPrefs.pushPublicKey && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window) {
    const enable=button(prefs.pushEnabled?'Отключить уведомления на устройстве':'Включить уведомления на устройстве',()=>run(enable,async()=>{
      const push=await loadPushHelpers();const result=prefs.pushEnabled?await push.disable({api:call}):await push.enable({publicKey:notificationPrefs.pushPublicKey,api:call});
      notificationPrefs=await api.notificationState();renderModal();
      if (!prefs.pushEnabled && result.enabled !== true) throw new Error('Уведомления не включены: разрешение браузера не получено.'); return result;
    },prefs.pushEnabled?'Уведомления отключены.':'Настройки уведомлений сохранены.'));box.append(enable);
    text(box,'Не больше одного уведомления в день, с 09:00 до 21:00 по вашему времени. Разрешение браузера запрашивается после нажатия.',true);
  }
  const labels={new_week:'Новая неделя',capsule:'Открытие капсулы',quest:'Актуальные дела',poll_results:'Итоги голосования',week_almost:'Неделя почти завершена',daily:'Напоминание о твоём дне',feature:'Новые возможности',celebration:'Важные достижения'};
  for (const [key,label] of Object.entries(labels)) {
    const wrapper=el('label','stars-check'),input=el('input');input.type='checkbox';input.checked=prefs.types?.[key]!==false;input.disabled=state.preferences?.quiet===true;input.dataset.starsFocus='notification-'+key;
    input.addEventListener('change',()=>run(input,async()=>{const value=await call('preferences',{types:{[key]:input.checked}});notificationPrefs.preferences=value;return {};},'Настройки сохранены.'));wrapper.append(input,el('span','',label));box.append(wrapper);
  }
  const form=el('form'),label=el('label','','Часовой пояс'),input=el('input');input.name='timezone';input.value=state.preferences?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;input.required=true;input.maxLength=80;input.placeholder='Europe/Moscow';label.append(input);
  const save=button('Сохранить часовой пояс',()=>{});save.type='submit';form.append(label,save);form.addEventListener('submit',event=>{event.preventDefault();try{new Intl.DateTimeFormat('ru',{timeZone:input.value});}catch{notice('Проверьте название часового пояса, например Europe/Moscow.');return;}void run(save,()=>api.preferences({timezone:input.value}), 'Часовой пояс сохранён.');});box.append(form);
}
function renderModal() {
  if (!body || !state) return;
  const active = document.activeElement, key = body.contains(active) ? active.dataset.starsFocus || active.getAttribute('aria-label') || active.name : null;
  const scroll = modal.scrollTop; body.replaceChildren();
  if (tab === 'wallet') renderWallet(); else if (tab === 'today') {renderToday(body);renderRecommendations(body);renderProgress(body);} else if (tab === 'letters') renderLetters(); else if (tab === 'tools') renderTools(); else renderPreferences();
  modal.scrollTop = scroll;
  if (key) { const replacement = [...body.querySelectorAll('button,input,textarea')].find(node => (node.dataset.starsFocus || node.getAttribute('aria-label') || node.name) === key); replacement?.focus({preventScroll:true}); }
}
function renderProgress(parent) {
  const week = file === 'journey.html' ? Number(document.querySelector('#journey')?.dataset.week) || state.currentWeek : state.currentWeek;
  const item = list(state.weekProgress || walletState?.weekProgress || state.weeks).find(item => Number(item.week) === week);
  if (!item) return;
  const box = card(`${week}-я неделя`,parent);
  if (item.locked || item.available === false) {
    box.classList.add('stars-lock'); text(box,'Откроется по вашему сроку. Календарь доступен полностью.');
    if (week === state.currentWeek + 1 && feature('peekNextWeek')) box.append(button('Открыть за звёздочки', () => open('wallet')));
    return;
  }
  const completed = item.completedCount ?? item.completed ?? item.done ?? 0, total = item.total ?? item.target ?? 0;
  if (typeof completed === 'number' && total > 0) {
    text(box,`Изучено ${completed} из ${total} материалов`); const progress = el('progress','stars-progress'); progress.max = total; progress.value = completed; progress.setAttribute('aria-label',`Прогресс ${week}-й недели`);
    const ring = el('div','stars-week-ring',`${completed} / ${total}`); ring.style.setProperty('--completion',`${Math.min(100,completed/total*100)}%`); ring.setAttribute('role','progressbar'); ring.setAttribute('aria-label',`Материалы ${week}-й недели`); ring.setAttribute('aria-valuenow',completed); ring.setAttribute('aria-valuemax',total); ring.setAttribute('aria-valuemin','0'); box.append(ring);
    if (completed < total) text(box,'Прогресс сохраняется даже после дневного предела звёздочек.',true);
    else text(box,item.rewardPending ? 'Бонус и письмо придут после наступления недели.' : 'Неделя завершена ✓');
  }
  box.append(button('Коллекция писем', () => open('letters')));
}
function renderRecommendations(parent) {
  const recommendations = state.today?.recommendations;
  if (!recommendations?.length) return;
  const box = card('Материалы для вас', parent);
  for (const item of recommendations) {
    const id = item.kind === 'video' ? ({'001':'contractions-lesson','002':'back-relief-video','003':'birth-breathing-video'}[item.id] || 'week-video-' + String(item.id).padStart(3,'0')) : item.id;
    const link = el('a', 'stars-material-link', item.title);
    link.href = (item.kind === 'video' ? 'video.html?id=' : 'article.html?id=') + encodeURIComponent(id) + '&from=index&week=' + item.week;
    box.append(link);
  }
}
function renderSurpriseGame(box) {
  const formats = [['choose','surprise_pick3','Выбрать'],['flip','surprise_flip','Перевернуть'],['scratch','surprise_scratch','Стереть']].filter(([,featureName])=>state.features?.[featureName]);
  if (!formats.length) { actionButton(box,'Открыть сюрприз',{type:'surprise'},true); return; }
  let active = formats[0][0];
  const stage = el('div','stars-game-stage');
  if (formats.length > 1) {
    const controls = row(box);
    for (const [format,,title] of formats) controls.append(button(title,()=>{active=format;draw();}));
  }
  box.append(stage);
  function reveal(node, payload) { void run(node,()=>api.action({type:'game_reveal',format:active,...payload})); }
  function draw() {
    stage.replaceChildren();
    if (active === 'choose') {
      const deck = el('div','stars-card-deck');
      for (const choice of [0,1,2]) {
        const node = button(`Карточка ${choice+1}`,()=>{node.classList.add('is-chosen');reveal(node,{choice});}); node.classList.add('stars-choice');
        const mark = el('span','stars-card-mark','✧'); mark.setAttribute('aria-hidden','true'); node.prepend(mark); deck.append(node);
      }
      stage.append(deck);
    } else if (active === 'flip') {
      const node = button('',()=>{
        node.classList.add('is-flipped');
        setTimeout(()=>{if(node.isConnected)reveal(node,{});},matchMedia('(prefers-reduced-motion: reduce)').matches?0:320);
      });
      node.classList.add('stars-flip'); node.setAttribute('aria-label','Перевернуть карточку');
      const front = el('span','stars-flip-front','✧ Перевернуть карточку'), back = el('span','stars-flip-back','Открываем…'); back.setAttribute('aria-hidden','true'); node.append(front,back); stage.append(node);
    } else {
      const wrap = el('div','stars-scratch'), canvas = el('canvas'); canvas.width=480;canvas.height=180; canvas.setAttribute('aria-hidden','true');
      const beneath = el('span','stars-scratch-under','Сюрприз ждёт вас'); wrap.append(beneath,canvas);stage.append(wrap);
      const context = canvas.getContext('2d');context.fillStyle='#cfc0ef';context.fillRect(0,0,480,180);context.fillStyle='#5430aa';context.font='22px sans-serif';context.textAlign='center';context.fillText('Сотрите покрытие',240,98);context.globalCompositeOperation='destination-out';context.lineWidth=42;context.lineCap='round';context.lineJoin='round';
      let pointer=null,last=null,opened=false; const cells=new Set();
      const alternative=button('Открыть без стирания',()=>{if(opened)return;opened=true;reveal(alternative,{});});stage.append(alternative);
      const point=event=>{const r=canvas.getBoundingClientRect();return [(event.clientX-r.left)*480/r.width,(event.clientY-r.top)*180/r.height];};
      canvas.addEventListener('pointerdown',event=>{if(opened||event.button!==0)return;pointer=event.pointerId;canvas.setPointerCapture(pointer);last=point(event);});
      canvas.addEventListener('pointermove',event=>{
        if(opened||event.pointerId!==pointer||!last)return;
        const next=point(event);context.beginPath();context.moveTo(...last);context.lineTo(...next);context.stroke();
        const length=Math.hypot(next[0]-last[0],next[1]-last[1]);
        for(let i=0;i<=length;i+=8){const ratio=length?i/length:0;cells.add(Math.floor((last[0]+(next[0]-last[0])*ratio)/20)+':'+Math.floor((last[1]+(next[1]-last[1])*ratio)/20));}
        last=next;
        if(cells.size>=38){opened=true;canvas.style.opacity='0';reveal(alternative,{});}
      });
      const end=()=>{pointer=null;last=null;};canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
    }
  }
  draw();
}
function renderToday(parent) {
  const today = state.today;
  if (!today) return;
  if (!feature('checkin') && !today.care && !today.reply && !today.surprise && !today.question && !today.questions?.length) return;
  const heading = el('h2','','Твой день'); parent.append(heading);
  if (feature('checkin')) {
    const box = card('Как ты сегодня?',parent), actions = row(box);
    const mood = typeof today.checkin === 'string' ? today.checkin : today.checkin?.mood;
    for (const [value,label] of [['good','Хорошо'],['calm','Спокойно'],['tired','Устала'],['anxious','Тревожно'],['unwell','Неважно']]) {
      const node = actionButton(actions,label,{type:'checkin',mood:value}); node.setAttribute('aria-pressed',String(value === mood));
    }
    if (mood) text(box,'Отметка сохранена. Можно изменить без повторной награды.',true);
  }
  if (today.reply) text(parent,today.reply);
  if (today.care) { const box = card(today.care.title || 'Немного заботы',parent); text(box,typeof today.care === 'string' ? today.care : today.care.text); }
  if (today.surprise && !paused()) {
    const surprise = today.surprise, box = card(surprise.title || 'Сюрприз дня',parent);
    if (today.surpriseOpened || surprise.opened || surprise.revealed || surprise.claimed) text(box,surprise.text || surprise.body);
    else renderSurpriseGame(box);
  }
  const questions = today.questions?.length ? today.questions : today.question ? [today.question] : [];
  for (const q of questions) {
    if (paused()) continue;
    const box = card(['size','guess_size'].includes(q.kind) ? 'Угадай размер' : 'Правда или миф?',parent); text(box,q.prompt);
    if (q.answered) {
      text(box,q.correct === true ? 'Верно!' : q.correct === false ? 'Узнаем больше' : 'Ответ сохранён'); text(box,q.explanation);
      if (q.answer !== undefined && q.options?.[q.answer]) text(box,'Ответ: ' + (q.options[q.answer].text || q.options[q.answer]));
    } else { const actions = row(box); list(q.options).forEach((option,index) => actionButton(actions,typeof option === 'string' ? option : option.text || option.label,{type:'myth_answer',questionId:q.id,answer:index})); }
  }
  if (today.card && !paused()) { const box = card(today.card.title,parent); text(box,today.card.text); }
  for (const game of list(state.games || today.games)) {
    if (game.available === false || paused()) continue;
    const format = game.format || game.id, box = card(game.title || 'Сюрприз',parent);
    if (game.revealed) text(box,game.text);
    else if (format === 'choose') { const actions = row(box); [0,1,2].forEach(choice => actionButton(actions,`Карточка ${choice+1}`,{type:'game_reveal',format,choice})); }
    else { const node = actionButton(box,format === 'scratch' ? 'Стереть покрытие' : 'Перевернуть карточку',{type:'game_reveal',format},true); node.classList.add('stars-game'); }
  }
  if (state.streak && feature('streak')) text(parent,`Ваша серия: ${state.streak.weeks ?? state.streak.count ?? 0} недель. Пропуски не отнимают звёздочки.`,true);
}
function todayVisible() { return isToday && !document.hidden && !page?.hidden && !window.frameElement?.hidden; }
function presentationReady() {
  return todayVisible() && modal?.open && state?.enabled && !state.preferences?.quiet && !mutation && ![...document.querySelectorAll('dialog[open]')].some(dialog=>dialog!==modal) && !state.today?.urgent;
}
function presentationAllowed(entry) {
  if (entry.kind === 'hint') return !paused() && state.features?.[entry.value.feature] === true && (entry.week === undefined || entry.week === state.currentWeek);
  return entry.value.kind === 'welcome' || !paused() && !state.preferences?.postpartum;
}
function schedulePresentation() {
  clearTimeout(presentationTimer);
  const visible=todayVisible() && modal?.open;
  if(visible&&!wasTodayVisible)hintDeferred=false;
  wasTodayVisible=visible;
  if(!visible){presentationDialog?.close();hintNode?.remove();hintNode=null;return;}
  presentationTimer=setTimeout(()=>void showPresentation(),0);
}
async function showPresentation() {
  if(presentationBusy||!presentationReady())return;
  if(hintNode?.isConnected||presentationDialog?.isConnected)return;
  let entry=pendingPresentation;
  if(entry?.accountId!==state.accountId)entry=pendingPresentation=null;
  if(!entry){
    const value=state.presentation?.celebration;
    if(value)entry={kind:'celebration',value,accountId:state.accountId,week:state.currentWeek};
    else if(!hintDeferred&&state.presentation?.hint)entry={kind:'hint',value:state.presentation.hint,accountId:state.accountId,week:state.currentWeek};
  }
  if(!entry||!presentationAllowed(entry))return;
  presentationBusy=true;
  try {
    if(!entry.reserved){
      const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow'}).format(new Date());
      const key=`${entry.accountId}:${entry.kind}:${entry.value.eventId || entry.value.id}:${day}`;
      if(presentationAttempts.has(key))return;presentationAttempts.add(key);
      const claim=await api.presentation({kind:entry.kind,sessionId:presentationSessionId});
      if(!claim.allowed||state?.accountId!==entry.accountId)return;
      entry.reserved=true;pendingPresentation=entry;
    }
    if(!presentationReady()||!presentationAllowed(entry))return;
    if(!entry.acknowledged){
      const result=await api.action(entry.kind==='celebration'?{type:'celebration_seen',eventId:entry.value.eventId}:{type:'feature_hint_seen',feature:entry.value.feature});
      if(state?.accountId!==entry.accountId)return;
      if(result.result?.shown!==true){pendingPresentation=null;return;}
      entry.acknowledged=true;
    }
    if(!presentationReady()||!presentationAllowed(entry))return;
    pendingPresentation=null;
    if(entry.kind==='hint'){
      const aside=el('aside','stars-card stars-hint');aside.setAttribute('role','note');aside.setAttribute('aria-label','Подсказка о новой возможности');
      text(aside,entry.value.text);const close=button('Понятно',()=>{aside.remove();if(hintNode===aside)hintNode=null;});aside.append(close);presentationHost.append(aside);hintNode=aside;
    }else{
      hintDeferred=true;
      const dialog=el('section','stars-card stars-celebration');presentationDialog=dialog;dialog.dataset.celebrationKind=entry.value.kind;dialog.setAttribute('aria-labelledby','stars-celebration-title');
      const heading=el('h2','',entry.value.title);heading.id='stars-celebration-title';dialog.append(heading);text(dialog,entry.value.body);
      dialog.close=()=>{dialog.remove();if(presentationDialog===dialog)presentationDialog=null;schedulePresentation();};
      const close=button('Продолжить',()=>dialog.close(),true);dialog.append(close);presentationHost.append(dialog);
    }
  }catch(error){
    if(error.code==='account_changed'||[401,403].includes(error.status))pendingPresentation=null;
    // An unavailable optional presentation never blocks Today or credits a reward.
  }finally{presentationBusy=false;}
}
function render(value) {
  if (!value?.enabled) { reset(); return; }
  if (state?.accountId && state.accountId !== value.accountId) { walletState = null; quota = null; modal?.close(); }
  state = value;

  if (visitAccount !== state.accountId) { visitAccount = state.accountId; void api.visit().catch(()=>{}); }
  window.webprilGamificationWeeks = state.weeks; document.documentElement.classList.add('stars-enabled');
  document.documentElement.classList.toggle('baby-messages-paused',paused());
  if(trigger){trigger.hidden=false;trigger.querySelector('#points-trigger-balance').textContent=money(state.wallet?.balance);}
  if (modal?.open && enhancedUi && !enhancedUi.hidden) renderModal();
  if (paused() || state.preferences?.quiet) {hintNode?.remove();hintNode=null;if(state.preferences?.quiet || presentationDialog && presentationDialog.dataset.celebrationKind!=='welcome')presentationDialog?.close();}
  document.querySelectorAll('a[href*="baby.html"]').forEach(link => { link.hidden = paused(); });
  schedulePresentation();
}

function reset() {
  clearTimeout(presentationTimer);pendingPresentation=null;presentationDialog?.close();hintNode?.remove();hintNode=null;presentationAttempts.clear();hintDeferred=false;
  mutation = false; state = null; walletState = null; quota = null; historyRows = null; historyCursor = null; notificationPrefs = null; visitAccount = null; packPurchasesRemaining = null; refreshId++; content.replaceChildren(); globalStatus.textContent = ''; root.hidden = true; window.webprilDailyRecommendations = null; window.webprilGamificationWeeks = null; modal?.close(); body?.replaceChildren();if(legacyUi){legacyUi.hidden=false;enhancedUi.hidden=true;modal.classList.remove('stars-dialog');modal.setAttribute('aria-labelledby','points-title');}
  document.documentElement.classList.remove('stars-enabled','baby-messages-paused');
}
api.subscribe(render);
async function refresh() {
  if (document.hidden || window.frameElement?.hidden) return;
  try { await api.loadGamification(); } catch (error) {
    if (error.status === 404 || error.code === 'account_changed' || [401,403].includes(error.status)) return;
    if (state) notice('Не удалось обновить данные. Попробуйте ещё раз.');
  }
}
window.addEventListener('stars:privacy', event => {
  if (state?.accountId !== event.detail?.accountId) return;
  state.preferences.babyPause = event.detail.babyPause; render(state); void refresh();
});
window.addEventListener('stars:changed',refresh);
window.addEventListener('stars:open', event => open(event.detail?.tab || 'wallet'));
window.addEventListener('stars:quota', event => { quota = event.detail; if (modal?.open && tab === 'wallet') renderModal(); });
window.addEventListener('account:change', () => { walletState = null; void refresh(); });
window.addEventListener('webpril:session-ended',reset);
window.addEventListener('pageshow',refresh);
document.addEventListener('visibilitychange',()=>{schedulePresentation();void refresh();});
document.addEventListener('close',schedulePresentation,true);
if (isToday && page) new MutationObserver(schedulePresentation).observe(page,{attributes:true,attributeFilter:['hidden']});
if (window.frameElement) new MutationObserver(()=>{schedulePresentation();void refresh();}).observe(window.frameElement,{attributes:true,attributeFilter:['hidden']});
const journey = document.querySelector('#journey');
if (journey) new MutationObserver(() => { if (state) render(state); }).observe(journey,{attributes:true,attributeFilter:['data-week']});
const css = el('link'); css.rel = 'stylesheet'; css.href = 'gamification.css?v=20261112-layout-window'; document.head.append(css);
void refresh();

function resizeDialog() { document.documentElement.style.setProperty('--stars-viewport-height', Math.max(160,(window.visualViewport?.height || innerHeight)-12)+'px'); }
window.visualViewport?.addEventListener('resize',resizeDialog); window.addEventListener('resize',resizeDialog); resizeDialog();
