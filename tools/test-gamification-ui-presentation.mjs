import {createRequire} from 'node:module';import {readFile,mkdir,writeFile} from 'node:fs/promises';import {resolve,extname} from 'node:path';import assert from 'node:assert/strict';
import {createUiFixture} from './test-gamification-ui-fixtures.mjs';
const require=createRequire('C:/Users/MIK/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');const {chromium}=require('playwright');
const origin='https://webpril-presentation-fixture.invalid',directory=resolve('output/playwright/gamification');await mkdir(directory,{recursive:true});const results=[],errors=[];
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{for(const width of [320,390,500]){
 const fixture=await createUiFixture({presentations:true});let current=await fixture.account(width),blocker=false;const calls=[];
 const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push({width,message:e.message}));
 const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const reload=async()=>{await page.goto(origin+'/index.html');await page.locator('.stars-shell:not([hidden])').waitFor();};
 const state=()=>fixture.daily.state(current.token,current.id),balance=async()=> (await fixture.stars.state(current.token,current.id)).wallet.balance;
 try{
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();const path=url.pathname;
   if(path.startsWith('/api/auth/')){
    const endpoint=path.slice(10),body=route.request().method()==='POST'?route.request().postDataJSON():undefined,expected=route.request().headers()['x-webpril-account'];calls.push({endpoint,body});
    try{let value;
     if(endpoint==='session')value={authenticated:true,user:current.user};
     else if(endpoint==='gamification')value=await fixture.daily.state(current.token,expected);
     else if(endpoint==='stars')value=await fixture.stars.state(current.token,expected);
     else if(endpoint==='gamification/actions')value=await fixture.daily.action(current.token,expected,body);
     else if(endpoint==='gamification/preferences')value=await fixture.daily.preferences(current.token,expected,body);
     else if(endpoint==='notifications/presentation')value=await fixture.notifications.claimPresentation(current.token,expected,body);
     else if(endpoint==='notifications/visit')value=await fixture.notifications.visit(current.token,expected);
     else if(endpoint==='notifications')value=await fixture.notifications.list(current.token,expected);
     else if(endpoint==='ai/quota')value=await fixture.stars.withAccount(current.token,expected,async(client,c)=>({accountId:expected,quota:await fixture.ai.quota(client,c)}));
     else if(endpoint==='points')value={accountId:expected,...await fixture.stars.withAccount(current.token,expected,(client,c)=>fixture.stars.wallet(client,c))};
     else value={accountId:expected,enabled:false};
     return route.fulfill({json:value});
    }catch(error){return route.fulfill({status:error.status||500,json:{error:error.code,message:error.message}});}
   }
   if(path==='/index.html'){
    let html=await readFile('Фронт/index.html','utf8');html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('<style id="account-lock">html { visibility: hidden !important; }</style>','');
    const blocking=blocker?'<dialog id="fixture-urgent" class="ai-urgent-dialog"><p>Синтетическое срочное окно</p><button id="fixture-close" onclick="this.closest(\'dialog\').close()">Закрыть срочное окно</button></dialog><script>document.querySelector("#fixture-urgent").showModal();</script>':'';
    html=html.replace('</body>',`<script>window.webprilSessionAccountId=${JSON.stringify(current.id)};</script>${blocking}<script type="module" src="gamification.js?v=20261112-stars"></script></body>`);return route.fulfill({contentType:'text/html',body:html});
   }
   const file=resolve('Фронт','.'+decodeURIComponent(path)),type={'.js':'text/javascript','.css':'text/css','.woff':'font/woff','.webp':'image/webp'}[extname(file)];try{return route.fulfill({body:await readFile(file),contentType:type||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
  });
  const before=await balance();await reload();await page.getByRole('heading',{name:'Рады видеть тебя!',exact:true}).waitFor();assert.equal(await balance(),before,'welcome screen never grants new credit');
  assert.equal(await page.locator('.stars-hint').count(),0,'celebration priority');await page.screenshot({path:resolve(directory,'celebration-'+width+'.png')});
  await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.evaluate(async()=>{await (await import('./gamification-api.js?v=20261112-stars')).loadGamification();});await settle();assert.equal(await page.locator('.stars-hint').count(),0,'hint deferred after celebration');
  await reload();await page.locator('.stars-hint').waitFor();const hint=await page.locator('.stars-hint p').innerText();assert.equal(await page.locator('.stars-celebration').count(),0,'same login no repeated celebration');assert.equal(await balance(),before,'hint never grants credit');
  await page.getByRole('button',{name:'Понятно',exact:true}).click();await reload();await settle();assert.equal(await page.locator('.stars-hint').count(),0,'one hint per day');assert.equal((await state()).presentation.hint,null);
  fixture.advance(1);await reload();await page.locator('.stars-hint').waitFor();assert.notEqual(await page.locator('.stars-hint p').innerText(),hint,'seen feature never repeated next day');await page.screenshot({path:resolve(directory,'hint-'+width+'.png')});
  await fixture.daily.preferences(current.token,current.id,{quiet:true});await reload();await settle();assert.equal(await page.locator('.stars-hint,.stars-celebration').count(),0,'quiet suppresses optional presentations');
  current=await fixture.account(width+1);blocker=true;const claimCount=calls.filter(x=>x.endpoint==='notifications/presentation').length;await reload();await settle();assert.equal(await page.locator('.stars-celebration').count(),0,'urgent/modal blocks celebration');assert.equal(calls.filter(x=>x.endpoint==='notifications/presentation').length,claimCount,'no claim while blocked');
  await page.getByRole('button',{name:'Закрыть срочное окно',exact:true}).click();await page.getByRole('heading',{name:'Рады видеть тебя!',exact:true}).waitFor();await page.getByRole('button',{name:'Продолжить',exact:true}).click();blocker=false;
  await fixture.stars.withAccount(current.token,current.id,(client,c)=>fixture.stars.credit(client,c,{code:'week_complete',ref:'34',amount:50,capped:false}));await fixture.renewSession(current);
  await fixture.daily.preferences(current.token,current.id,{babyPause:true});const pausedBalance=await balance();await reload();await settle();assert.equal(await page.locator('.stars-hint,.stars-celebration').count(),0,'baby pause hides week celebration');
  await fixture.daily.preferences(current.token,current.id,{babyPause:false});await reload();await page.getByRole('heading',{name:'Неделя 34 завершена',exact:true}).waitFor();assert.equal(await balance(),pausedBalance,'week screen displays prior actual ledger reward only');await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  await fixture.stars.withAccount(current.token,current.id,(client,c)=>fixture.stars.credit(client,c,{code:'trimester_complete',ref:'28',amount:30,capped:false}));await reload();await settle();assert.equal(await page.locator('.stars-celebration').count(),0,'second event blocked in same actual login');
  await fixture.renewSession(current);await reload();await page.getByRole('heading',{name:'Триместр завершён',exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  results.push({width,passed:true,priority:true,oncePerDay:true,permanentFeatureSeen:true,actualSessionLimit:true,urgentDeferral:true,babyPause:true,noFalseCredit:true});
 }finally{await context.close();await fixture.db.close();}
}assert.deepEqual(errors,[]);await writeFile(resolve(directory,'presentation-result.json'),JSON.stringify({fixtureOnly:true,production:false,results,errors},null,2));console.log(JSON.stringify({results,errors}));}finally{await browser.close();}
