/* Owner-only editor. Every action is authorized again by the server. */
window.WebprilStarsAdmin = ({root,api}) => {
  const names={urgent_help:'Срочная помощь',paragraphs:'Пункты исходного документа',paragraph:'Номер пункта',enabled:'Включить звёздочки',features:'Возможности',rewards:'Награды',limits:'Дневные пределы',prices:'Цены',ai:'Вопросы Ларе',stars:'Звёздочки',daily:'Твой день',weekLocks:'Ограничения будущих недель',peekNextWeek:'Открытие следующей недели',aiPacks:'Покупка вопросов',myths:'Правда или миф',quests:'Актуальные дела',capsule:'Капсула времени',games:'Игры',notifications:'Для вас',push:'Push-уведомления',welcome:'Приветствие',checkin:'Самочувствие',surprise:'Сюрприз',mythAnswer:'Ответ на вопрос',mythCorrect:'Правильный ответ',article:'Статья',video:'Бесплатное видео',courseLesson:'Урок курса',weekComplete:'Завершение недели',poll:'Голосование',pollMajority:'Ответ большинства',clubMessage:'Сообщение в клубе',kicks:'Шевеления',quest:'Выполнение дела',firstKick:'Первое шевеление',trimester:'Триместр',freeDaily:'Дневной предел без курса',courseDaily:'Дневной предел с курсом',aiPackFree:'Пакет без курса',aiPackCourse:'Пакет с курсом',freePack:'Вопросов в пакете без курса',coursePack:'Вопросов в пакете с курсом',freePurchases:'Покупок в день без курса',coursePurchases:'Покупок в день с курсом',freePaidDaily:'Расход купленных за день без курса',coursePaidDaily:'Расход купленных за день с курсом',letters:'Письма',questions:'Вопросы',care:'Забота',ideas:'Идеи',practices:'Практики',replies:'Ответы на самочувствие',weekly:'Недели',checklists:'Чек-листы',bag:'Сумка',doctor:'Вопросы врачу',text:'Текст',title:'Название',prompt:'Вопрос',answer:'Правильный ответ (номер с нуля)',explanation:'Объяснение',options:'Варианты ответа',articleId:'Связанная статья',minWeek:'С недели',maxWeek:'До недели',trimester:'Триместр',baby:'Малыш',mom:'Мама',measurements:'Рост и вес',development:'Развитие',description:'Описание',mood:'Самочувствие',conditional:'По условию',url:'Ссылка',link:'Ссылка',image:'Изображение (ссылка)',imageUrl:'Изображение (ссылка)',cover:'Обложка (ссылка)',picture:'Изображение (ссылка)'};
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const field=(parent,text,input)=>{const l=el('label',text);l.append(input);parent.append(l);return input;};
  const input=(value,type='text')=>{const n=el('input');n.type=type;if(type==='checkbox')n.checked=value;else n.value=value??'';return n;};
  const area=value=>{const n=el('textarea');n.rows=4;n.value=value??'';return n;};
  const btn=(parent,text,run)=>{const b=el('button',text);b.type='button';b.addEventListener('click',async()=>{b.disabled=true;try{await run();}catch(e){status.textContent=e.message;}finally{b.disabled=false;}});parent.append(b);return b;};
  let status,selectedContentId=null;
  async function refresh(){render(await api('gamification'));}
  function render(data){
    root.replaceChildren(el('h2','Звёздочки и «Твой день»'));
    status=el('p');status.className='status';status.setAttribute('role','status');root.append(status);
    root.append(el('p','Включение возможностей не утверждает медицинские тексты или бюджет Лары. Каждое утверждение требует отдельного основания.'));
    const settings=el('form');settings.className='surface';const patch={};
    for(const [group,value] of Object.entries(data.settings)){
      if(['medicalApproved','aiBudgetApproved'].includes(group))continue;
      if(group==='audience'){
        const box=el('fieldset');box.append(el('legend','Участники этапа запуска'));
        const mode=el('select');for(const [id,title] of [['selected','Только выбранные аккаунты'],['all','Все аккаунты']]){const o=el('option',title);o.value=id;mode.append(o);}mode.value=value.mode;field(box,'Кому доступны новые возможности',mode);
        const search=field(box,'Найти ученицу по имени или email',input('','search'));
        const list=el('div');list.className='stars-account-list';box.append(list);
        const selected=new Set(value.userIds),rows=[];
        for(const account of data.accounts||[]){const title=[account.name,account.email].filter(Boolean).join(' · '),check=input(selected.has(account.id),'checkbox');const row=el('label',title);row.prepend(check);list.append(row);rows.push({row,text:title.toLocaleLowerCase('ru')});check.addEventListener('change',()=>{if(check.checked)selected.add(account.id);else selected.delete(account.id);});}
        const filter=()=>{const query=search.value.trim().toLocaleLowerCase('ru');for(const item of rows)item.row.hidden=Boolean(query&&!item.text.includes(query));};search.addEventListener('input',filter);
        const selection=el('p');const describe=()=>{selection.textContent='Выбрано: '+selected.size+' из 1000';list.hidden=mode.value==='all';search.disabled=mode.value==='all';};list.addEventListener('change',describe);mode.addEventListener('change',describe);describe();box.append(selection);
        if(!(data.accounts||[]).length)box.append(el('p','Зарегистрированных аккаунтов пока нет.'));
        patch[group]=()=>({mode:mode.value,userIds:[...selected]});settings.append(box);continue;
      }
      if(typeof value==='boolean'){const n=field(settings,names[group]||group,input(value,'checkbox'));patch[group]=()=>n.checked;continue;}
      const box=el('fieldset');box.append(el('legend',names[group]||group));settings.append(box);patch[group]={};
      for(const [key,v] of Object.entries(value)){const n=field(box,names[key]||key,input(v,typeof v==='boolean'?'checkbox':'number'));if(typeof v==='number'){n.min=0;n.max=group==='ai'?({freeDaily:30,courseDaily:30,freePack:30,coursePack:30,freePurchases:2,coursePurchases:1,freePaidDaily:10,coursePaidDaily:10}[key]):32767;n.required=true;}patch[group][key]=()=>typeof v==='boolean'?n.checked:Number(n.value);}
    }
    const reason=field(settings,'Основание изменения',area(''));reason.required=true;reason.maxLength=1000;
    const save=el('button','Сохранить параметры');save.type='submit';settings.append(save);root.append(settings);
    settings.addEventListener('submit',async e=>{e.preventDefault();save.disabled=true;try{const values=Object.fromEntries(Object.entries(patch).map(([k,v])=>[k,typeof v==='function'?v():Object.fromEntries(Object.entries(v).map(([a,b])=>[a,b()]))]));await api('gamification/settings',{patch:values,reason:reason.value});await refresh();status.textContent='Параметры сохранены.';}catch(e){status.textContent=e.message;}finally{save.disabled=false;}});
    const gates=el('div');gates.className='surface';gates.append(el('h3','Отдельные утверждения'));
    for(const [gate,key,title] of [['medical','medicalApproved','Медицинские материалы'],['aiBudget','aiBudgetApproved','Бюджет вопросов Ларе']]){
      const box=el('fieldset');box.append(el('legend',title+': '+(data.settings[key]?'утверждено':'не утверждено')));const evidence=field(box,'Кем и когда проверено, ссылка или документ',area(''));evidence.maxLength=2000;
      btn(box,'Подтвердить',async()=>{await api('gamification/approve-gate',{gate,approved:true,evidence:evidence.value});await refresh();});btn(box,'Отозвать утверждение',async()=>{await api('gamification/approve-gate',{gate,approved:false,evidence:evidence.value});await refresh();});gates.append(box);
    }root.append(gates);
    const content=el('div');content.className='surface';content.append(el('h3','Исходные материалы · '+data.content.length));
    const select=el('select');for(const row of data.content){const option=el('option',(names[row.kind]||row.kind)+' · '+row.id+' · '+(row.status==='approved'?'утверждено':'черновик'));option.value=row.id;select.append(option);}if(data.content.some(row=>row.id===selectedContentId))select.value=selectedContentId;field(content,'Материал',select);const editor=el('div');content.append(editor);root.append(content);
    function edit(){selectedContentId=select.value;editor.replaceChildren();const row=data.content.find(x=>x.id===select.value);if(!row)return;const body=structuredClone(row.body),reads=[],answerFields=new Map();
      editor.append(el('p','Редакция '+row.revision+'. '+(row.medical?'Медицинский текст. ':'')+'Сохранение правки снимает прежнее утверждение.'));
      const readonly=new Set(['id','week','slot','kind','paragraph','style','source','source_id','sourceId','source_paragraph','source_hash','review_status','status','medical','medicalApproved']);
      const sourceLabels={id:'Идентификатор материала',week:'Неделя',slot:'Номер вопроса недели',kind:'Формат',paragraph:'Пункт исходного документа',style:'Стиль источника',source:'Источник',source_id:'Источник',sourceId:'Источник',source_paragraph:'Пункт источника',source_hash:'Контрольная сумма источника'};
      const titleFor=(key,parent)=>/^\d+$/.test(key)?(Array.isArray(parent)?'Пункт '+(Number(key)+1):'Раздел '+key):(names[key]||sourceLabels[key]||'Дополнительное поле');
      function walk(value,parent,path=[]){for(const [key,v] of Object.entries(value)){
        if(readonly.has(key)){if(['status','medical','medicalApproved','review_status'].includes(key))continue;const n=field(parent,sourceLabels[key]||'Исходное поле',input(v));n.readOnly=true;continue;}
        if(key==='answer'&&Array.isArray(value.options)){
          const n=el('select');value.options.forEach((text,i)=>{const o=el('option','Вариант '+(i+1)+': '+text);o.value=String(i);n.append(o);});n.value=String(v);field(parent,'Правильный ответ',n);answerFields.set(value.options,n);
          reads.push(()=>{let target=body;for(const p of path)target=target[p];target[key]=Number(n.value);});continue;
        }
        if(v!==null&&typeof v==='object'){const box=el('fieldset');box.append(el('legend',titleFor(key,value)));parent.append(box);walk(v,box,[...path,key]);continue;}
        const urlField=typeof v==='string'&&/url|link|image|picture|cover/i.test(key);
        const n=field(parent,(Array.isArray(value)&&path.at(-1)==='options'?'Вариант '+(Number(key)+1):titleFor(key,value)),typeof v==='string'&&!urlField?area(v):input(v,urlField?'url':typeof v==='boolean'?'checkbox':'number'));
        if(Array.isArray(value)&&path.at(-1)==='options')n.addEventListener('input',()=>{const answer=answerFields.get(value);if(answer?.options[Number(key)])answer.options[Number(key)].textContent='Вариант '+(Number(key)+1)+': '+n.value;});
        if(typeof v==='number'){n.step='1';if(['minWeek','maxWeek'].includes(key)){n.min=1;n.max=42;}}
        reads.push(()=>{let target=body;for(const p of path)target=target[p];target[key]=typeof v==='boolean'?n.checked:typeof v==='number'?Number(n.value):n.value;});}}
      walk(body,editor);btn(editor,'Сохранить черновик',async()=>{reads.forEach(run=>run());await api('gamification/content',{id:row.id,kind:row.kind,body,medical:row.medical,revision:row.revision});await refresh();});
      const evidence=field(editor,'Основание утверждения этой редакции',area(''));evidence.maxLength=2000;
      const approve=btn(editor,'Утвердить редакцию',async()=>{await api('gamification/approve-content',{id:row.id,revision:row.revision,evidence:evidence.value});await refresh();});approve.disabled=row.revision===0;
    }select.addEventListener('change',edit);edit();
    const legacy=el('div');legacy.className='surface';legacy.append(el('h3','Сверка прежнего доступа'));
    legacy.append(el('p','После сверки сохраняются явно перечисленные недели и покупки. Не завершайте сверку, пока история открытий не проверена. В списке первые 200 ожидающих аккаунтов.'));
    const pending=el('select'),accounts=new Map((data.accounts||[]).map(row=>[row.id,row]));
    for(const row of data.legacyReviews||[]){const account=accounts.get(row.user_id);const o=el('option',account?[account.name,account.email].filter(Boolean).join(' · '):'Аккаунт ожидает сверки ('+new Date(row.created_at).toLocaleDateString('ru-RU')+')');o.value=row.user_id;pending.append(o);}field(legacy,'Ученица, ожидающая сверки',pending);
    const weeksBox=el('fieldset');weeksBox.append(el('legend','Недели с подтверждённым прежним доступом'));const choices=[];
    for(let week=1;week<=42;week++){const check=input(false,'checkbox');field(weeksBox,'Неделя '+week,check);choices.push({week,check});}legacy.append(weeksBox);
    const chooseAccount=()=>{const preserved=(data.legacyReviews||[]).find(row=>row.user_id===pending.value)?.preserved_weeks||[];for(const {week,check} of choices){check.checked=preserved.includes(week);check.disabled=preserved.includes(week);}};pending.addEventListener('change',chooseAccount);chooseAccount();
    const evidence=field(legacy,'Основание и источник проверки',area(''));
    const resolve=btn(legacy,'Завершить сверку аккаунта',async()=>{await api('gamification/resolve-legacy',{userId:pending.value,preservedWeeks:choices.filter(row=>row.check.checked).map(row=>row.week),evidence:evidence.value});await refresh();});resolve.disabled=!pending.value;
    if(!pending.value)legacy.append(el('p','Нет аккаунтов, ожидающих сверки.'));root.append(legacy);
    const metrics=el('div');metrics.className='surface';metrics.append(el('h3','Показатели и журнал'));const report=el('div');
    btn(metrics,'Обновить показатели',async()=>{const m=await api('gamification/metrics');report.replaceChildren(el('p','По записанной истории на '+m.asOf),el('p',`Активных аккаунтов: ${m.activeAccounts}; дней с визитом: ${m.activeDays}; завершено материалов: ${m.completedMaterials}; недель: ${m.completedWeeks}.`),el('p',`Потрачено звёздочек: ${m.spends.stars}; операций: ${m.spends.operations}. Единиц AI после возвратов: ${m.aiUnits.free} бесплатных и ${m.aiUnits.paid} купленных. Отключений push: ${m.pushOptout.events}.`));for(const [key,r] of Object.entries(m.retention))report.append(el('p',key+': '+(r.insufficientData?'недостаточно данных':`${r.returned} из ${r.eligible} (${Math.round(r.rate*100)}%).`)));report.append(el('p','Фактическая стоимость провайдера и покупки курсов: источник пока не подключён.'));for(const day of m.dailyVisits)report.append(el('p',`${day.day}: ${day.accounts} аккаунтов`));});
    btn(metrics,'Открыть журнал изменений',async()=>{const rows=await api('gamification/history');report.replaceChildren();for(const row of rows){const details=el('details');details.append(el('summary',`${row.created_at} · ${row.action} · ${row.target}`),el('p',row.reason),el('p','Автор: '+row.actor_id),el('pre',JSON.stringify({before:row.before_value,after:row.after_value},null,2)));report.append(details);}});metrics.append(report);root.append(metrics);
  }
  return {render};
};
