import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';import {readFile,writeFile} from 'node:fs/promises';import {resolve,extname} from 'node:path';import assert from 'node:assert/strict';
const require=createRequire('C:/Users/MIK/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');const {chromium}=require('playwright');const origin='https://webpril-fixture.invalid',id='week-video-126',account='11111111-1111-4111-8111-111111111111';
try {await readFile('output/playwright/gamification/synthetic-video.mp4');} catch {const result=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=0xEEE5FC:s=320x180:r=10:d=2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-an','-y','output/playwright/gamification/synthetic-video.mp4'],{cwd:process.cwd(),encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr || 'ffmpeg unavailable');}
const browser=await chromium.launch({headless:true,channel:'chrome'}),results=[];
try {for(const width of [320,390,500]){
 const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage(),requests=[],errors=[];let sourceAccount=account;
 page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();const path=url.pathname;
  if(path==='/api/auth/session')return route.fulfill({json:{authenticated:true,user:{id:account,email:'test@example.invalid',profile:{completedAt:'yes'}}}});
  if(path==='/api/auth/videos/'+id)return route.fulfill({json:{source:`/api/auth/videos/${id}/file?account=${sourceAccount}`,cover:`/api/auth/videos/${id}/cover?account=${sourceAccount}`}});
  if(path==='/api/auth/videos/'+id+'/file'){
   requests.push({kind:'file',account:url.searchParams.get('account')});assert.equal(url.searchParams.get('account'),account);
   return route.fulfill({contentType:'video/mp4',body:await readFile('output/playwright/gamification/synthetic-video.mp4')});
  }
  if(path.startsWith('/api/auth/videos/')&&path.endsWith('/cover')){
   requests.push({kind:'cover',account:url.searchParams.get('account')});assert.equal(url.searchParams.get('account'),account);
   return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#eee5fc"/></svg>'});
  }
  if(path==='/api/auth/points/videos'){
   const body=route.request().postDataJSON();requests.push({kind:'tracking',body});return route.fulfill({json:body.attemptId?{status:'earned',amount:20}:{status:'watching',attemptId:'22222222-2222-4222-8222-222222222222',availableAmount:20}});
  }
  if(path==='/video.html'){
   let html=await readFile('Фронт/video.html','utf8');html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('<style id="account-lock">html { visibility: hidden !important; }</style>','');
   html=html.replace('</body>',`<script>window.webprilSessionAccountId='${account}';</script><script src="weekly-videos.js?v=20261112-stars"></script><script type="module">import {mountWeeklyVideo} from './weekly-video-player.js?v=20261112-stars';mountWeeklyVideo('${id}');document.querySelector('.video-app').removeAttribute('data-video-pending');</script></body>`);return route.fulfill({contentType:'text/html',body:html});
  }
  const file=resolve('Фронт','.'+decodeURIComponent(path)),types={'.js':'text/javascript','.css':'text/css','.woff':'font/woff','.webp':'image/webp'};try{return route.fulfill({body:await readFile(file),contentType:types[extname(file)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto(origin+'/video.html?id='+id);await page.locator('.video-cover:not([disabled])').waitFor();await page.locator('.video-cover').click();
 await page.waitForFunction(()=>document.querySelector('#weekly-video')?.ended);assert.ok(requests.some(item=>item.kind==='file'));
 await page.getByText('+20 ★ за просмотр.',{exact:true}).waitFor();
 assert.ok(requests.some(item=>item.kind==='tracking'&&item.body.ranges?.some(([a,b])=>b>a)),'real played intervals submitted');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:resolve('output/playwright/gamification/native-video-'+width+'.png')});
 await page.evaluate(()=>{window.webprilSessionAccountId='33333333-3333-4333-8333-333333333333';window.dispatchEvent(new CustomEvent('account:change'));});
 assert.equal(await page.locator('#weekly-video').getAttribute('src'),null);assert.equal(await page.locator('#weekly-video').getAttribute('poster'),null);assert.equal(await page.locator('.video-cover img').getAttribute('src'),null);
 assert.deepEqual(errors,[]);results.push({width,accountBoundMedia:true,realPlayback:true,realPlayedRanges:true,accountReset:true});await context.close();
}await writeFile('output/playwright/gamification/native-result.json',JSON.stringify({fixtureOnly:true,results},null,2));console.log(JSON.stringify(results));}finally{await browser.close();}
