// Browser routes invoke real gamificationAdmin + isolated SQL fixture. No server/listener or production.
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fixture} from '../backend/test/gamification-admin-fixture.mjs';
import {COOKIE_NAME,randomToken,hashToken,readSessionCookie} from '../backend/auth/security.mjs';
const require=createRequire('C:/Users/MIK/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const {chromium}=require('playwright');
if(process.env.AUTH_TEST_DATABASE_URL)throw new Error('Browser QA uses isolated PGlite only; unset AUTH_TEST_DATABASE_URL.');
const origin='https://webpril-admin-fixture.invalid',directory=resolve('output/playwright/gamification-admin');
await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),results=[],findings=[],pageErrors=[],apiErrors=[],network=[];
try {
 for(const width of [390,1280]) {
  const cleanup=[],x=await fixture({after:fn=>cleanup.push(fn)}),token=randomToken(),name='Анна Пилот '+width;
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'}),page=await context.newPage();
  let stage='setup';const checks=[];page.setDefaultTimeout(10000);
  const check=(condition,label,detail)=>{checks.push({label,passed:!!condition});if(!condition)findings.push({width,stage,label,...(detail?{detail}: {})});};
  const overflow=async(label)=>{const value=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('#gamification *')].filter(n=>{const r=n.getBoundingClientRect();return r.width&&r.right>innerWidth+1;}).slice(0,8).map(n=>({tag:n.tagName,class:n.className,text:n.textContent?.slice(0,80)}))}));check(value.scrollWidth<=value.width,label,value);};
  const shot=async(name)=>page.screenshot({path:resolve(directory,name+'-'+width+'.png')});
  page.on('pageerror',error=>pageErrors.push({width,stage,message:error.message}));
  try {
   await x.pool.query('UPDATE auth_users SET profile=jsonb_set(profile,$2,to_jsonb($3::text)) WHERE id=$1',[x.id,'{name}','Ольга Владелец']);
   await x.pool.query('UPDATE auth_users SET profile=jsonb_set(profile,$2,to_jsonb($3::text)) WHERE id=$1',[x.other,'{name}',name]);
   await x.pool.query('UPDATE auth_sessions SET token_hash=$1 WHERE user_id=$2 AND token_hash=$3',[hashToken(token),x.id,hashToken(x.token)]);
   await x.pool.query('INSERT INTO auth_stars_wallet(user_id,legacy,preserved_weeks) VALUES($1,true,$2)',[x.other,[22]]);
   for(const day of ['2026-10-12','2026-10-13','2026-10-19','2026-11-11','2026-11-12'])await x.pool.query('INSERT INTO auth_gamification_visits VALUES($1,$2) ON CONFLICT DO NOTHING',[x.id,day]);
   await x.pool.query('INSERT INTO auth_gamification_visits VALUES($1,$2)',[x.other,'2026-11-12']);
   await context.addCookies([{name:COOKIE_NAME,value:token,url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
   await context.route('**/*',async route=>{
    const url=new URL(route.request().url()),headers=route.request().headers();
    if(url.origin!==origin){network.push({width,origin:url.origin});return route.abort();}
    if(url.pathname.startsWith('/api/admin/')) {
     const path=url.pathname.slice('/api/admin/'.length),body=route.request().method()==='POST'?route.request().postDataJSON():undefined;
     const sessionToken=readSessionCookie({headers}),account=headers['x-webpril-account'];
     try {
      if(sessionToken!==token)throw Object.assign(new Error('Synthetic owner session required'),{status:401});
      let data;
      if(path==='session')data={id:x.id,email:'synthetic-owner@example.invalid',role:'owner'};
      else if(path==='articles')data=[];
      else {
       const routes={gamification:'state','gamification/settings':'updateSettings','gamification/content':'saveContent','gamification/approve-content':'approveContent','gamification/approve-gate':'approveGate','gamification/resolve-legacy':'resolveLegacy','gamification/metrics':'metrics','gamification/history':'history'};
       const method=routes[path];if(!method)throw new Error('Unexpected fixture route '+path);
       if(account!==x.id)throw Object.assign(new Error('Missing account binding'),{status:409});
       data=await x.admin[method](sessionToken,account,body);
      }
      return route.fulfill({json:data});
     }catch(error){apiErrors.push({width,stage,path,code:error.code,message:error.message});return route.fulfill({status:error.status||500,json:{error:error.code||'fixture_failure',message:error.message}});}
    }
    const path=url.pathname==='/admin'||url.pathname==='/admin/'?'/admin/index.html':url.pathname;
    const file=resolve('Фронт','.'+decodeURIComponent(path));if(!file.startsWith(resolve('Фронт/admin')+'\\'))return route.abort();
    const type={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)];
    try {return route.fulfill({body:await readFile(file),contentType:type||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
   });
   stage='open';console.log('admin viewport',width);
   await page.goto(origin+'/admin');const stars=page.getByRole('button',{name:'Звёздочки',exact:true});await stars.waitFor();await stars.focus();await page.keyboard.press('Enter');
   await page.getByRole('heading',{name:'Звёздочки и «Твой день»',exact:true}).waitFor();
   check(await stars.getAttribute('aria-current')==='page','keyboard opens owner tab');await overflow('initial horizontal overflow');await shot('overview');
   const root=page.locator('#gamification'),settings=root.locator('form').first();
   stage='pilot';await settings.getByRole('combobox',{name:/^Кому доступны новые возможности/}).selectOption('selected');
   const search=settings.getByLabel('Найти ученицу по имени или email',{exact:true});await search.fill(name);await search.focus();await page.keyboard.press('Tab');
   check(await page.evaluate(()=>document.activeElement?.type==='checkbox'),'Tab reaches filtered account checkbox');await page.keyboard.press('Space');
   check(await settings.getByRole('checkbox',{name:new RegExp('^'+name)}).isChecked(),'keyboard selects pilot by name');
   check(await root.getByText('Выбрано: 1 из 1000',{exact:true}).isVisible(),'pilot count');
   await settings.getByLabel('Статья',{exact:true}).fill('12');await settings.getByLabel('Основание изменения',{exact:true}).fill('Синтетическая проверка пилота и награды');
   await settings.getByRole('button',{name:'Сохранить параметры',exact:true}).focus();await page.keyboard.press('Enter');await root.getByText('Параметры сохранены.',{exact:true}).waitFor();
   const saved=await x.settings.get(),settingsAudit=(await x.admin.history(token,x.id)).find(row=>row.action==='settings');
   check(saved.audience.mode==='selected'&&saved.audience.userIds.length===1&&saved.audience.userIds[0]===x.other,'selected audience persisted');
   check(saved.rewards.article===12,'reward setting persisted');check(settingsAudit?.actor_id===x.id&&settingsAudit?.after_value?.rewards?.article===12,'settings audit actor and exact after value');
   check(saved.medicalApproved===false&&saved.aiBudgetApproved===false,'settings do not approve medical/budget');await overflow('pilot controls horizontal overflow');await shot('pilot');
   stage='edit-question';const material=root.getByRole('combobox',{name:/^Материал/});await material.selectOption('myth-22-1');
   check(await root.getByLabel('Идентификатор материала',{exact:true}).getAttribute('readonly')!==null,'source identifier readonly');
   await root.getByLabel('Вопрос',{exact:true}).fill('Синтетический вопрос для браузерной проверки');
   await root.getByLabel('Вариант 1',{exact:true}).fill('Синтетический вариант А');await root.getByLabel('Вариант 2',{exact:true}).fill('Синтетический вариант Б');
   const answer=root.getByRole('combobox',{name:/^Правильный ответ/});
   const answerLabels=await answer.locator('option').allTextContents();check(answerLabels[0]?.includes('Синтетический вариант А')&&answerLabels[1]?.includes('Синтетический вариант Б'),'correct-answer dropdown reflects edited option text',answerLabels);await answer.focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
   check(await answer.inputValue()==='1','keyboard chooses correct answer');await overflow('question editor horizontal overflow');await answer.scrollIntoViewIfNeeded();await shot('question');
   await root.getByRole('button',{name:'Сохранить черновик',exact:true}).click();await root.getByText(/^Редакция 1\./).waitFor();
   let content=(await x.admin.state(token,x.id)).content.find(row=>row.id==='myth-22-1');
   check(content?.status==='draft'&&content.revision===1&&content.body.answer===1&&content.body.prompt==='Синтетический вопрос для браузерной проверки','question/options/answer saved');
   check(await material.inputValue()==='myth-22-1','selected question retained after save');
   stage='approve';await root.getByLabel('Основание утверждения этой редакции',{exact:true}).fill('Синтетическое подтверждение версии 1, не production');await root.getByRole('button',{name:'Утвердить редакцию',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#gamification select option:checked')!==null);
   await root.locator('select').filter({has:page.locator('option[value="myth-22-1"]')}).getByRole('option',{name:/myth-22-1.*утверждено/}).waitFor({state:'attached'});
   content=(await x.admin.state(token,x.id)).content.find(row=>row.id==='myth-22-1');check(content.status==='approved'&&content.revision===1,'exact revision approved');
   stage='approval-reset';await root.getByLabel('Вопрос',{exact:true}).fill('Синтетический вопрос после правки');await root.getByRole('combobox',{name:/^Правильный ответ/}).selectOption('0');await root.getByRole('button',{name:'Сохранить черновик',exact:true}).click();await root.getByText(/^Редакция 2\./).waitFor();
   content=(await x.admin.state(token,x.id)).content.find(row=>row.id==='myth-22-1');check(content.status==='draft'&&content.revision===2&&content.approved_by===null&&content.approved_at===null,'editing clears approval');
   check(await x.admin.publishedContent(content.id)===null,'edited draft not public');
   await root.getByLabel('Основание утверждения этой редакции',{exact:true}).fill('Синтетическое подтверждение версии 2');await root.getByRole('button',{name:'Утвердить редакцию',exact:true}).click();
   await root.locator('select').filter({has:page.locator('option[value="myth-22-1"]')}).getByRole('option',{name:/myth-22-1.*утверждено/}).waitFor({state:'attached'});
   content=(await x.admin.state(token,x.id)).content.find(row=>row.id==='myth-22-1');check(content.status==='approved'&&content.revision===2&&content.body.answer===0,'edited revision approved with new answer');
   stage='legacy';const pending=root.getByRole('combobox',{name:/^Ученица, ожидающая сверки/});await pending.selectOption(x.other);
   const prior=root.getByRole('checkbox',{name:'Неделя 22',exact:true});check(await prior.isChecked()&&await prior.isDisabled(),'prior preserved week cannot be removed');
   const week30=root.getByRole('checkbox',{name:'Неделя 30',exact:true});await week30.focus();await page.keyboard.press('Space');await root.getByRole('checkbox',{name:'Неделя 31',exact:true}).check();
   await root.getByLabel('Основание и источник проверки',{exact:true}).fill('Синтетическая сверка прежних открытий');await overflow('legacy horizontal overflow');await pending.scrollIntoViewIfNeeded();await shot('legacy');
   await root.getByRole('button',{name:'Завершить сверку аккаунта',exact:true}).click();await root.getByText('Нет аккаунтов, ожидающих сверки.',{exact:true}).waitFor();
   const legacy=(await x.pool.query('SELECT legacy,preserved_weeks FROM auth_stars_wallet WHERE user_id=$1',[x.other])).rows[0];
   check(legacy.legacy===false&&JSON.stringify(legacy.preserved_weeks)==='[22,30,31]','legacy review persists exact weeks');check((await x.admin.history(token,x.id)).some(row=>row.action==='legacy_resolved'&&row.actor_id===x.id),'legacy audit actor');
   stage='metrics';await root.getByRole('button',{name:'Обновить показатели',exact:true}).click();const expected=await x.admin.metrics(token,x.id);
   await root.getByText(new RegExp('Активных аккаунтов: '+expected.activeAccounts+'; дней с визитом: '+expected.activeDays)).waitFor();
   check(await root.getByText('D30: 1 из 1 (100%).',{exact:true}).isVisible(),'mature D30 matches seeded visits');
   check(await root.getByText('Фактическая стоимость провайдера и покупки курсов: источник пока не подключён.',{exact:true}).isVisible(),'missing business data stated');
   await overflow('metrics horizontal overflow');await root.getByRole('button',{name:'Обновить показатели',exact:true}).scrollIntoViewIfNeeded();await shot('metrics');
   stage='history';await root.getByRole('button',{name:'Открыть журнал изменений',exact:true}).click();await root.locator('details').first().waitFor();await root.locator('details summary').first().focus();await page.keyboard.press('Enter');
   check(await root.locator('details').first().getAttribute('open')!==null,'keyboard opens audit entry');await overflow('expanded audit horizontal overflow');await shot('audit');
   const history=await x.admin.history(token,x.id);check(history.filter(row=>row.action==='content_approved').length===2&&history.filter(row=>row.action==='content_saved').length===2,'two saves and exact-version approvals audited');
   results.push({width,completed:true,checks});console.log('admin completed',width,'checks',checks.length);
  }catch(error){findings.push({width,stage,label:'scenario failed',message:error.message});await shot('failure-'+stage).catch(()=>{});results.push({width,completed:false,checks});console.log('admin failure',width,stage,error.message);}
  finally{await context.close();for(const close of cleanup.reverse())await close();}
 }
 for(const error of pageErrors)findings.push({...error,label:'browser pageerror'});for(const error of apiErrors)findings.push({...error,label:'API error'});if(network.length)findings.push({label:'unexpected outside-origin requests',detail:network});
 await writeFile(resolve(directory,'result.json'),JSON.stringify({fixtureOnly:true,production:false,results,findings,pageErrors,apiErrors},null,2));
 console.log(JSON.stringify({results,findings}));if(findings.length)process.exitCode=1;
}finally{await browser.close();}
