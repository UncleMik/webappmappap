import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
test('article index uses account header and late prior-account response cannot replace new corpus',async()=>{
 const source=await readFile('Фронт/articles-api.js','utf8'),listeners=new Map();let resolveOld,hold=true;
 const window={webprilSessionAccountId:'account-a',addEventListener:(name,fn)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);}};
 const fetch=async(url,options)=>{const account=options.headers['X-Webpril-Account'];assert.ok(account);if(hold&&account==='account-a')return new Promise(resolve=>{resolveOld=()=>resolve({ok:true,json:async()=>({articles:[{id:'a-secret',week:40,title:'A only'}]})});});return {ok:true,json:async()=>({articles:[{id:'b-allowed',week:10,title:'B allowed'}]})};};
 const context={window,document:{querySelector:()=>null},location:{hostname:'app.legkie-rody.ru',search:''},URL,URLSearchParams,AbortSignal,fetch,console};vm.runInNewContext(source,context);
 while(!resolveOld)await new Promise(resolve=>setTimeout(resolve,0));
 hold=false;window.webprilSessionAccountId='account-b';for(const listener of listeners.get('account:change')||[])listener();await window.articlesReady;
 resolveOld();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(window.pregnancyArticleList[0].id,'b-allowed');assert.equal(window.articleLibrary['a-secret'],undefined);
 for(const listener of listeners.get('webpril:session-ended')||[])listener();assert.equal(window.pregnancyArticleList.length,0);assert.equal(Object.keys(window.articleLibrary).length,0);
});
