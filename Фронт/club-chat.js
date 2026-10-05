(() => {
 const notice=document.querySelector('.club-notice');
 const show=text=>{notice.querySelector('p').textContent=text;notice.hidden=false;};
 document.querySelectorAll('[data-notice]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.notice)));
 notice.querySelector('button').addEventListener('click',()=>notice.hidden=true);
 document.addEventListener('keydown',e=>{if(e.key==='Escape')notice.hidden=true;});
 document.querySelectorAll('.reaction').forEach(b=>b.addEventListener('click',()=>b.setAttribute('aria-pressed',b.getAttribute('aria-pressed')!=='true')));
 document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();show('Это пример чата. Отправка сообщений будет доступна после подключения сообщества.');});
})();
(() => {
 const rooms = {
  'trimester-1': ['Беременность · 1 триместр', 'pregnancy'],
  'trimester-2': ['Беременность · 2 триместр', 'pregnancy'],
  'trimester-3': ['Беременность · 3 триместр', 'pregnancy'],
  'baby-0-6': ['Я мама · 0–6 месяцев', 'motherhood'],
  'baby-6-plus': ['Я мама · от 6 месяцев', 'motherhood'],
  'pregnancy-students': ['Беременность · Ученицы курса', 'pregnancy', true],
  'pregnancy-experts': ['Беременность · Чат с экспертами', 'pregnancy', true],
  'motherhood-students': ['Я мама · Ученицы курса', 'motherhood', true],
  'motherhood-experts': ['Я мама · Чат с экспертами', 'motherhood', true],
  moms: ['Мамы на одном этапе', 'motherhood']
 };
 const key = new URLSearchParams(location.search).get('room');
 const [title, section, locked] = rooms[key] || rooms['trimester-3'];
 document.querySelector('.discussion-header h1').textContent = title;
 document.querySelector('.discussion-header p').textContent = locked ? 'Закрытый чат · демонстрация' : 'Демонстрационная беседа';
 document.querySelector('.discussion-header a').href = 'club.html#' + section;
 document.title = title + ' — Клуб';
 if (locked) document.querySelector('.chat-demo').textContent = 'Пример закрытого чата · доступ и сообщения пока не подключены';
})();
