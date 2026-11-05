async page => {
  const base='https://app.legkie-rody.ru';
  let accountId='11111111-1111-4111-8111-111111111111', plan='free', historyRemaining=5, used=0, reject=false, post=0, errorQuota;
  const quota=(remaining)=>plan==='unknown'?undefined:{limit:plan==='paid'?30:5,remaining};
  const assert=(value,message)=>{if(!value)throw Error(message)};
  await page.addInitScript(() => {
    window.voiceQuotaMock = { stopped: 0 };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() { voiceQuotaMock.stopped++; } }] }) } });
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
      constructor(stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['synthetic'], { type: this.mimeType }) }); this.onstop?.(); }); }
    };
  });
  let voicePosts = 0, voiceRemaining = 0;
  await page.route(base+'/**',route=>{const path=new URL(route.request().url()).pathname;return ['/app-navigation.js','/resource-prefetch.js'].includes(path)?route.fulfill({body:'',contentType:'text/javascript'}):route.fulfill({path:'Фронт'+path});});
  await page.route(base+'/api/auth/session',route=>route.fulfill({json:{authenticated:true,user:{id:accountId,email:'quota-qa@example.invalid',profile:{completedAt:'2026-11-01',stage:'pregnancy',dueDate:'2027-02-01',name:'Тест'}}}}));
  await page.route(base+'/api/auth/ai/history',route=>route.fulfill({json:{accountId,messages:[],quota:quota(historyRemaining),hasMore:false}}));
  await page.route(base+'/api/auth/ai/messages',route=>{
    post++;const body=route.request().postDataJSON();
    if(reject)return route.fulfill({status:429,json:{error:'ai_daily_limit',quota:errorQuota}});
    used++;const limit=plan==='paid'?30:5;
    return route.fulfill({json:{accountId,requestId:body.requestId,status:'completed',quota:quota(limit-used),messages:[{id:'user'+post,requestId:body.requestId,role:'user',status:'completed',content:body.text},{id:'answer'+post,requestId:body.requestId,role:'assistant',content:'Ответ '+post,sources:[]}]}});
  });
  await page.route(base+'/api/auth/ai/voice', route => { voicePosts++; return route.fulfill({ status: 429, json: { error: 'ai_daily_limit', quota: { limit: 5, remaining: voiceRemaining } } }); });
  const navigate=async()=>{await page.goto(base+'/ai.html');await page.waitForFunction(()=>!document.querySelector('#chat-input').disabled)};
  const send=async text=>{await page.locator('#chat-input').fill(text);await page.locator('.send-button').click()};
  await navigate();
  assert(await page.locator('#chat-quota').innerText()==='Осталось вопросов сегодня: 5 из 5','Free user did not receive 5 questions');
  for(const width of [320,390]){
    await page.setViewportSize({width,height:500});await page.waitForTimeout(100);
    assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.querySelector('#chat-form').getBoundingClientRect().bottom>document.querySelector('.bottom-navigation').getBoundingClientRect().top),'Free quota layout overflow at'+width);
  }
  for(let question=1;question<=5;question++){
    await send('Бесплатный вопрос '+question);await page.getByText('Ответ '+question,{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('#chat-retry').hidden);
    assert(await page.locator('#chat-quota').innerText()===`Осталось вопросов сегодня: ${5-question} из 5`,'Free counter incorrect after accepted question '+question);
    if(question<5)await page.waitForFunction(()=>!document.querySelector('#chat-input').disabled);
  }
  for(const selector of ['#chat-input','.send-button','#attachment','#analysis-attachment'])assert(await page.locator(selector).isDisabled(),'Zero quota left action enabled '+selector);
  assert(used===5&&post===5,'Fifth accepted question did not use exactly one request');
  // A stale tab can submit after another tab has consumed the fifth question.
  historyRemaining=1;reject=true;await navigate();await send('Вопрос из устаревшей вкладки');
  await page.getByText('На сегодня использованы все 5 вопросов. Новые вопросы будут доступны завтра.',{exact:true}).waitFor();
  assert(await page.locator('#chat-quota').innerText()==='Осталось вопросов сегодня: 0 из 5','429 free counter uses wrong limit');
  assert(!(await page.locator('#chat-status').innerText()).includes('30'),'429 free notice hardcodes paid limit');
  await page.evaluate(()=>{window.webprilSessionGate.end=()=>{};window.dispatchEvent(new CustomEvent('account:change',{detail:{user:{id:'22222222-2222-4222-8222-222222222222'}}}))});
  assert(await page.locator('#chat-quota').innerText()===''&&await page.locator('#history-list').innerText()===''&&await page.locator('#conversation .message').count()===0,'Account change leaked prior quota/history');
  assert(await page.locator('#chat-input').isDisabled(),'Account change did not close composer');
  accountId='22222222-2222-4222-8222-222222222222';plan='paid';used=0;reject=false;historyRemaining=30;await navigate();
  assert(await page.locator('#chat-quota').innerText()==='Осталось вопросов сегодня: 30 из 30','Paid counter changed');
  await send('Платный вопрос');await page.getByText('Ответ 7',{exact:true}).waitFor();
  assert(await page.locator('#chat-quota').innerText()==='Осталось вопросов сегодня: 29 из 30','Paid decrement changed');
  reject=true;await page.waitForFunction(()=>!document.querySelector('#chat-input').disabled);await send('Платный вопрос после лимита');
  await page.getByText('На сегодня использованы все 30 вопросов. Новые вопросы будут доступны завтра.',{exact:true}).waitFor();
  errorQuota={limit:5,remaining:0};await navigate();await send('Вопрос после окончания покупки');
  await page.getByText('На сегодня использованы все 5 вопросов. Новые вопросы будут доступны завтра.',{exact:true}).waitFor();
  assert(await page.locator('#chat-quota').innerText()==='Осталось вопросов сегодня: 0 из 5','Server429 downgrade did not replace stale paid limit');
  plan='free';historyRemaining=1;errorQuota={limit:5,remaining:5};await navigate();
  const beforeFreshDay=post;await send('Вопрос после смены дня');
  await page.getByText('Лимит обновился. Попробуйте отправить вопрос ещё раз.',{exact:true}).waitFor();
  assert(await page.locator('#chat-quota').innerText()==='Осталось вопросов сегодня: 5 из 5' && !(await page.locator('#chat-input').isDisabled()),'Fresh positive quota was forced to zero');
  assert(await page.locator('#chat-input').inputValue()==='Вопрос после смены дня' && post===beforeFreshDay+1,'Fresh-day error lost draft or automatically resent');
  reject=false;used=0;await page.locator('.send-button').click();await page.waitForFunction(()=>document.querySelector('#chat-quota').textContent==='Осталось вопросов сегодня: 4 из 5');
  plan='paid';historyRemaining=30;await navigate();
  await page.getByRole('button',{name:'Записать голосом',exact:true}).click();await page.getByRole('button',{name:'Остановить запись',exact:true}).click();
  await page.getByText('На сегодня использованы все 5 вопросов. Новые вопросы будут доступны завтра.',{exact:true}).waitFor();
  assert(await page.locator('#chat-quota').innerText()==='Осталось вопросов сегодня: 0 из 5' && await page.locator('.send-button').isDisabled() && await page.locator('#chat-input').isDisabled(),'Voice stale paid limit did not update to free zero');
  assert(await page.locator('#voice-controls').isHidden() && await page.evaluate(()=>voiceQuotaMock.stopped)>0 && voicePosts===1,'Voice daily-limit failure retained recording or retried automatically');
  voiceRemaining=5;await navigate();await page.getByRole('button',{name:'Записать голосом',exact:true}).click();await page.getByRole('button',{name:'Остановить запись',exact:true}).click();
  await page.getByText('Лимит обновился. Попробуйте отправить вопрос ещё раз.',{exact:true}).waitFor();
  assert(await page.getByRole('button',{name:'Записать голосом',exact:true}).isEnabled() && await page.locator('#voice-controls').isHidden() && voicePosts===2,'Fresh voice quota prevented rerecord or retried automatically');
  errorQuota=undefined;reject=true;plan='unknown';await navigate();await send('Вопрос без данных о лимите');
  await page.getByText('На сегодня вопросы закончились. Новые вопросы будут доступны завтра.',{exact:true}).waitFor();
  assert(await page.locator('#chat-quota').innerText()==='На сегодня вопросы закончились.','Unknown quota invented a numeric limit');
  return {freeFiveToZero:true,fifthAcceptedThen429UsesFive:true,paidThirtyPreserved:true,server429DowngradeThirtyToFive:true,freshDayPositiveQuotaPreserved:true,voiceStaleLimitAndRerecord:true,unknownLimitGeneric:true,accountChangeWipesQuotaHistory:true,zeroDisablesTextFileVoice:true,widths:[320,390],height:500,syntheticApiOnly:true};
}
