import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesUrgent, createAiUrgent, urgentContinuation, validUrgentContinuation } from '../auth/ai-urgent.mjs';
const paragraphs=JSON.parse(readFileSync(new URL('../content/gamification-source.json',import.meta.url))).urgent_help_source;
test('all source warning groups match stems case and ё; exceptions do not silence another symptom',()=>{
  for(const text of ['КРОВОТЕЧЕНИЕ','Очень болит живот','Малыш не шевелится','ЛЬЁТСЯ ВОДА','давление 150','упала на живот']) assert.equal(matchesUrgent(text,paragraphs),true,text);
  for(const text of ['нет крови','без крови','не болит','анализ крови','группа крови','сахар в крови','Кровотечение было на прошлой неделе.']) assert.equal(matchesUrgent(text,paragraphs),false,text);
  for(const text of ['Анализ крови. Очень болит живот','Нет крови, но отошли воды','Кровотечение было на прошлой неделе. Сейчас мало шевелится']) assert.equal(matchesUrgent(text,paragraphs),true,text);
  for(const tag of ['Кровь','Сильная боль','Малыш затих','Подтекание']) assert.equal(matchesUrgent('',paragraphs,[tag]),true);
});
test('urgent screen requires global medical approval and approved item; draft edits revoke immediately',async()=>{
  let config={enabled:true,medicalApproved:true}, row={id:'urgent-help',revision:2,body:{paragraphs},medical:true,approved_by:'owner',approved_at:new Date(),evidence:'doctor',status:'approved'};
  const urgent=createAiUrgent({settings:{get:async()=>config},pool:{query:async()=>({rows:row?.status==='approved'?[row]:[]})}});
  const screen=await urgent.evaluate({text:'кровит'});assert.equal(screen.title,'Это может быть срочно');assert.equal(screen.free,true);assert.equal(screen.body,paragraphs.find(p=>p.paragraph===2587).text);
  config.medicalApproved=false;assert.equal(await urgent.evaluate({text:'кровит'}),null);config.medicalApproved=true;
  row.status='draft';assert.equal(await urgent.evaluate({text:'кровит'}),null);row.status='approved';row.evidence=null;assert.equal(await urgent.evaluate({text:'кровит'}),null);
});
test('continue token is bound to one message/account/file/revision and expires',()=>{
  const now=Date.now(),context={account:'one',requestId:'request',hash:'message+file',revision:1,conversationId:'chat'},expires=now+600000;
  const token={expires,signature:urgentContinuation('secret',{...context,expires})};
  assert.equal(validUrgentContinuation('secret',context,token,new Date(now)),true);
  for(const patch of [{account:'other'},{requestId:'new'},{hash:'different'},{revision:2},{conversationId:'other'}]) assert.equal(validUrgentContinuation('secret',{...context,...patch},token,now),false);
  assert.equal(validUrgentContinuation('secret',context,token,expires),false);assert.equal(validUrgentContinuation('secret',context,true,now),false);
});

test('urgent medical approval does not enable screen for accounts outside selected pilot',async()=>{
  const userId='11111111-1111-4111-8111-111111111111',config={enabled:true,medicalApproved:true,audience:{mode:'selected',userIds:[userId]}};
  let lookups=0;
  const urgent=createAiUrgent({settings:{get:async()=>config},pool:{query:async()=>{lookups++;return {rows:[{id:'urgent-help',revision:1,body:{paragraphs},medical:true,approved_by:'owner',approved_at:new Date(),evidence:'doctor'}]};}}});
  assert.equal(await urgent.evaluate({text:'кровит',userId:'other'}),null);assert.equal(lookups,0);
  assert.equal((await urgent.evaluate({text:'кровит',userId})).contentId,'urgent-help');assert.equal(lookups,1);
});
