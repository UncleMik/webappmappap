import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createUiFixture} from './test-gamification-ui-fixtures.mjs';
const require=createRequire('C:/Users/MIK/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const {chromium}=require('playwright'),fixture=await createUiFixture(),origin='https://localhost',reference='9f591a35f459b340e932566c0ecd7cc3a7ef7771';
const directory=resolve('output/playwright/gamification-layout-restore');await mkdir(directory,{recursive:true});
const photo=await readFile('backend/test/fixtures/profile-edit-noise.jpg'),cache=new Map(),results=[];
async function source(path,baseline){if(!baseline)return readFile(resolve('Фронт',path));if(!cache.has(path)){const r=spawnSync('git',['show',reference+':Фронт/'+path],{maxBuffer:12000000});cache.set(path,r.status===0?r.stdout:await readFile(resolve('Фронт',path)));}return cache.get(path);}
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{for(const width of [320,390,500]){
 let actor=await fixture.account(width);actor.user.profile.photoVersion=crypto.randomUUID();actor.user.profile.name='Проверка выпуска';await fixture.pool.query('UPDATE auth_users SET profile=$2 WHERE id=$1',[actor.id,actor.user.profile]);
 for(let i=0;i<4;i++)await fixture.stars.withAccount(actor.token,actor.id,(client,c)=>fixture.stars.credit(client,c,{code:'fixture',ref:'long-balance-'+i,amount:30000,capped:false}));
 const versions={};
 for(const baseline of [true,false]){
  const errors=[],unknown=[],context=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'}),page=await context.newPage();let failPhoto=false,pilot=true,failAuth=false,initialStateRelease,oldPointsRelease,oldPointsStarted,oldPointsHeld=false;const initialStateGate=baseline?Promise.resolve():new Promise(r=>initialStateRelease=r),oldPointsGate=new Promise(r=>oldPointsStarted=r);
  page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url()),path=url.pathname,expected=req.headers()['x-webpril-account']||actor.id,body=req.method()==='POST'?req.postDataJSON():undefined;
   if(path==='/api/auth/profile-photo')return route.fulfill(failPhoto?{status:500,body:''}:{contentType:'image/jpeg',body:photo});
   if(path.startsWith('/api/')){try{let value;
    const key=path.replace('/api/auth/','');if(failAuth && ['gamification','stars','points'].includes(key))return route.fulfill({status:401,json:{error:'sign_in_required'}});if(key==='gamification')await initialStateGate;
    if(key==='session')value={authenticated:true,user:actor.user};
    else if(key==='personal')value={accountId:actor.id,weights:[],pressure:[],wellbeing:[],baby:{},movements:[],readArticles:['fixture-article-1'],favorites:[]};
    else if(key==='gamification')value=pilot?await fixture.daily.state(actor.token,expected):{accountId:actor.id,enabled:false};
    else if(key==='gamification/actions')value=await fixture.daily.action(actor.token,expected,body);
    else if(key==='gamification/preferences')value=await fixture.daily.preferences(actor.token,expected,body);
    else if(key==='stars')value=pilot?await fixture.stars.state(actor.token,expected):{accountId:actor.id,enabled:false};
    else if(key==='stars/purchase')value=await fixture.stars.purchase(actor.token,expected,body);
    else if(key==='points')value={...await fixture.stars.withAccount(actor.token,expected,(client,c)=>fixture.stars.wallet(client,c,{before:url.searchParams.get('before')})),accountId:actor.id,enabled:true};
    else if(key==='ai/quota')value=await fixture.stars.withAccount(actor.token,expected,async(client,c)=>({accountId:actor.id,quota:await fixture.ai.quota(client,c)}));
    else if(key==='notifications/presentation')value=await fixture.notifications.claimPresentation(actor.token,expected,body);
    else if(key==='notifications/visit')value=await fixture.notifications.visit(actor.token,expected);
    else if(key==='weekly-poll')value={accountId:actor.id,available:true,enabled:true,poll:{id:'fixture-current',question:'Текущее голосование недели',options:['Первый','Второй'],open:true,choice:null,counts:null,closesAt:new Date(Date.now()+86400000).toISOString()}};
    else if(key==='courses'){const now=Date.now();value={accountId:actor.id,courses:[],serverTime:new Date(now).toISOString(),expiresAt:new Date(now+240000).toISOString(),validUntil:new Date(now+240000).toISOString()};}
    else if(key==='announcements')value={accountId:actor.id,announcements:[]};
    else if(key==='club')value={accountId:actor.id,rooms:[]};
    else if(path==='/api/articles')value={articles:[1,2,3].map(i=>({id:'fixture-article-'+i,week:35,title:'Материал недели '+i,minutes:4+i,image:'/fixture/photo.jpg'}))};
    else if(path==='/api/weekly-content')value={mom:Object.fromEntries(Array.from({length:42},(_,i)=>[i+1,{title:'Мама',paragraphs:['Изменения этой недели. Забота о себе.']}])),baby:Object.fromEntries(Array.from({length:42},(_,i)=>[i+1,{measurements:'45 см · 2500 г',measurementNote:'Средние значения',description:'Малыш растёт.',illustration:'/fixture/photo.jpg',developmentDescription:'Развитие малыша.'}])),calendar:Object.fromEntries(Array.from({length:42},(_,i)=>[i+1,[]]))};
    else if(path==='/api/course-offers')value={offers:[8835218,8835266,8835331].map((offerId,i)=>({offerId,displayName:'Программа '+(i+1),items:[{productId:100+i,title:'Курс '+i,type:'training'}]}))};
    else if(/\/cover$/.test(path))return route.fulfill({contentType:'image/jpeg',body:photo});
    else {unknown.push(path);value={accountId:actor.id,enabled:false,notifications:[],preferences:{}};}
    if(key==='points'&&!baseline&&!oldPointsHeld){oldPointsHeld=true;oldPointsStarted();await new Promise(r=>oldPointsRelease=r);}return route.fulfill({json:value});
   }catch(e){errors.push('API '+path+': '+e.message);return route.fulfill({status:e.status||500,json:{error:e.code,message:e.message}});}}
   if(path.startsWith('/fixture/'))return route.fulfill({contentType:'image/jpeg',body:photo});
   if(url.origin!==origin)return route.abort();
   try{const p=decodeURIComponent(path==='/'?'index.html':path.slice(1));let data=await source(p,baseline);const ext=extname(p),types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff':'font/woff','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml','.ttf':'font/ttf'};
    // Keep every real script; rewrite only the content transport origin for fixture isolation.
    if(ext==='.js')data=Buffer.from(data.toString().replaceAll('https://app.legkie-rody.ru',origin));
    return route.fulfill({body:data,contentType:types[ext]||'application/octet-stream'});
   }catch{return route.fulfill({status:404,body:''});}
  });
  const label=baseline?'baseline':'current';console.log(width,label);
  await page.goto(origin+'/index.html');if(!baseline){await oldPointsGate;initialStateRelease();}await page.locator('[data-account-photo] img').waitFor();await page.waitForFunction(()=>document.querySelector('[data-account-photo] img')?.naturalWidth>0);await page.locator('.today-material-card').first().waitFor();await page.locator('#points-trigger').waitFor();await page.evaluate(()=>document.fonts.ready);
  if(!baseline)await page.waitForFunction(()=>document.documentElement.classList.contains('stars-enabled'));
  await page.waitForTimeout(180);
  const layout=await page.evaluate(()=>{const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};return{main:[...document.querySelector('main').children].map(n=>n.className),header:[...document.querySelector('.header-actions').children].map(n=>({tag:n.tagName,id:n.id,class:n.className,rect:rect(n)})),cards:[...document.querySelectorAll('#today-articles > *')].map(n=>({class:n.className,title:n.querySelector('.article-title')?.textContent,href:n.getAttribute('href'),visible:getComputedStyle(n).display!=='none',rect:rect(n)})),width:document.documentElement.scrollWidth,photo:document.querySelector('[data-account-photo] img').naturalWidth};});
  assert.equal(await page.locator('main .stars-shell,main .stars-links,.stars-trigger').count(),0);assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('#weekly-poll-card').isVisible(),true);assert.equal(layout.width,width);await page.screenshot({path:resolve(directory,`${label}-today-${width}.png`),fullPage:true});
  versions[label]={today:layout};
  if(!baseline){
   const withoutRects=value=>JSON.parse(JSON.stringify(value,(k,v)=>k==='rect'?undefined:v));assert.deepEqual(withoutRects(layout),withoutRects(versions.baseline.today),'Today structure matches baseline');for(const group of ['header','cards'])layout[group].forEach((item,i)=>{for(const key of ['x','y','width','height'])assert.ok(Math.abs(item.rect[key]-versions.baseline.today[group][i].rect[key])<1,'baseline geometry within one CSS pixel: '+group+' '+key);});
   const personalized=[];for(const name of ['Александра Мария Константиновна','АлександраКонстантиновнаАлександраКонстантиновна']){actor.user.profile.name=name;await page.evaluate(()=>window.dispatchEvent(new Event('profile:saved')));await page.waitForFunction(n=>document.querySelector('.greeting')?.textContent.includes(n),name);const metrics=await page.evaluate(()=>{const g=document.querySelector('.greeting').getBoundingClientRect(),a=document.querySelector('.header-actions').getBoundingClientRect(),img=document.querySelector('[data-account-photo] img');return{width:innerWidth,scroll:document.documentElement.scrollWidth,greetingRight:g.right,actionsLeft:a.left,actionsRight:a.right,photo:img?.naturalWidth};});assert.equal(metrics.width,metrics.scroll);assert.ok(metrics.greetingRight<=metrics.actionsLeft&&metrics.actionsRight<=metrics.width&&metrics.photo>0);personalized.push({name,...metrics});}versions[label].personalized=personalized;await page.screenshot({path:resolve(directory,`long-name-${width}.png`)});actor.user.profile.name='Проверка выпуска';await page.evaluate(()=>window.dispatchEvent(new Event('profile:saved')));
   await page.locator('#points-trigger').click();await page.getByRole('tab',{name:'Баллы',exact:true}).waitFor();assert.equal(await page.locator('dialog[open]').count(),1);assert.equal(await page.locator('#points-dialog').count(),1);
   await page.getByRole('tab',{name:'Твой день',exact:true}).click();await page.getByRole('button',{name:'Хорошо',exact:true}).click();await page.getByText('Отметка сохранена. Можно изменить без повторной награды.').waitFor();const freshBalance=(await fixture.stars.state(actor.token,actor.id)).wallet.balance;oldPointsRelease();await page.waitForTimeout(150);assert.equal(Number((await page.locator('#points-trigger-balance').textContent()).replace(/\s/g,'')),freshBalance,'late legacy points cannot overwrite pilot balance');assert.equal(await page.locator('#points-dialog').evaluate(n=>n.open),true,'late legacy points cannot close pilot window');await page.getByRole('button',{name:'Вариант А',exact:true}).first().click();await page.getByText('Синтетическое объяснение после ответа.').first().waitFor();
   await page.locator('#points-dialog').evaluate(n=>n.scrollTop=0);await page.screenshot({path:resolve(directory,`window-${width}.png`)});assert.equal(await page.locator('dialog[open]').count(),1);
   await page.getByRole('tab',{name:'Мои дела',exact:true}).click();await page.getByRole('checkbox',{name:'Предмет 1 для проверки',exact:true}).check();await page.waitForTimeout(200);
   await page.getByRole('tab',{name:'Письма',exact:true}).click();await page.getByText('Личное тестовое письмо.').waitFor();await page.keyboard.press('Escape');
   await page.evaluate(()=>window.dispatchEvent(new Event('profile:saved')));await page.waitForFunction(()=>document.querySelector('[data-account-photo] img')?.naturalWidth>0);
   pilot=false;await page.evaluate(async()=>{await(await import('./gamification-api.js?v=20261112-stars')).loadGamification();});await page.locator('#points-trigger').click();await page.locator('#points-dialog[open] [data-legacy-points-guide]').waitFor();assert.equal(await page.locator('[data-stars-ui]:visible').count(),0);await page.keyboard.press('Escape');pilot=true;await page.evaluate(async()=>{await(await import('./gamification-api.js?v=20261112-stars')).loadGamification();});
   failPhoto=true;actor.user.profile.photoVersion=crypto.randomUUID();await page.evaluate(()=>window.dispatchEvent(new Event('profile:saved')));await page.locator('[data-account-photo][aria-label="Не удалось загрузить фото"]').waitFor();failPhoto=false;await page.evaluate(()=>window.dispatchEvent(new Event('profile:saved')));await page.waitForFunction(()=>document.querySelector('[data-account-photo] img')?.naturalWidth>0);
  }
  await page.goto(origin+'/journey.html');await page.locator('.course-list .course-card').first().waitFor();await page.locator('.article-list .journey-content-card').first().waitFor({timeout:5000});await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(200);
  const journey=await page.evaluate(()=>({main:[...document.querySelector('main').children].map(n=>n.className),headings:[...document.querySelectorAll('main h2')].map(n=>n.textContent),width:document.documentElement.scrollWidth}));versions[label].journey=journey;assert.equal(await page.locator('main .stars-shell,main .stars-links').count(),0);await page.screenshot({path:resolve(directory,`${label}-journey-${width}.png`),fullPage:true});
  if(!baseline){assert.deepEqual(journey,versions.baseline.journey);await page.locator('a[href="index.html"]').first().click();await page.waitForTimeout(450);const todayFrame=(await Promise.all(page.frames().map(async f=>(await f.locator('#today').count())?f:null))).find(Boolean);assert.ok(todayFrame,'Journey→Today uses actual navigation');await todayFrame.waitForFunction(()=>document.querySelector('[data-account-photo] img')?.naturalWidth>0);assert.equal(await todayFrame.locator('.stars-trigger,main .stars-shell').count(),0);
   pilot=false;await todayFrame.evaluate(async()=>{await(await import('./gamification-api.js?v=20261112-stars')).loadGamification();});await todayFrame.locator('#points-trigger').click();await todayFrame.locator('#points-dialog[open] [data-legacy-points-guide]').waitFor();assert.equal(await todayFrame.locator('[data-stars-ui]:visible').count(),0);assert.equal(Number((await todayFrame.locator('#points-trigger-balance').textContent()).replace(/\s/g,'')),(await fixture.stars.state(actor.token,actor.id)).wallet.balance,'nonpilot legacy balance is loaded');await page.keyboard.press('Escape');pilot=true;await todayFrame.evaluate(async()=>{await(await import('./gamification-api.js?v=20261112-stars')).loadGamification();});await todayFrame.locator('#points-trigger').click();await todayFrame.getByRole('tab',{name:'Баллы',exact:true}).waitFor();failAuth=true;await todayFrame.evaluate(async()=>{try{await(await import('./gamification-api.js?v=20261112-stars')).loadGamification();}catch{}});assert.equal(await todayFrame.locator('#points-dialog').evaluate(n=>n.open),false,'API 401 immediately closes private window');assert.equal(await todayFrame.locator('#stars-panel').textContent(),'','API 401 removes private history');assert.equal(await todayFrame.evaluate(async()=>(await import('./gamification-api.js?v=20261112-stars')).snapshot()),null,'API 401 clears personal snapshot');
  }
  assert.deepEqual(errors,[]);versions[label].errors=errors;versions[label].unhandledApi=[...new Set(unknown)];await context.close();
 }
 results.push({width,isMobile:true,hasTouch:true,passed:true,checks:['baseline main order and header spacing','poll first and original article/practice cards','photo success/failure/recovery','long names and six digit balance','single explicit points window','daily actions and checklist','late legacy points after checkin','Journey to Today via app-navigation','legacy fallback','API 401 clears window and snapshot'],...versions});
}}
finally{await browser.close();await fixture.db.close();await writeFile(resolve(directory,'result.json'),JSON.stringify(results,null,2));}
console.log('layout restore:',results.length,'widths passed');
