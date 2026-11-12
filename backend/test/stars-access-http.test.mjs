import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createAuthServer } from '../auth/http.mjs';
import { createArticleServer } from '../server.mjs';
import { openDatabase } from '../database.mjs';
import { createStarsAccess } from '../auth/stars-access.mjs';
import { AuthError } from '../auth/security.mjs';
const account='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const policy={accountId:account,currentWeek:1,enforced:true,legacy:false,purchasedWeeks:[],preservedWeeks:[]};
// Invoke the real request listener with in-memory streams: no socket or HTTP connection.
function invoke(server,url,{method='GET',headers={},peer='127.0.0.1',body}={}){
  return new Promise((resolve,reject)=>{
    const request=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(request,{method,url,headers,complete:true,socket:{remoteAddress:peer}});
    const response=new EventEmitter();Object.assign(response,{destroyed:false,setHeader(){},writeHead(status,h){this.status=status;this.headers=h;},end(body){resolve({status:this.status,headers:this.headers,body:body?JSON.parse(body):undefined});}});
    try{server.emit('request',request,response);}catch(e){reject(e);}
  });
}
function auth({enabled=true,signedIn=true,gate=true}={}){
  const starsAccess=createStarsAccess({contextProvider:async(token,expected)=>{
    if(!signedIn)throw new AuthError(401,'sign_in_required','Войдите');
    if(expected!==account)throw new AuthError(409,'account_changed','Аккаунт изменился');return policy;
  }});
  return createAuthServer({enabled,origin:'https://app.legkie-rody.ru',service:{session:async()=>signedIn?{id:account,profile:{completedAt:'yes'}}:null},
    starsAccess:gate?starsAccess:undefined,weeklyMedia:async(_request,response,position,asset)=>{response.writeHead(200,{});response.end(JSON.stringify({position,asset}));}});
}
test('native file and cover GET/HEAD bind account query to session and apply the same week gate',async()=>{
  const server=auth();
  const source=await invoke(server,'/api/auth/videos/contractions-lesson',{headers:{'x-webpril-account':account}});
  assert.equal(source.status,200);assert.equal(source.body.source,'/api/auth/videos/contractions-lesson/file?account='+account);assert.equal(source.body.cover,'/api/auth/videos/contractions-lesson/cover?account='+account);
  for(const method of ['GET','HEAD'])for(const asset of ['file','cover']){
    assert.equal((await invoke(server,`/api/auth/videos/contractions-lesson/${asset}?account=${account}`,{method})).status,200);
    assert.equal((await invoke(server,`/api/auth/videos/contractions-lesson/${asset}?account=${other}`,{method})).status,409);
    assert.equal((await invoke(server,`/api/auth/videos/week-video-004/${asset}?account=${account}`,{method})).body.error,'week_locked');
    assert.equal((await invoke(server,`/api/auth/videos/contractions-lesson/${asset}`,{method})).status,409);
  }
  assert.equal((await invoke(auth({signedIn:false}),source.body.source)).status,401);
  assert.equal((await invoke(server,source.body.source+'&extra=1')).status,400);
});
test('local auth policy has no wallet data; disabled new runtime retains session gate and open legacy access',async()=>{
  const headers={'x-webpril-account':account};
  const result=await invoke(auth({gate:false}),'/api/auth/internal/weekly-access',{headers});
  assert.deepEqual(result.body,{accountId:account,currentWeek:0,legacy:true,enforced:false,purchasedWeeks:[],preservedWeeks:[]});
  assert.equal((await invoke(auth(),'/api/auth/internal/weekly-access',{headers,peer:'192.0.2.1'})).status,403);
  assert.equal((await invoke(auth({signedIn:false,gate:false}),'/api/auth/internal/weekly-access',{headers})).status,401);
  assert.equal((await invoke(auth({enabled:false}),'/api/auth/internal/weekly-access',{headers})).status,503);
});
test('article list, direct links, bulk weeks and HEAD use identical access policy, calendar survives',async()=>{
  const db=openDatabase(':memory:',false);
  try{
    for(const week of [1,2]){
      db.prepare("INSERT INTO articles(id,number,week,title,minutes,blocks) VALUES(?,?,?,?,?,?)").run(`pregnancy-00${week}`,week,week,'Article',2,'[]');
      for(const kind of ['mom','baby','calendar'])db.prepare('INSERT INTO weekly_content(kind,week,data) VALUES(?,?,?)').run(kind,week,JSON.stringify({title:`${kind}${week}`}));
    }
    let fail=false;
    const gate=createStarsAccess({contextProvider:async()=>{if(fail)throw new AuthError(503,'weekly_access_unavailable','Closed');return policy;}});
    const server=createArticleServer(db,undefined,{starsAccess:gate});
    assert.equal((await invoke(server,'/api/articles')).body.articles.length,1);
    assert.equal((await invoke(server,'/api/articles?week=2')).body.articles.length,0);
    for(const method of ['GET','HEAD'])assert.equal((await invoke(server,'/api/articles/pregnancy-002',{method})).status,403);
    const bulk=await invoke(server,'/api/weekly-content');assert.deepEqual(Object.keys(bulk.body.mom),['1']);assert.deepEqual(Object.keys(bulk.body.baby),['1']);assert.deepEqual(Object.keys(bulk.body.calendar),['1','2']);assert.equal(bulk.headers['Cache-Control'],'private, no-store');assert.equal(bulk.headers['Access-Control-Allow-Origin'],'https://app.legkie-rody.ru');
    fail=true;assert.equal((await invoke(server,'/api/weekly-content')).status,503);assert.equal((await invoke(server,'/api/articles')).status,503);
  }finally{db.close();}
});

test('new mutation routes preserve origin/account gates and course-video dispatch uses the real wallet method',async()=>{
  const calls=[],module={};for(const method of ['purchase','courseVideoWatching','action','preferences','read','subscribe','unsubscribe','visit','claimPresentation']) module[method]=async(token,expected,body)=>{calls.push([method,token,expected,body]);return {accountId:expected};};
  let signedIn=true;
  const server=createAuthServer({enabled:true,origin:'https://app.legkie-rody.ru',service:{session:async()=>signedIn?{id:account}:null},store:{rateLimit:async()=>{}},stars:module,gamification:module,gamificationNotifications:module});
  const routes=[['stars/purchase','purchase'],['stars/course-video','courseVideoWatching'],['gamification/actions','action'],['gamification/preferences','preferences'],['notifications/read','read'],['notifications/preferences','preferences'],['notifications/subscribe','subscribe'],['notifications/unsubscribe','unsubscribe'],['notifications/visit','visit'],['notifications/presentation','claimPresentation']];
  const headers={'content-type':'application/json',origin:'https://app.legkie-rody.ru','x-webpril-account':account};
  for(const [path,method] of routes){
    const body={requestId:'synthetic'};
    assert.equal((await invoke(server,'/api/auth/'+path,{method:'POST',headers,body})).status,200);
    assert.equal(calls.at(-1)[0],method);assert.deepEqual(calls.at(-1)[3],body);
    const before=calls.length;
    assert.equal((await invoke(server,'/api/auth/'+path,{method:'POST',headers:{...headers,'x-webpril-account':other},body})).status,409);
    assert.equal((await invoke(server,'/api/auth/'+path,{method:'POST',headers:{...headers,origin:'https://external.invalid'},body})).status,403);
    assert.equal(calls.length,before);
  }
  signedIn=false;
  assert.equal((await invoke(server,'/api/auth/stars/course-video',{method:'POST',headers,body:{}})).status,401);
});
