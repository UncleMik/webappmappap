// Actual AI screen/scripts, synthetic intercepted responses only. No provider/model calls or listener.
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {validateAnalyticsBatch} from '../backend/auth/analytics.mjs';
const require=createRequire('C:/Users/MIK/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
const origin='https://app.legkie-rody.ru',accountId='11111111-1111-4111-8111-111111111111';
const events=[],errors=[];let mode='normal',posts=0;
const quota={limit:30,remaining:30};
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
 const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
 const path=url.pathname;
 if(path==='/api/auth/analytics/events'){
  const batch=route.request().postDataJSON();validateAnalyticsBatch(batch);events.push(...batch.events);return route.fulfill({json:{accepted:batch.events.length}});
 }
 if(path==='/api/auth/session')return route.fulfill({json:{authenticated:true,user:{id:accountId,email:'synthetic@example.invalid',profile:{completedAt:'fixture'}}}});
 if(path==='/api/articles')return route.fulfill({json:{articles:[{id:'trusted-article',week:27,number:1,title:'Синтетическая статья'}]}});
 if(path==='/api/articles/trusted-article')return route.fulfill({json:{id:'trusted-article',week:27,number:1,title:'Синтетическая статья',minutes:1,blocks:Array.from({length:20},()=>({type:'paragraph',text:'Синтетический абзац для проверки чтения. '.repeat(10)}))}});
 if(path==='/api/auth/personal')return route.fulfill({json:{accountId,weights:[],pressure:[],wellbeing:[],movements:[],readArticles:[],favorites:[],baby:{}}});
 if(path==='/api/auth/points/articles')return route.fulfill({json:{status:'already_earned'}});
 if(path==='/api/auth/ai/conversations'){
  if(route.request().method()==='GET')return route.fulfill({json:{accountId,conversations:[],hasMore:false,nextBefore:null}});
  const body=route.request().postDataJSON();return route.fulfill({json:{accountId,conversation:{id:body.conversationId,title:'Тест',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}});
 }
 if(path==='/api/auth/ai/quota')return route.fulfill({json:{accountId,quota}});
 if(path==='/api/auth/ai/messages'){
  posts++;const body=route.request().postDataJSON();
  if(mode==='limit')return route.fulfill({status:429,json:{error:'ai_daily_limit',quota:{...quota,remaining:0}}});
  return route.fulfill({json:{accountId,conversationId:body.conversationId,requestId:body.requestId,status:'completed',quota,messages:[
   {id:posts+':user',role:'user',requestId:body.requestId,status:'completed',content:body.text,createdAt:new Date().toISOString()},
   {id:posts+':answer',role:'assistant',requestId:body.requestId,content:'Синтетический ответ '+posts,createdAt:new Date().toISOString()},
  ]}});
 }
 if(path.startsWith('/api/'))throw new Error('Unexpected fixture API: '+path);
 if(['/app-navigation.js','/resource-prefetch.js','/gamification.js'].includes(path))return route.fulfill({contentType:'text/javascript',body:''});
 const file=resolve('Фронт','.'+path);assert.ok(file.startsWith(resolve('Фронт')));
 return route.fulfill({body:await readFile(file),contentType:{'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'}[extname(file)]});
});
try{
 await page.goto(origin+'/ai.html');
 await page.evaluate(()=>{document.querySelector('.app').dataset.initialSection='ai.html';});
 await page.addScriptTag({url:origin+'/analytics.js'});
 await page.waitForFunction(()=>!document.querySelector('#chat-input').disabled);
 await page.locator('#chat-input').fill('PRIVATE_SENTINEL question');await page.locator('.send-button').click();
 await page.getByText('Синтетический ответ 1',{exact:true}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('#chat-input').disabled);
 await page.locator('#analysis-file').setInputFiles({name:'PRIVATE_SENTINEL.pdf',mimeType:'application/pdf',buffer:Buffer.from('synthetic fixture, never submitted to a provider')});
 await page.locator('.send-button').click();await page.getByText('Синтетический ответ 2',{exact:true}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('#chat-input').disabled);
 mode='limit';await page.locator('#chat-input').fill('PRIVATE_SENTINEL limit');await page.locator('.send-button').click();
 await page.waitForFunction(()=>document.querySelector('#chat-status').textContent.includes('На сегодня использованы'));
 const flushed=page.waitForRequest(origin+'/api/auth/analytics/events');
 await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));await flushed;
 await page.waitForTimeout(100);
 assert.equal(posts,3);
 assert.deepEqual(events.filter(e=>e.type==='ai_request').map(e=>[e.format,e.outcome]),[['text','accepted'],['file','accepted']]);
 assert.deepEqual(events.filter(e=>e.type==='ai_result').map(e=>[e.format,e.outcome]),[['text','completed'],['file','completed'],['text','limit']]);
 assert.equal(events.filter(e=>e.type==='error'&&e.action==='ai_limit').length,1);
 assert.ok(!JSON.stringify(events).includes('PRIVATE_SENTINEL'));
 assert.deepEqual(errors,[]);
 const reader=await context.newPage();reader.on('pageerror',error=>errors.push(error.message));
 await reader.clock.install({time:new Date('2026-11-14T00:00:00Z')});await reader.clock.pauseAt(new Date('2026-11-14T00:00:01Z'));
 await reader.goto(origin+'/article.html?id=trusted-article');await reader.getByRole('heading',{name:'Синтетическая статья',exact:true}).waitFor();
 assert.equal(await reader.evaluate(()=>window.webprilAccount),undefined,'standalone article has no account-profile bootstrap');
 await reader.waitForFunction(()=>!!window.webprilAnalytics&&window.webprilAnalyticsSession?.completed);
 await reader.evaluate(()=>{const scroller=document.querySelector('.reader-scroll');scroller.scrollTop=scroller.scrollHeight;scroller.dispatchEvent(new Event('scroll'));});
 await reader.clock.runFor(15000);
 const articleFlushed=reader.waitForRequest(origin+'/api/auth/analytics/events');await reader.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));await articleFlushed;await reader.waitForTimeout(1).catch(()=>{});
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.ok(events.some(event=>event.type==='content_open'&&event.resourceId==='trusted-article'));
 assert.ok(events.some(event=>event.type==='article_progress'&&event.resourceId==='trusted-article'&&event.progress===100));
 assert.deepEqual(errors,[]);
 console.log('PASS actual AI UI: text/file acceptance + completion, limit/privacy; real standalone article gate-only session + reading; zero model calls');
}finally{await browser.close();}
