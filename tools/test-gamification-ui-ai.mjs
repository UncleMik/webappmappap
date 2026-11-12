import {createRequire} from 'node:module';import {readFile,mkdir,writeFile} from 'node:fs/promises';import {resolve,extname} from 'node:path';import assert from 'node:assert/strict';
const require=createRequire('C:/Users/MIK/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');const {chromium}=require('playwright');
const origin='https://webpril-fixture.invalid',accountId='11111111-1111-4111-8111-111111111111',directory=resolve('output/playwright/gamification');await mkdir(directory,{recursive:true});const browser=await chromium.launch({headless:true,channel:'chrome'});
const results=[],errors=[];
try{for(const width of [320,390,500]){
 const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'}),page=await context.newPage();let calls=[],quota={limit:5,remaining:0,freeRemaining:0,paidRemaining:3,paidDailyRemaining:0,totalRemaining:0,maximum:11},rows=[];
 page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();const pathname=url.pathname;
  if(pathname.startsWith('/api/auth/')){
   let data;const path=pathname.slice(10),body=route.request().method()==='POST'?route.request().postDataJSON():null;
   if(path==='session')data={authenticated:true,user:{id:accountId,email:'fixture@example.invalid',profile:{stage:'pregnancy',dueDate:'2027-03-01',completedAt:'yes',name:'Проверка'}}};
   else if(path==='gamification'||path==='stars')data={accountId,enabled:true,tier:'free',currentWeek:35,wallet:{balance:1234,dailyRemaining:100,dailyLimit:100,history:[]},today:null,weeks:[],features:{},settings:{},preferences:{}};
   else if(path==='ai/quota')data={accountId,quota};
   else if(path==='ai/conversations'&&!body)data={accountId,conversations:[],hasMore:false,nextBefore:null};
   else if(path==='ai/conversations'&&body)data={accountId,conversation:{id:body.conversationId,title:'Новый чат',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}};
   else if(path==='ai/messages'){
    calls.push(body);
    if(!body.urgentContinue)data={accountId,requestId:body.requestId,status:'urgent',quota,urgent:{title:'Синтетическая срочная подсказка',body:'Тестовый утверждённый текст.',reassurance:'Тестовая поддержка.',free:true,continueToken:{expires:Date.now()+600000,signature:'test-signature'},actions:[{type:'call',href:'tel:103',label:'Позвонить 103'},{type:'continue',label:'Это не срочно, продолжить'}]}};
    else {quota={...quota,freeRemaining:1,totalRemaining:1,remaining:1};rows=[{id:'u'+calls.length,role:'user',content:body.text,requestId:body.requestId,status:'completed',createdAt:new Date().toISOString()},{id:'a'+calls.length,role:'assistant',content:'Тестовый ответ после продолжения.',requestId:body.requestId,createdAt:new Date().toISOString()}];data={accountId,conversationId:body.conversationId,requestId:body.requestId,status:'completed',messages:rows,quota};}
   }else data={accountId,enabled:false};
   return route.fulfill({json:data});
  }
  if(pathname==='/ai.html'){
   let html=await readFile('Фронт/ai.html','utf8');html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('<style id="account-lock">html { visibility: hidden !important; }</style>','');
   html=html.replace('</body>',`<script>window.webprilSessionAccountId=${JSON.stringify(accountId)};</script><script type="module" src="ai.js?v=20261112-stars"></script><script type="module" src="gamification.js?v=20261112-stars"></script></body>`);return route.fulfill({contentType:'text/html',body:html});
  }
  const path=resolve('Фронт','.'+decodeURIComponent(pathname)),types={'.js':'text/javascript','.css':'text/css','.woff':'font/woff','.webp':'image/webp'};try{return route.fulfill({body:await readFile(path),contentType:types[extname(path)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto(origin+'/ai.html');await page.waitForFunction(()=>!document.querySelector('#chat-input').disabled);
 assert.ok((await page.locator('#chat-quota').innerText()).includes('запас: 3'));
 await page.locator('#chat-input').fill('Синтетический тревожный текст');await page.getByRole('button',{name:'Отправить сообщение',exact:true}).click();
 await page.getByRole('heading',{name:'Синтетическая срочная подсказка'}).waitFor();assert.equal(calls.length,1);assert.equal(calls[0].urgentContinue,undefined);
 assert.equal(await page.getByRole('link',{name:'Позвонить 103'}).getAttribute('href'),'tel:103');
 assert.equal(await page.locator('.ai-urgent-dialog').evaluate(node=>node.scrollWidth>node.clientWidth),false);
 await page.screenshot({path:resolve(directory,'urgent-'+width+'.png')});
 await page.getByRole('button',{name:'Это не срочно, продолжить',exact:true}).click();await page.getByText('Тестовый ответ после продолжения.',{exact:true}).waitFor();
 assert.equal(calls.length,2);assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[0].text,calls[1].text);assert.equal(calls[0].conversationId,calls[1].conversationId);assert.equal(calls[1].urgentContinue.signature,'test-signature');
 await page.locator('#chat-input').fill('Новый синтетический текст');await page.getByRole('button',{name:'Отправить сообщение',exact:true}).click();await page.getByRole('heading',{name:'Синтетическая срочная подсказка'}).waitFor();assert.equal(calls.length,3);assert.equal(calls[2].urgentContinue,undefined);
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#chat-input').disabled);
 await page.setViewportSize({width,height:420});await page.locator('#chat-input').fill('Текст при клавиатуре');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('#chat-input').evaluate(node=>node.getBoundingClientRect().bottom>document.querySelector('.bottom-navigation').getBoundingClientRect().top),false);
 results.push({width,quotaAndUrgent:true,sameRequestContinuation:true,newQuestionRescreened:true,keyboard:true});await context.close();
}assert.deepEqual(errors,[]);await writeFile(resolve(directory,'ai-result.json'),JSON.stringify({fixtureOnly:true,results,errors},null,2));console.log(JSON.stringify({results,errors}));}finally{await browser.close();}
