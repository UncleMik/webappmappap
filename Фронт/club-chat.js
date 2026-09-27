(() => {
 const notice=document.querySelector('.club-notice');
 const show=text=>{notice.querySelector('p').textContent=text;notice.hidden=false;};
 document.querySelectorAll('[data-notice]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.notice)));
 notice.querySelector('button').addEventListener('click',()=>notice.hidden=true);
 document.addEventListener('keydown',e=>{if(e.key==='Escape')notice.hidden=true;});
 document.querySelectorAll('.reaction').forEach(b=>b.addEventListener('click',()=>b.setAttribute('aria-pressed',b.getAttribute('aria-pressed')!=='true')));
 document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();show('Это пример чата. Отправка сообщений будет доступна после подключения сообщества.');});
})();
if (new URLSearchParams(location.search).get('room') === 'moms') {
 document.querySelector('.discussion-header h1').textContent = 'Мамы на одном этапе';
 document.title = 'Мамы на одном этапе — Клуб';
}
