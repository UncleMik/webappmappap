import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createAdmin} from '../auth/admin.mjs';
import {fixture} from './gamification-admin-fixture.mjs';
import {validateSettingsPatch,mergeSettings,forGamificationUser} from '../auth/gamification-settings.mjs';
import {retentionMetrics} from '../auth/gamification-admin.mjs';
import {loadGamificationCatalog} from '../auth/gamification-content.mjs';

test('settings reject unsupported SQL/ledger bounds and do not implicitly approve gates',()=>{
 for(const patch of [{ai:{freeDaily:31}},{ai:{coursePaidDaily:11}},{ai:{coursePurchases:2}},{prices:{peekNextWeek:32768}},{medicalApproved:true},{features:{surprise:true}},{rewards:{article:-1}}])assert.throws(()=>validateSettingsPatch(patch));
 assert.equal(mergeSettings({ai:{courseDaily:30}}).ai.courseDaily,30);assert.equal(mergeSettings().enabled,false);assert.ok(Object.values(mergeSettings().features).every(x=>!x));
});
test('exact return excludes immature cohorts and counts exact observation day',()=>{
 const v=(user_id,moscow_day)=>({user_id,moscow_day});const r=retentionMetrics([v('a','2026-10-01'),v('a','2026-10-02'),v('a','2026-10-08'),v('a','2026-10-31'),v('b','2026-11-11'),v('b','2026-11-12'),v('c','2026-11-12')],'2026-11-12');
 assert.deepEqual(r.D30,{eligible:1,returned:1,rate:1,insufficientData:false});assert.equal(r.D1.eligible,2);assert.equal(r.D1.returned,2);assert.equal(r.D7.returned,1);assert.equal(retentionMetrics([], '2026-11-12').D1.insufficientData,true);
});
test('owner only, source drafts, optimistic revision, medical gate evidence and immediate draft suppression',async t=>{
 const x=await fixture(t);x.setRole('editor');await assert.rejects(x.admin.state(x.token,x.id),e=>e.code==='admin_forbidden');await assert.rejects(x.admin.updateSettings(x.token,x.id,{patch:{enabled:true},reason:'test'}),e=>e.code==='admin_forbidden');x.setRole('owner');await assert.rejects(x.admin.state(x.token,x.other),e=>e.code==='account_changed');
 const state=await x.admin.state(x.token,x.id);assert.equal(state.accounts.length,2);assert.ok(state.accounts.every(account=>account.email && account.id && Object.hasOwn(account,'name')));assert.equal(state.content.filter(x=>x.kind==='letters').length,42);assert.equal(state.content.filter(x=>x.kind==='questions').length,126);
 const source=state.content.find(x=>x.id==='myth-22-1');assert.equal(source.status,'draft');
 await assert.rejects(x.admin.saveContent(x.token,x.id,{...source,medical:false}),e=>e.code==='invalid_gamification_content');
 const row=await x.admin.saveContent(x.token,x.id,source);assert.equal(row.revision,1);await assert.rejects(x.admin.approveContent(x.token,x.id,{id:row.id,revision:1,evidence:''}));
 await x.admin.approveContent(x.token,x.id,{id:row.id,revision:1,evidence:'Проверено врачом, протокол 12.11'});assert.equal(await x.admin.publishedContent(row.id),null);
 await x.admin.approveGate(x.token,x.id,{gate:'medical',approved:true,evidence:'Врач утвердил пакет'});assert.ok(await x.admin.publishedContent(row.id));
 const catalog=loadGamificationCatalog({pool:x.pool});assert.equal((await catalog()).questions.find(x=>x.id===row.id).status,'published');
 await x.enqueue('medical','feature',{medical:true,contentId:row.id});
 const edited=await x.admin.saveContent(x.token,x.id,{id:row.id,kind:row.kind,body:row.body,medical:true,revision:1});assert.equal(edited.status,'draft');assert.equal(await x.admin.publishedContent(row.id),null);
 assert.equal((await catalog()).questions.find(x=>x.id===row.id).status,'unpublished');assert.equal((await x.notices.list(x.token,x.id)).items.length,0);
 assert.equal((await x.pool.query('SELECT push_state FROM gamification_notifications')).rows[0].push_state,'suppressed');
 await assert.rejects(x.admin.saveContent(x.token,x.id,{...row,revision:1}),e=>e.code==='content_changed');assert.ok((await x.admin.history(x.token,x.id)).length>=4);
});
test('legacy resolution preserves explicit rights, audits and cannot remove prior preserved rights',async t=>{
 const x=await fixture(t);await x.pool.query('INSERT INTO auth_stars_wallet(user_id,legacy) VALUES($1,true)',[x.other]);
 await assert.rejects(x.admin.resolveLegacy(x.token,x.id,{userId:'bad',preservedWeeks:[1],evidence:'test'}));
 const result=await x.admin.resolveLegacy(x.token,x.id,{userId:x.other,preservedWeeks:[30,22,30],evidence:'Проверены прежние открытия'});assert.deepEqual(result.preservedWeeks,[22,30]);
 const row=(await x.pool.query('SELECT * FROM auth_stars_wallet WHERE user_id=$1',[x.other])).rows[0];assert.equal(row.legacy,false);assert.deepEqual(row.preserved_weeks,[22,30]);
 await assert.rejects(x.admin.resolveLegacy(x.token,x.id,{userId:x.other,preservedWeeks:[22],evidence:'test'}));assert.equal((await x.admin.history(x.token,x.id))[0].action,'legacy_resolved');
});
test('owner aggregates visits idempotently and reports absent business sources explicitly',async t=>{
 const x=await fixture(t);await x.notices.visit(x.token,x.id);await x.notices.visit(x.token,x.id);let m=await x.admin.metrics(x.token,x.id);assert.equal(m.activeDays,1);assert.equal(m.activeAccounts,1);assert.equal(m.retention.D7.insufficientData,true);assert.equal(m.coursePurchases,null);assert.equal(m.providerActualCost,null);
 x.setRole('editor');await assert.rejects(x.admin.metrics(x.token,x.id),e=>e.code==='admin_forbidden');
});

test('urgent-help source packet is editable, versioned and requires separate medical publication',async t=>{
 const x=await fixture(t),state=await x.admin.state(x.token,x.id),source=state.content.find(x=>x.id==='urgent-help');
 assert.equal(source.status,'draft');assert.ok(source.body.paragraphs.some(x=>x.paragraph===2586));
 await assert.rejects(x.admin.saveContent(x.token,x.id,{...source,body:{paragraphs:[]}}));
 const row=await x.admin.saveContent(x.token,x.id,source);await x.admin.approveContent(x.token,x.id,{id:row.id,revision:row.revision,evidence:'Врач проверил экран и словарь'});assert.equal(await x.admin.publishedContent(row.id),null);
 await x.admin.approveGate(x.token,x.id,{gate:'medical',approved:true,evidence:'Проверка медицинских правил'});assert.ok(await x.admin.publishedContent(row.id));
});

test('new admin polls use 10 Moscow in rollout and existing scheduled polls retain their time',async t=>{
 const x=await fixture(t);await x.pool.query(await readFile(new URL('../auth/admin-migration.sql',import.meta.url),'utf8'));
 const admin=createAdmin({pool:x.pool,articles:{},ownerEmail:x.id+'@example.invalid',appOrigin:'https://example.invalid',settings:x.settings});
 const body={week:'2098-01-06',question:'Вопрос?',options:['Да','Нет']};let poll=await admin.schedulePoll(x.token,x.id,body);assert.equal(new Date(poll.opensAt).getUTCHours(),7);
 await x.pool.query("UPDATE gamification_settings SET value='{}' WHERE id=1");poll=await admin.schedulePoll(x.token,x.id,{...body,question:'Правка?',revision:poll.revision});assert.equal(new Date(poll.opensAt).getUTCHours(),7);
 const old=await admin.schedulePoll(x.token,x.id,{...body,week:'2098-01-13'});assert.equal(new Date(old.opensAt).getUTCHours(),21);
});

test('pilot audience defaults empty, validates identifiers and never leaks list in public settings',async t=>{
 const x=await fixture(t),all=await x.settings.get();assert.equal(forGamificationUser(all,x.id).enabled,true);
 await x.admin.updateSettings(x.token,x.id,{patch:{audience:{mode:'selected',userIds:[x.other]}},reason:'Малая группа этапа'});
 await assert.rejects(x.admin.updateSettings(x.token,x.id,{patch:{audience:{mode:'selected',userIds:['00000000-0000-4000-8000-000000000099']}},reason:'Проверка выбора'}),e=>e.code==='invalid_gamification_content');
 const selected=await x.settings.get();assert.equal(forGamificationUser(selected,x.id).enabled,false);assert.equal(forGamificationUser(selected,x.other).enabled,true);assert.equal(forGamificationUser({enabled:true},x.id).enabled,true);
 assert.deepEqual(mergeSettings().audience,{mode:'selected',userIds:[]});assert.equal(Object.hasOwn(await x.settings.publicSettings(),'audience'),false);
 for(const audience of [{mode:'bad'},{userIds:['not-id']},{userIds:[x.id,x.id]},{userIds:Array(1001).fill(x.id)}])assert.throws(()=>validateSettingsPatch({audience}));
 await x.enqueue('outside','feature');assert.equal((await x.pool.query('SELECT count(*)::int AS n FROM gamification_notifications')).rows[0].n,0);
});
