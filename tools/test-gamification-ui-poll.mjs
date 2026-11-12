import {createRequire} from 'node:module';import {readFile,writeFile} from 'node:fs/promises';import {resolve,extname} from 'node:path';import assert from 'node:assert/strict';
import {createUiFixture} from './test-gamification-ui-fixtures.mjs';import {createWeeklyPoll} from '../backend/auth/weekly-poll.mjs';
const require=createRequire('C:/Users/MIK/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');const {chromium}=require('playwright'),origin='https://webpril-poll-fixture.invalid';
const fixture=await createUiFixture(),polls=createWeeklyPoll(fixture.pool,{stars:fixture.stars}),browser=await chromium.launch({headless:true,channel:'chrome'}),results=[],errors=[];
try{
 await fixture.pool.query('INSERT INTO weekly_polls(id,question,options,opens_at,closes_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',['fixture-poll','Синтетическое голосование',['А','Б'],new Date(Date.now()-3600000),new Date(Date.now()+86400000)]);
 for(const width of [320,390,500])for(const name of ['index','club']){
  fixture.config.audience={mode:'all',userIds:[]};
  const current=await fixture.account(width),context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));fixture.config.audience={mode:'all',userIds:[]};
  await fixture.pool.query('UPDATE auth_users SET created_at=$2 WHERE id=$1',[current.id,new Date(fixture.clock())]);
  const requests=[];await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
   if(url.pathname==='/api/auth/weekly-poll'){requests.push(route.request().headers()['x-webpril-account']);return route.fulfill({json:await polls.read(current.id)});}
   if(url.pathname==='/'+name+'.html'){let html=await readFile('Фронт/'+name+'.html','utf8');html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('<style id="account-lock">html { visibility: hidden !important; }</style>','');html=html.replace('</body>',`<script>window.webprilSessionAccountId=${JSON.stringify(current.id)};const events=document.querySelector('[data-category=events]');if(events)events.hidden=false;</script><script src="weekly-poll.js?v=20261112-stars"></script></body>`);return route.fulfill({contentType:'text/html',body:html});}
   const file=resolve('Фронт','.'+decodeURIComponent(url.pathname)),type={'.js':'text/javascript','.css':'text/css','.woff':'font/woff','.webp':'image/webp'}[extname(file)];try{return route.fulfill({body:await readFile(file),contentType:type||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
  });
  const initialResponse=page.waitForResponse(response=>response.url().endsWith('/api/auth/weekly-poll'));await page.goto(origin+'/'+name+'.html');await initialResponse;
  const selector=name==='index'?'#weekly-poll-card':'#weekly-poll';const response=await polls.read(current.id);assert.equal(response.available,false);assert.equal(response.poll,null);
  assert.equal(await page.locator(selector).evaluate(node=>node.hidden),true,'pilot day0 hidden');
  await fixture.pool.query('UPDATE auth_users SET created_at=$2 WHERE id=$1',[current.id,new Date(fixture.clock()-2*86400000)]);
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.locator(selector+':not([hidden])').waitFor();assert.equal((await polls.read(current.id)).available,true,'day2 opens');
  assert.ok(requests.every(account=>account===current.id),'poll read uses current account binding');
  fixture.config.audience={mode:'selected',userIds:[]};await fixture.pool.query('UPDATE auth_users SET created_at=$2 WHERE id=$1',[current.id,new Date(fixture.clock())]);
  await page.reload();await page.locator(selector+':not([hidden])').waitFor();assert.equal((await polls.read(current.id)).available,true,'nonpilot original flow preserved');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(()=>window.dispatchEvent(new Event('webpril:session-ended')));assert.equal(await page.locator(selector).evaluate(node=>node.hidden),true);
  results.push({width,page:name,pilotDay0Hidden:true,day2Available:true,nonPilotPreserved:true,sessionReset:true});await context.close();
 }
 assert.deepEqual(errors,[]);await writeFile('output/playwright/gamification/poll-result.json',JSON.stringify({fixtureOnly:true,results,errors},null,2));console.log(JSON.stringify({results,errors}));
}finally{await browser.close();await fixture.db.close();}
