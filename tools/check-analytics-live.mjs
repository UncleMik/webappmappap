// Published JavaScript + real HTTPS session/ingest, with a fixture DOM only.
// Run after deployment and after creating the private, pre-excluded synthetic session file.
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateAnalyticsBatch} from '../backend/auth/analytics.mjs';
const require=createRequire('C:/Users/MIK/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const {chromium}=require('playwright');
const directory=resolve('output/analytics-release');
const result={testKind:'published JavaScript and HTTPS with fixture DOM',syntheticExcludedAccount:true,realStudentPages:false,aiRequests:false,passed:false};
let browser;
try {
 const session=JSON.parse(await readFile(resolve(directory,'session.json'),'utf8'));
 if(session.origin!=='https://app.legkie-rody.ru'||typeof session.userId!=='string'||!session.cookieName||!session.cookieValue)throw new Error('invalid_session_fixture');
 const origin=session.origin, marker='DO_NOT_COLLECT_SYNTHETIC_PRIVATE_MARKER';
 const context=await (browser=await chromium.launch({headless:true,channel:'chrome'})).newContext({viewport:{width:390,height:844}});
 await context.addCookies([{name:session.cookieName,value:session.cookieValue,url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();page.setDefaultTimeout(15000);
 await page.addInitScript(() => {
  const originalFetch=window.fetch.bind(window);
  window.__analyticsReplies=[];
  window.fetch=async (...args) => {
   const response=await originalFetch(...args);
   const raw=args[0] instanceof Request?args[0].url:String(args[0]);
   const url=new URL(raw,location.href);
   if(url.origin===location.origin&&url.pathname==='/api/auth/analytics/events') {
    const reply={status:response.status};window.__analyticsReplies.push(reply);
    try {
     const data=await response.clone().json();
     if(typeof data.accepted==='number')reply.accepted=data.accepted;
     if(typeof data.excluded==='boolean')reply.excluded=data.excluded;
    }catch {reply.bodyUnavailable=true;}
   }
   return response;
  };
 });
 const posts=[],sessionStatuses=[],loadedScripts=new Set(),eventTypes=new Set(),eventActions=new Set();let blocked=0,browserErrors=0,invalidBatch=false,unauthenticatedPhase=false;
 const safeError = text => {
  let value=String(text||'');
  for(const secret of [session.userId,session.cookieName,session.cookieValue,marker])value=value.split(secret).join('[redacted]');
  return value.replace(/https?:\/\/[^\s)]+/g,url=>{try{return new URL(url).pathname;}catch{return '[url]';}})
   .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,'[uuid]').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,'[email]').slice(0,4000);
 };
 result.pageErrors=[];
 page.on('pageerror',error=>{browserErrors++;result.pageErrors.push({message:safeError(error.message),stack:safeError(error.stack)});});
 result.requestFailures=[];
 page.on('requestfailed',request=>{
  const url=new URL(request.url());
  if(url.origin===origin&&['/auth-gate.js','/analytics.js','/api/auth/session','/api/auth/analytics/events'].includes(url.pathname))result.requestFailures.push({path:url.pathname,error:safeError(request.failure()?.errorText)});
 });
 page.on('response',response=>{
  const url=new URL(response.url());
  if(url.origin!==origin)return;
  if(url.pathname==='/api/auth/session')sessionStatuses.push(response.status());
  if(['/auth-gate.js','/analytics.js'].includes(url.pathname)&&response.status()===200)loadedScripts.add(url.pathname);
  if(url.pathname==='/api/auth/analytics/events'&&response.request().method()==='POST'&&!unauthenticatedPhase) {
   const item={status:response.status(),json:null};posts.push(item);
   response.json().then(data=>{item.json={accepted:data.accepted,excluded:data.excluded,...(typeof data.error==='string'&&/^[a-z_]{1,80}$/.test(data.error)?{error:data.error}:{})};}).catch(()=>{item.bodyUnavailable=true;});
  }
 });
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===origin&&url.pathname==='/index.html'&&request.method()==='GET')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="ru"><head><meta charset="utf-8"><style id="account-lock">.app {visibility:hidden}</style><script src="/auth-gate.js" defer></script><script src="/analytics.js" defer></script></head><body><main class="app"><nav class="bottom-navigation"><a id="fixture-nav" href="journey.html?private=${marker}">Мой путь</a></nav><button id="points-trigger" type="button">Баллы</button><input aria-label="Синтетическое приватное поле" value="${marker}"></main><script>document.querySelector('#fixture-nav').addEventListener('click', event => event.preventDefault());</script></body></html>`});
  if(url.origin===origin&&!url.search&&request.method()==='GET'&&['/auth-gate.js','/analytics.js','/api/auth/session'].includes(url.pathname))return route.continue();
  if(url.origin===origin&&!url.search&&request.method()==='POST'&&url.pathname==='/api/auth/analytics/events') {
   try {
    const batch=request.postDataJSON();validateAnalyticsBatch(batch);
    if(request.headers()['x-webpril-account']!==session.userId||JSON.stringify(batch).includes(marker))throw new Error('invalid_batch');
    if(!unauthenticatedPhase) {
     result.batchValid=true;
     for(const event of batch.events) {eventTypes.add(event.type);if(event.action)eventActions.add(event.action);}
    }
   }catch {invalidBatch=true;return route.abort();}
   return route.continue();
  }
  blocked++;return route.abort();
 });
 await page.goto(origin+'/index.html');
 await page.waitForFunction(()=>window.webprilAnalyticsSession?.completed===true&&document.querySelector('#account-lock').sheet.disabled===true);
 result.realGateSession=true;
 result.gateHintMinimal=await page.evaluate(()=>{const hint=window.webprilAnalyticsSession;return !!hint&&Object.keys(hint).sort().join(',')==='completed,id'&&window.webprilAccount===undefined;});
 if(!result.gateHintMinimal)throw new Error('unexpected_gate_hint');
 await page.getByRole('link',{name:'Мой путь',exact:true}).click();
 await page.getByRole('button',{name:'Баллы',exact:true}).click();
 await new Promise(done=>setTimeout(done,31000));
 const deadline=Date.now()+20000;
 let inPageReplies=[];
 while(Date.now()<deadline) {
  inPageReplies=await page.evaluate(()=>window.__analyticsReplies||[]);
  if(inPageReplies.some(item=>item.excluded===true||item.bodyUnavailable))break;
  await new Promise(done=>setTimeout(done,100));
 }
 result.sessionStatus200=sessionStatuses.includes(200);
 result.publishedScriptsLoaded=loadedScripts.size===2;
 result.inPageReplies=inPageReplies;
 result.posts200Excluded=inPageReplies.length>0&&inPageReplies.every(item=>item.status===200&&item.accepted===0&&item.excluded===true);
 result.postResponses=posts;
 result.noInvalidBatch=!invalidBatch;
 result.screenViewCollected=eventTypes.has('page_view');
 result.transitionCollected=eventTypes.has('transition');
 result.navAndPointsCollected=eventActions.has('nav_open')&&eventActions.has('points_open');
 result.blockedOtherRequests=blocked;
 result.browserErrors=browserErrors;
 // The identity is intentionally retained only for this unauthorized HTTP check.
 // No auth-gate refresh or genuine application page is opened after cookie removal.
 await context.clearCookies();unauthenticatedPhase=true;
 const unauthorized=await page.evaluate(async id=>{
  const response=await fetch('/api/auth/analytics/events',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Webpril-Account':id},body:JSON.stringify({events:[{eventId:crypto.randomUUID(),visitId:crypto.randomUUID(),type:'page_view',page:'index.html'}]})});
  return response.status;
 },session.userId);
 result.withoutCookieStatus=unauthorized;
 result.passed=result.realGateSession&&result.gateHintMinimal&&result.sessionStatus200&&result.publishedScriptsLoaded&&result.posts200Excluded&&result.batchValid&&result.noInvalidBatch&&result.screenViewCollected&&result.transitionCollected&&result.navAndPointsCollected&&browserErrors===0&&unauthorized===401;
 await context.close();
 if(!result.passed)process.exitCode=1;
}catch {
 result.failure='Published analytics check did not pass; inspect safe result flags.';process.exitCode=1;
}finally {
 await browser?.close().catch(()=>{});
 await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'live-browser-result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}
