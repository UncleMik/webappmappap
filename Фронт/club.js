(() => {
 const tabs=[...document.querySelectorAll('[data-tab]')];
 const query=document.querySelector('#club-query');
 const notice=document.querySelector('.club-notice');
 let active='all', stage='';
 function filter(){
  const text=query.value.trim().toLocaleLowerCase('ru'); let count=0;
  document.querySelectorAll('[data-overview]').forEach(section=>{
   let visible=0;
   section.querySelectorAll('[data-kind]').forEach(row=>{
    row.hidden=!(active==='all'||row.dataset.kind===active)||(stage&&row.dataset.stage&&!row.dataset.stage.split(' ').includes(stage))||!row.textContent.toLocaleLowerCase('ru').includes(text);
    if(!row.hidden) visible++;
   });section.hidden=!visible;count+=visible;
  });
  document.querySelectorAll('[data-category]').forEach(panel=>{
   panel.hidden=panel.dataset.category!==active;
   if(panel.hidden)return;
   panel.querySelectorAll('.club-section').forEach(section=>{let visible=0;section.querySelectorAll('.club-entry').forEach(row=>{row.hidden=!row.textContent.toLocaleLowerCase('ru').includes(text);if(!row.hidden)visible++;});section.hidden=!visible;count+=visible;});
   panel.querySelectorAll('.community-row').forEach(row=>{row.hidden=!row.textContent.toLocaleLowerCase('ru').includes(text);if(!row.hidden)count++;});
  });
  document.querySelector('.club-empty').hidden=count>0;
 }
 function select(name){active=tabs.some(t=>t.dataset.tab===name)?name:'all';tabs.forEach(t=>{const on=t.dataset.tab===active;t.setAttribute('aria-selected',on);t.tabIndex=on?0:-1;});document.querySelector('#community-content').setAttribute('aria-labelledby',active+'-tab');filter();}
 tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>{location.hash=tab.dataset.tab;});tab.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const n=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[n].focus();location.hash=tabs[n].dataset.tab;});});
 document.querySelectorAll('[data-select-tab]').forEach(b=>b.addEventListener('click',()=>{location.hash=b.dataset.selectTab;document.querySelector('.community-tabs').scrollIntoView({block:'start'});}));
 document.querySelectorAll('.stage-picker button').forEach(b=>b.addEventListener('click',()=>{stage=stage===b.dataset.stage?'':b.dataset.stage;document.querySelectorAll('.stage-picker button').forEach(x=>x.setAttribute('aria-pressed',x.dataset.stage===stage));filter();}));
 const search=document.querySelector('#search-toggle');search.addEventListener('click',()=>{const panel=document.querySelector('#club-search');panel.hidden=!panel.hidden;search.setAttribute('aria-expanded',!panel.hidden);if(!panel.hidden)query.focus();else{query.value='';filter();}});
 query.addEventListener('input',filter);
 document.querySelectorAll('[data-notice],[data-preview]').forEach(b=>b.addEventListener('click',()=>{notice.querySelector('p').textContent=b.dataset.notice||b.dataset.preview;notice.hidden=false;}));
 notice.querySelector('button').addEventListener('click',()=>notice.hidden=true);
 document.addEventListener('keydown',e=>{if(e.key==='Escape'){notice.hidden=true;if(search.getAttribute('aria-expanded')==='true'){search.click();search.focus();}}});
 window.addEventListener('hashchange',()=>select(location.hash.slice(1)));select(location.hash.slice(1));
})();
