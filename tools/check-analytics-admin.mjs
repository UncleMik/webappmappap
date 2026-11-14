// Isolated browser routes: no listener, production API, account or real user data.
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire('C:/Users/MIK/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const {chromium}=require('playwright');
const origin='https://analytics-admin-fixture.invalid', directory=resolve('output/playwright/analytics-admin');
await mkdir(directory,{recursive:true});
const sample={generatedAt:'2026-11-14T08:00:00Z',collectionStartedAt:'2026-11-14T07:00:00Z',period:{days:30,timezone:'Europe/Moscow',from:'2026-10-16',to:'2026-11-14'},overview:{users:12,visits:18,screenViews:123,activeMs:5555000},daily:[{day:'2026-11-14',users:12,visits:18,views:123,activeMs:5555000}],screens:[{page:'today',users:12,views:123,activeMs:5555000}],content:[{type:'article',id:'synthetic-article',title:'Очень длинное название материала для проверки переноса текста на узком мобильном экране',opens:24,users:12,activeMs:5555000}],videos:[{id:'synthetic-video',type:'video',title:null,opens:15,starts:13,progress25:10,progress50:8,progress75:4,progress90:3,completed:2,users:9}],actions:[{action:'external_video_open',count:3,users:2}],transitions:[{from:'today',to:'articles',count:15,users:12}],ai:[{format:'text',outcome:'success',count:16,users:8}],errors:[{action:'network',count:1,users:1}]};
const browser=await chromium.launch({headless:true,channel:'chrome'}), results=[];
try {
 for(const width of [320,390,500,1280]) {
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
  let mode='full',role='owner',apiCalls=0,slow;
  page.setDefaultTimeout(10000);console.log('viewport',width);const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
   if(url.pathname.startsWith('/api/admin/')) {
    if(url.pathname.endsWith('/session'))return route.fulfill({json:{id:'synthetic-owner',email:'synthetic@example.invalid',role}});
    if(url.pathname.endsWith('/analytics')){
     apiCalls++;assert.equal(route.request().headers()['x-webpril-account'],'synthetic-owner');
     const selected=Number(url.searchParams.get('days'));assert.ok([7,30,90].includes(selected));
     if(mode==='error')return route.fulfill({status:500,json:{message:'RAW_PRIVATE_DIAGNOSTIC'}});
     const data=structuredClone(sample);data.period.days=selected;
     if(mode==='empty')data.overview={users:0,visits:0,screenViews:0,activeMs:0};
     if(mode==='race'&&selected===7)await new Promise(done=>{slow=done;});
     data.period.from=selected===90?'2026-08-17':selected===7?'2026-11-08':'2026-10-16';
     return route.fulfill({json:data});
    }
    return route.fulfill({json:[]});
   }
   const path=url.pathname==='/admin'?'/admin/index.html':url.pathname;
   const file=resolve('Фронт','.'+path);assert.ok(file.startsWith(resolve('Фронт/admin')));
   return route.fulfill({body:await readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]});
  });
  await page.goto(origin+'/admin');const tab=page.getByRole('button',{name:'Аналитика',exact:true});await tab.waitFor();await tab.focus();await page.keyboard.press('Enter');
  const root=page.locator('#analytics');await root.getByRole('heading',{name:'Активность',exact:true}).waitFor();
  assert.equal(await tab.getAttribute('aria-current'),'page');assert.ok(await root.getByText('12', {exact:true}).isVisible());
  assert.ok(await root.getByText('Видео · synthetic-video',{exact:true}).isVisible());assert.ok(await root.getByText(/Сбор начат/).isVisible());
  const overflow=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert.equal(overflow.scroll,overflow.width);
  await page.screenshot({path:resolve(directory,`overview-${width}.png`),fullPage:true});
  const filter=root.getByLabel('Период',{exact:true});await filter.selectOption('90');await root.getByText('2026-08-17 — 2026-11-14 · по Москве',{exact:true}).waitFor();
  console.log('race',width);mode='race';await filter.selectOption('7');await page.waitForFunction(()=>document.querySelector('#analytics').getAttribute('aria-busy')==='true');await filter.selectOption('30');await root.getByText('2026-10-16 — 2026-11-14 · по Москве',{exact:true}).waitFor();slow();await page.waitForTimeout(80);assert.ok(await root.getByText('2026-10-16 — 2026-11-14 · по Москве',{exact:true}).isVisible());
  mode='empty';await root.getByRole('button',{name:'Обновить',exact:true}).click();await root.getByText('Данные появятся после посещений.',{exact:true}).waitFor();assert.equal(await root.getByRole('heading',{name:'Активность',exact:true}).count(),0);
  mode='error';await root.getByRole('button',{name:'Обновить',exact:true}).click();await root.getByText(/Не удалось загрузить отчёт/).waitFor();assert.ok(!(await root.textContent()).includes('RAW_PRIVATE_DIAGNOSTIC'));
  mode='full';await root.getByRole('button',{name:'Обновить',exact:true}).click();await root.getByRole('heading',{name:'Активность',exact:true}).waitFor();
  role='editor';await page.evaluate(()=>dispatchEvent(new Event('pageshow')));await tab.waitFor({state:'hidden'});assert.equal(await root.textContent(),'');
  const before=apiCalls;await page.locator('[data-tab=analytics]').evaluate(button=>button.click());assert.equal(apiCalls,before);
  role='owner';await page.evaluate(()=>dispatchEvent(new Event('pageshow')));await tab.waitFor({state:'visible'});await tab.click();await root.getByRole('heading',{name:'Активность',exact:true}).waitFor();
  await page.getByRole('button',{name:'Статьи',exact:true}).click();assert.equal(await root.textContent(),'');
  assert.deepEqual(pageErrors,[]);results.push({width,overflow,checks:['keyboard','full','periods','latest response','empty','safe error','retry','role revoked clears','editor cannot request','tab leave clears'],fixtureOnly:true});await context.close();
 }
 await writeFile(resolve(directory,'result.json'),JSON.stringify({results},null,2));console.log(JSON.stringify(results));
} finally {await browser.close();}
