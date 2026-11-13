async page => {
 const base='https://app.legkie-rody.ru', accountId='11111111-1111-4111-8111-111111111111';
 const assert=(value,message)=>{if(!value)throw Error(message)};
 const old=(limit,remaining)=>({limit,remaining,used:limit-remaining,serverTime:'2026-11-05T20:59:00.000Z',resetsAt:'2026-11-05T21:00:00.000Z'});
 const fresh=(limit)=>({limit,remaining:limit,used:0,serverTime:'2026-11-05T21:00:00.000Z',resetsAt:'2026-11-06T21:00:00.000Z'});
 let historyQuota=old(5,1), freshQuota=fresh(5), quotaCalls=0, chatCalls=0, quotaMode='normal', chatMode='limit', releaseQuota, releaseChat, chatBody;
 await page.addInitScript(()=>{
  window.quotaVoiceMock={stopped:0};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[{stop(){quotaVoiceMock.stopped++}}]})}});
  window.MediaRecorder=class{static isTypeSupported(type){return type==='audio/webm;codecs=opus'} constructor(stream,options){this.mimeType=options.mimeType;this.state='inactive'}start(){this.state='recording'}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['synthetic'],{type:this.mimeType})});this.onstop?.()})}};
 });
 await page.route(base+'/**',route=>{const path=new URL(route.request().url()).pathname;return ['/app-navigation.js','/resource-prefetch.js'].includes(path)?route.fulfill({body:'',contentType:'text/javascript'}):route.fulfill({path:'Фронт'+path});});
 await page.route(base+'/api/auth/session',route=>route.fulfill({json:{authenticated:true,user:{id:accountId,email:'reset-qa@example.invalid',profile:{completedAt:'2026-11-01',stage:'pregnancy',dueDate:'2027-02-01',name:'Тест'}}}}));
 await page.route(base+'/api/auth/ai/history',route=>route.fulfill({json:{accountId,messages:[{id:'saved',role:'assistant',content:'Сохранённая переписка',sources:[]}],quota:historyQuota,hasMore:false}}));
 await page.route(base+'/api/auth/ai/quota',async route=>{
  quotaCalls++;assert(route.request().method()==='GET'&&!route.request().postData(),'Refresh sent a question/body');
  if(quotaMode==='fail-once'){quotaMode='normal';return route.fulfill({status:503,json:{error:'ai_unavailable'}})}
  const respond=()=>route.fulfill({json:{accountId,quota:freshQuota}}).catch(()=>{});
  if(quotaMode==='hold')return new Promise(resolve=>{releaseQuota=async()=>{await respond();resolve()}});
  return respond();
 });
 await page.route(base+'/api/auth/ai/messages',async route=>{
  chatCalls++;chatBody=route.request().postDataJSON();
  if(chatMode==='invalid')return route.fulfill({status:400,json:{error:'invalid_ai_message'}});
  if(chatMode==='hold-limit')return new Promise(resolve=>{releaseChat=async()=>{await route.fulfill({status:429,json:{error:'ai_daily_limit',quota:old(5,0)}});resolve()}});
  if(chatMode==='hold')return new Promise(resolve=>{releaseChat=async()=>{await route.fulfill({json:{accountId,status:'completed',requestId:chatBody.requestId,quota:old(5,0),messages:[{id:'late-q',role:'user',status:'completed',requestId:chatBody.requestId,content:chatBody.text},{id:'late-a',role:'assistant',requestId:chatBody.requestId,content:'Поздний ответ',sources:[]}]}});resolve()}});
  return route.fulfill({status:429,json:{error:'ai_daily_limit',quota:old(5,0)}});
 });
 await page.clock.install({time:new Date('2044-03-10T03:00:00.000Z')});
 const navigate=async()=>{quotaCalls=0;chatCalls=0;releaseQuota=null;releaseChat=null;await page.goto(base+'/ai.html');await page.getByText('Сохранённая переписка',{exact:true}).waitFor()};
 const count=async value=>{await page.getByText(`На сегодня доступно ${value.remaining}/${value.limit}`,{exact:true}).waitFor()};
 const settle=async()=>page.waitForTimeout(100);
 // Device date is unrelated to the authoritative Moscow deadline.
 await navigate();await count(old(5,1));
 await page.locator('#chat-input').fill('Черновик с анализом');await page.locator('#analysis-file').setInputFiles({name:'analysis.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-synthetic')});
 await page.locator('.send-button').click();await page.getByText('На сегодня использованы все 5 вопросов. Новые вопросы будут доступны завтра.',{exact:true}).waitFor();
 assert(await page.locator('#chat-input').isDisabled(),'Exhausted free composer enabled');
 await page.clock.setSystemTime(new Date('1991-07-01T00:00:00.000Z'));await page.clock.fastForward(60001);await count(freshQuota);
 assert(quotaCalls===1&&chatCalls===1,'Midnight caused duplicate refresh/question');
 assert(await page.locator('#chat-input').inputValue()==='Черновик с анализом'&&await page.locator('#attachment-name').innerText()==='analysis.pdf','Reset lost draft or selected file');
 assert(!(await page.locator('#chat-input').isDisabled())&&!(await page.locator('.send-button').isDisabled()),'Fresh free quota did not unlock actions');
 assert(await page.locator('#chat-status').isHidden()&&await page.getByText('Сохранённая переписка',{exact:true}).count()===1,'Reset left cap notice or lost history');
 // The next boundary is armed using the new server snapshot too.
 freshQuota={limit:5,remaining:5,used:0,serverTime:'2026-11-06T21:00:00.000Z',resetsAt:'2026-11-07T21:00:00.000Z'};
 await page.clock.fastForward(86400001);await settle();assert(quotaCalls===2,'Next-day refresh was not rearmed');
 // Paid users refresh to 30, with no optimistic client reset.
 historyQuota=old(30,0);freshQuota=fresh(30);await navigate();assert(await page.locator('.send-button').isDisabled(),'Paid exhausted control enabled');
 await page.clock.fastForward(60001);await count(freshQuota);assert(quotaCalls===1&&!(await page.locator('.send-button').isDisabled()),'Paid midnight did not unlock 30');
 // A preserved hidden initial panel makes no requests until restored; concurrent wakes deduplicate.
 historyQuota=old(5,0);freshQuota=fresh(5);quotaMode='hold';await navigate();
 await page.locator('.app').evaluate(element=>{element.hidden=true});await page.clock.fastForward(60001);await settle();assert(quotaCalls===0,'Hidden panel polled quota');
 await page.locator('.app').evaluate(element=>{element.hidden=false});await settle();
 await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('pageshow'));document.dispatchEvent(new Event('visibilitychange'))});await settle();
 assert(quotaCalls===1&&releaseQuota,'Concurrent visible wake duplicated refresh');await releaseQuota();await count(freshQuota);
 // A sleeping tab resumes based on monotonic deadline, independent of date/timezone changes.
 quotaMode='normal';await navigate();await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))});
 await page.clock.fastForward(120001);await settle();assert(quotaCalls===0,'Background document polled quota');
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))});await count(freshQuota);assert(quotaCalls===1,'Sleeping resume did not deduplicate refresh');
 // OS sleep may advance wall time while performance.now stays frozen.
 for(const limit of [5,30]){
  historyQuota=old(limit,limit===5?1:0);freshQuota=fresh(limit);quotaMode='hold';await navigate();
  if(limit===5){await page.locator('#chat-input').fill('Черновик после сна');await page.locator('.send-button').click();await page.getByText('На сегодня использованы все 5 вопросов. Новые вопросы будут доступны завтра.',{exact:true}).waitFor();}
  if(limit===5)await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))});
  const clocks=await page.evaluate(()=>({wall:Date.now(),monotonic:performance.now()}));await page.clock.setSystemTime(new Date(clocks.wall+120000));
  assert(await page.evaluate(before=>performance.now()-before,clocks.monotonic)<1000,'Sleep fixture advanced performance clock');
  await settle();assert(quotaCalls===0&&await page.locator('#chat-quota').textContent()===`На сегодня доступно 0/${limit}`,'Wall-clock change granted quota locally');
  await page.evaluate(()=>{if(document.hidden){Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))}window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('pageshow'))});await settle();
  assert(quotaCalls===1&&releaseQuota,'Frozen monotonic wake did not deduplicate server refresh');
  assert(await page.locator('#chat-quota').innerText()===`На сегодня доступно 0/${limit}`,'Wake optimistically reset quota before server response');
  await releaseQuota();await count(freshQuota);
  if(limit===5)assert(await page.locator('#chat-input').inputValue()==='Черновик после сна','Frozen-clock wake lost draft');
 }
 historyQuota=old(5,0);freshQuota=fresh(5);
 // Temporary failure keeps zero; retry is delayed by 30 seconds.
 quotaMode='fail-once';await navigate();await page.clock.fastForward(60001);await settle();assert(quotaCalls===1&&await page.locator('#chat-input').isDisabled(),'Failure invented a fresh quota');
 const failedWall=await page.evaluate(()=>Date.now());await page.clock.setSystemTime(new Date(failedWall+120000));
 await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('pageshow'))});await settle();assert(quotaCalls===1,'Clock-drift wake bypassed failure retry bound');
 await page.clock.fastForward(29000);await settle();assert(quotaCalls===1,'Quota failure retried too quickly');
 await page.clock.fastForward(1100);await count(freshQuota);assert(quotaCalls===2,'Bounded quota retry failed');
 // An in-flight old-day question and its UUID survive refresh; late old zero cannot override the new day.
 historyQuota=old(5,1);chatMode='hold';await navigate();await page.locator('#chat-input').fill('Вопрос перед полуночью');await page.locator('.send-button').click();await settle();
 const pendingId=chatBody.requestId;assert(releaseChat&&await page.locator('.waiting-message').count()===1,'Question not pending');
 await page.clock.fastForward(60001);await count(freshQuota);
 assert(await page.locator('.waiting-message').count()===1&&await page.locator('.user-message').count()===1&&chatCalls===1,'Refresh changed pending question');
 await releaseChat();await page.getByText('Поздний ответ',{exact:true}).waitFor();await count(freshQuota);
 assert(chatBody.requestId===pendingId&&chatCalls===1&&!(await page.locator('#chat-input').isDisabled()),'Late old quota overwrote fresh quota or request');
 // The same protection applies to a delayed 429 from the previous day.
 historyQuota=old(5,1);chatMode='hold-limit';await navigate();await page.locator('#chat-input').fill('Старый вопрос после смены дня');await page.locator('.send-button').click();await settle();
 await page.clock.fastForward(60001);await count(freshQuota);await releaseChat();await page.getByText('Лимит обновился. Попробуйте отправить вопрос ещё раз.',{exact:true}).waitFor();await count(freshQuota);
 assert(!(await page.locator('#chat-input').isDisabled())&&await page.locator('#chat-input').inputValue()==='Старый вопрос после смены дня','Old 429 zero overwrote fresh day or draft');
 // Refresh clears only cap-related text, not an unrelated input error.
 chatMode='invalid';await navigate();await page.locator('#chat-input').fill('Неподходящий вопрос');await page.locator('.send-button').click();await page.getByText('Проверьте текст вопроса и отправьте снова.',{exact:true}).waitFor();
 await page.clock.fastForward(60001);await count(freshQuota);assert(await page.getByText('Проверьте текст вопроса и отправьте снова.',{exact:true}).isVisible(),'Refresh cleared unrelated error');
 // A preserved iframe resumes independently of document visibility.
 historyQuota=old(5,0);quotaCalls=0;
 await page.route(base+'/quota-shell.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><iframe id="quota-ai" src="/ai.html"></iframe>'}));
 await page.goto(base+'/quota-shell.html');const frame=page.frameLocator('#quota-ai');await frame.getByText('На сегодня доступно 0/5',{exact:true}).waitFor();
 await page.locator('#quota-ai').evaluate(element=>{element.hidden=true});await page.clock.fastForward(60001);await settle();assert(quotaCalls===0,'Hidden iframe polled quota');
 await page.locator('#quota-ai').evaluate(element=>{element.hidden=false});await frame.getByText('На сегодня доступно 5/5',{exact:true}).waitFor();assert(quotaCalls===1,'Restored iframe did not refresh quota');
 // Recording continues while quota refreshes; no STT or question is triggered.
 chatMode='limit';historyQuota=old(5,1);await navigate();await page.getByRole('button',{name:'Записать голосом',exact:true}).click();await page.getByRole('button',{name:'Остановить запись',exact:true}).waitFor();
 await page.clock.fastForward(60001);await count(freshQuota);
 assert(await page.getByRole('button',{name:'Остановить запись',exact:true}).isEnabled()&&await page.evaluate(()=>quotaVoiceMock.stopped)===0&&chatCalls===0,'Refresh interrupted recording or submitted a question');
 await page.locator('#voice-cancel').click();
 // Logout aborts the separate quota request and rejects its late response.
 historyQuota=old(5,0);quotaMode='hold';await navigate();await page.clock.fastForward(60001);await settle();assert(releaseQuota,'Quota request not held');
 await page.evaluate(()=>window.dispatchEvent(new Event('webpril:session-ended')));await releaseQuota();await settle();await page.clock.fastForward(60001);
 assert(await page.locator('#chat-quota').innerText()===''&&await page.locator('#chat-input').isDisabled()&&quotaCalls===1,'Logout retained timer/late quota');
 // Legacy fixtures without serverTime must not create a local midnight guess.
 quotaMode='normal';historyQuota={limit:5,remaining:0,resetsAt:'2026-11-05T21:00:00.000Z'};await navigate();await page.clock.fastForward(86400001);await settle();assert(quotaCalls===0,'Legacy snapshot armed guessed timer');
 return {freeZeroToFive:true,paidZeroToThirty:true,serverClockNotDeviceClock:true,frozenMonotonicWakeRefreshesFiveAndThirty:true,noOptimisticWallClockReset:true,nextDayRearmed:true,draftFileHistoryPreserved:true,capNoticeCleared:true,pendingUuidAndWaitingPreserved:true,lateOldZeroIgnored:true,lateOld429Ignored:true,unrelatedErrorPreserved:true,hiddenIframeResume:true,recordingContinues:true,hiddenPanelAndSleepingResume:true,concurrentWakeDedup:true,failureRetriesAfter30Seconds:true,clockDriftHonorsFailureBackoff:true,logoutAbortsLateQuota:true,legacyNoClockNoTimer:true,realMicrophone:false,realApiCalls:0};
}
