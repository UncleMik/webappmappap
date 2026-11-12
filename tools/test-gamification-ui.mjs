import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { createUiFixture } from './test-gamification-ui-fixtures.mjs';
const require=createRequire('C:/Users/MIK/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const {chromium}=require('playwright');
const fixture=await createUiFixture(),origin='https://webpril-fixture.invalid';
const directory=resolve('output/playwright/gamification');await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const results=[],errors=[];
try {
 for(const width of [320,390,500]) {
  let current=await fixture.account(width),failAction=false,holdAction=false,release;
  const bodies=[];
  const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
   if(url.pathname.startsWith('/api/auth/')) {
    const path=url.pathname.slice('/api/auth/'.length),body=route.request().method()==='POST'?route.request().postDataJSON():undefined;
    const expected=route.request().headers()['x-webpril-account'];
    try {
     let value;
     if(path==='session')value={authenticated:true,user:current.user};
     else if(path==='gamification')value=await fixture.daily.state(current.token,expected);
     else if(path==='gamification/actions') {
      bodies.push(body);if(failAction){failAction=false;return route.abort();}
      if(holdAction)await new Promise(resolve=>{release=resolve;});
      value=await fixture.daily.action(current.token,expected,body);
     }else if(path==='gamification/preferences')value=await fixture.daily.preferences(current.token,expected,body);
     else if(path==='points')value={...await fixture.stars.withAccount(current.token,expected,(client,c)=>fixture.stars.wallet(client,c,{before:url.searchParams.get('before')})),accountId:expected};
     else if(path==='stars')value=await fixture.stars.state(current.token,expected);
     else if(path==='stars/purchase')value=await fixture.stars.purchase(current.token,expected,body);
     else if(path==='ai/quota')value=await fixture.stars.withAccount(current.token,expected,async(client,c)=>({accountId:expected,quota:await fixture.ai.quota(client,c)}));
     else if(path==='notifications/presentation')value=await fixture.notifications.claimPresentation(current.token,expected,body);
     else if(path==='notifications/visit')value=await fixture.notifications.visit(current.token,expected);
     else value={accountId:current.id,enabled:false};
     return route.fulfill({json:value});
    } catch(error) {if(error.code!=='account_changed')console.log('fixture API error',path,error.code,error.message);return route.fulfill({status:error.status||500,json:{error:error.code,message:error.message}});}
   }
   if(url.pathname==='/index.html') {
    let html=await readFile('Фронт/index.html','utf8');
    // Use the real page structure and styles; unrelated APIs/modules are isolated.
    html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('<style id="account-lock">html { visibility: hidden !important; }</style>','');
    html=html.replace('</body>',`<script>window.webprilSessionAccountId=${JSON.stringify(current.id)};</script><script type="module" src="gamification.js?v=20261112-stars"></script></body>`);
    return route.fulfill({contentType:'text/html',body:html});
   }
   const path=resolve('Фронт','.'+decodeURIComponent(url.pathname));if(!path.startsWith(resolve('Фронт')+'\\'))return route.abort();
   const types={'.js':'text/javascript','.css':'text/css','.woff':'font/woff','.webp':'image/webp','.svg':'image/svg+xml'};
   try{return route.fulfill({body:await readFile(path),contentType:types[extname(path)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
  });
  console.log('viewport',width);await page.goto(origin+'/index.html');await page.locator('.stars-shell:not([hidden])').waitFor();
  assert.equal((await page.locator('.stars-week-ring').textContent()).trim(),'0 / 2','server material denominator');
  await page.getByRole('button',{name:'Хорошо',exact:true}).click();await page.getByText('Отметка сохранена. Можно изменить без повторной награды.').waitFor();
  const question=page.getByRole('button',{name:'Вариант А',exact:true});assert.ok(await question.count()>0,'real daily question reaches UI');
  await question.first().click();await page.getByText('Синтетическое объяснение после ответа.').first().waitFor();
  const expectedSurprise = (await fixture.daily.state(current.token,current.id)).today.surprise?.text;
  assert.ok(expectedSurprise,'published synthetic surprise exists');
  if (width===320) await page.getByRole('button',{name:'Карточка 2',exact:true}).click();
  else if (width===390) {
    await page.getByRole('button',{name:'Перевернуть',exact:true}).click();
    await page.getByRole('button',{name:'Перевернуть карточку',exact:true}).click();
  } else {
    await page.getByRole('button',{name:'Стереть',exact:true}).click();
    const canvas=page.locator('.stars-scratch canvas'),rect=await canvas.boundingBox();
    await page.mouse.move(rect.x+8,rect.y+20);await page.mouse.down();
    await page.mouse.move(rect.x+rect.width-8,rect.y+20,{steps:24});
    await page.mouse.move(rect.x+rect.width-8,rect.y+80,{steps:8});
    await page.mouse.move(rect.x+8,rect.y+80,{steps:24});await page.mouse.up();
  }
  await page.getByText(expectedSurprise,{exact:true}).waitFor();
  console.log('daily actions passed',width);await page.locator('.stars-trigger').click();await page.getByRole('tab',{name:'Кошелёк',exact:true}).waitFor();
  assert.ok((await page.locator('.stars-history li').count())>0,'wallet actual ledger');
  await page.getByRole('button',{name:'Показать ещё',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.stars-history li').length>20);
  await page.getByRole('tab',{name:'Письма',exact:true}).click();await page.getByText('Личное тестовое письмо.').waitFor();
  console.log('wallet letters passed',width);await page.getByRole('tab',{name:'Мои дела',exact:true}).click();
  await page.getByRole('checkbox',{name:'Предмет 1 для проверки',exact:true}).check();
  await page.waitForFunction(()=>!document.querySelector('.stars-dialog').textContent.includes('Сохраняем…'));
  const textarea=page.getByRole('textbox',{name:'Письмо себе',exact:true});await textarea.fill('Личное синтетическое письмо для проверки капсулы.');
  await page.getByRole('button',{name:'Запечатать письмо',exact:true}).click();await page.getByText('Письмо запечатано.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Письмо себе',exact:true}).count(),0,'sealed letter body absent');
  await page.getByRole('button',{name:'Удалить письмо',exact:true}).click();await page.getByRole('button',{name:'Подтвердить удаление',exact:true}).click();await page.getByRole('textbox',{name:'Письмо себе',exact:true}).waitFor();
  // Keyboard, scrolling and viewport including keyboard-sized height.
  await page.getByRole('tab',{name:'Настройки',exact:true}).click();await page.getByRole('checkbox',{name:'Приостановить сообщения о малыше',exact:true}).check();
  await page.waitForFunction(()=>document.documentElement.classList.contains('baby-messages-paused'));
  await page.getByRole('tab',{name:'Письма',exact:true}).click();assert.equal(await page.getByText('Личное тестовое письмо.').count(),0);
  await page.getByRole('tab',{name:'Настройки',exact:true}).click();await page.getByRole('checkbox',{name:'Приостановить сообщения о малыше',exact:true}).uncheck();
  await page.waitForFunction(()=>!document.documentElement.classList.contains('baby-messages-paused'));
  await page.getByRole('tab',{name:'Мои дела',exact:true}).click();await page.setViewportSize({width,height:420});
  await page.getByRole('textbox',{name:'Письмо себе',exact:true}).fill('Проверка клавиатуры');
  const overflow=await page.evaluate(()=>({page:document.documentElement.scrollWidth>innerWidth,dialog:document.querySelector('.stars-dialog').scrollWidth>document.querySelector('.stars-dialog').clientWidth}));
  assert.deepEqual(overflow,{page:false,dialog:false});
  await page.screenshot({path:resolve(directory,'keyboard-'+width+'.png')});
  await page.keyboard.press('Escape');assert.equal(await page.locator('.stars-dialog').evaluate(node=>node.open),false);
  await page.setViewportSize({width,height:844});
  // Transport retry must reuse its mutation identifier.
  failAction=true;await page.getByRole('button',{name:'Спокойно',exact:true}).click();await page.getByText('Не удалось связаться с сервером.',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Спокойно',exact:true}).click();await page.getByRole('button',{name:'Спокойно',exact:true}).getAttribute('aria-pressed');
  await page.waitForTimeout(200);assert.equal(bodies.at(-1).requestId,bodies.at(-2).requestId);
  await page.screenshot({path:resolve(directory,'today-'+width+'.png')});
  await page.locator('.stars-trigger').click();await page.getByRole('tab',{name:'Кошелёк',exact:true}).click();
  await page.getByRole('button',{name:/Открыть 36-ю неделю за/}).click();await page.getByRole('button',{name:/Подтвердить —/}).click();
  await page.getByText('Покупка сохранена. Возможность уже доступна.').waitFor({timeout:5000}).catch(async error=>{console.log('purchase screen',await page.locator('.stars-dialog').innerText());throw error;});
  assert.deepEqual((await fixture.stars.state(current.token,current.id)).purchasedWeeks,[36]);
  for (let pack=0;pack<2;pack++) {await page.getByRole('button',{name:'Купить пакет за 50 ★',exact:true}).click();await page.getByRole('button',{name:'Подтвердить — 50 ★',exact:true}).click();await page.getByText('Покупка сохранена. Возможность уже доступна.').waitFor({timeout:5000}).catch(async error=>{console.log('purchase screen',await page.locator('.stars-dialog').innerText());throw error;});}
  assert.equal(await page.getByRole('button',{name:'Купить пакет за 50 ★',exact:true}).count(),0);assert.equal((await fixture.stars.state(current.token,current.id)).aiCredits,6);
  // Old in-flight data must not survive switching accounts.
  await page.keyboard.press('Escape');holdAction=true;await page.getByRole('button',{name:'Устала',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.stars-shell').textContent.includes('Сохраняем'));
  const previous=current;current=await fixture.account(width+1);
  await page.evaluate(id=>{window.webprilSessionAccountId=id;window.dispatchEvent(new CustomEvent('account:change'));},current.id);
  if(release)release();holdAction=false;
  await page.waitForFunction(()=>document.querySelector('.stars-shell:not([hidden])')&& !document.querySelector('.stars-shell').textContent.includes('Отметка сохранена'));
  assert.equal(await page.locator('.stars-dialog').evaluate(node=>node.open),false);
  for (const variant of ['legacy','preserved','locks-off']) {
    await fixture.pool.query('UPDATE auth_stars_wallet SET legacy=$2,preserved_weeks=$3 WHERE user_id=$1',[current.id,variant==='legacy',variant==='preserved'?[36]:[]]);
    fixture.config.features.weekLocks=variant!=='locks-off';
    await page.evaluate(async()=>{await (await import('./gamification-api.js?v=20261112-stars')).loadGamification();});
    await page.locator('.stars-trigger').click();
    assert.equal(await page.getByRole('button',{name:/Открыть 36-ю неделю за/}).count(),0,'never sell already available week: '+variant);
    await page.keyboard.press('Escape');
  }
  fixture.config.features.weekLocks=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('webpril:session-ended')));
  assert.equal(await page.locator('.stars-shell').evaluate(node=>node.hidden),true);
  results.push({width,passed:true,engine:fixture.db.engine,checks:['real domain API','checkin','myth','game choose/flip/scratch','ledger pagination >20','letters','checklist','capsule save/delete','pause','keyboard','scroll','retry id','week purchase','AI pack purchases x2 and limit','no sale legacy/preserved/locks-off','account switch','session end']});
  await context.close();
 }
 assert.deepEqual(errors,[]);
 await writeFile(resolve(directory,'result.json'),JSON.stringify({results,errors,fixtureOnly:true,production:false},null,2));
 console.log(JSON.stringify({results,errors}));
} finally {await browser.close();await fixture.db.close();}
