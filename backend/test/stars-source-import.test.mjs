import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {testPool} from './auth-pool.mjs';
import {importApprovedStarsSource,STARS_REUSE_EVIDENCE} from '../auth/stars-source-import.mjs';
import {loadGamificationCatalog,isPublished} from '../auth/gamification-content.mjs';
import {createGamificationSettings} from '../auth/gamification-settings.mjs';
import {createGamificationAdmin} from '../auth/gamification-admin.mjs';
import {createAiUrgent} from '../auth/ai-urgent.mjs';
import {hashToken} from '../auth/security.mjs';
const evidence='Пользователь подтвердил: «Да, тексты последнего документа утверждены врачом». Импорт точного источника.';
const hash=()=>readFile(new URL('../content/gamification-source.json',import.meta.url)).then(b=>createHash('sha256').update(b).digest('hex'));
async function setup(t) {
 const db=await testPool();t.after(()=>db.close());const {pool}=db;
 await pool.query(await readFile(new URL('../auth/gamification-admin-migration.sql',import.meta.url),'utf8'));
 const id=randomUUID(),email='owner@example.invalid',token=randomUUID();
 await pool.query('INSERT INTO auth_users(id,email,getcourse_id,profile) VALUES($1,$2,1,$3)',[id,email,{name:'Тест'}]);
 await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),id,new Date(Date.now()+86400000)]);
 const args={pool,ownerEmail:email,evidence,sourceSha256:await hash()};
 const settings=createGamificationSettings({pool});
 const snapshot=async()=>({content:(await pool.query('SELECT * FROM gamification_content ORDER BY id')).rows,audit:(await pool.query('SELECT * FROM gamification_audit ORDER BY id')).rows,settings:(await pool.query('SELECT * FROM gamification_settings WHERE id=1')).rows[0]});
 return {pool,id,email,token,args,settings,snapshot};
}
test('source import plans without writes, approves exact complete source atomically, publishes loader/urgent, repeats without revision/audit',async t=>{
 const x=await setup(t),before=await x.snapshot();
 await x.pool.query('UPDATE gamification_settings SET value=$1 WHERE id=1',[{enabled:false,audience:{mode:'selected',userIds:[x.id]},features:{stars:false,daily:false},prices:{peekNextWeek:123}}]);
 const settingsBefore=(await x.snapshot()).settings;
 const plan=await importApprovedStarsSource({...x.args,dryRun:true});assert.equal(plan.dryRun,true);assert.ok(plan.counts.total>400);assert.equal(plan.counts.insert,plan.counts.total);assert.equal((await x.snapshot()).content.length,0);assert.equal((await x.snapshot()).audit.length,0);
 const imported=await importApprovedStarsSource(x.args);assert.equal(imported.dryRun,false);const after=await x.snapshot();
 assert.equal(after.content.length,imported.counts.total);assert.ok(after.content.every(r=>r.status==='approved'&&r.approved_by===x.id&&r.approved_at&&r.revision===1));
 assert.equal(after.content.filter(r=>r.kind==='letters').length,42);assert.equal(after.content.filter(r=>r.kind==='questions').length,126);assert.equal(after.content.filter(r=>r.kind==='replies').length,45);assert.equal(after.content.filter(r=>r.kind==='hints').length,16);
 assert.equal(after.settings.medical_approved,true);assert.equal(after.settings.ai_budget_approved,before.settings.ai_budget_approved);assert.deepEqual(after.settings.value,settingsBefore.value);
 assert.ok(after.audit.every(r=>r.actor_id===x.id));
 for(const r of after.content)assert.equal(r.evidence,['weekly','quests'].includes(r.kind)?STARS_REUSE_EVIDENCE:evidence);
 const proof=after.audit.filter(r=>r.action==='source_imported');assert.equal(proof.length,1);assert.equal(proof[0].after_value.sourceSha256,x.args.sourceSha256);assert.ok(proof[0].after_value.reusedIds.includes('weekly-22'));assert.equal(proof[0].after_value.reusedEvidence,STARS_REUSE_EVIDENCE);
 const cat=await loadGamificationCatalog({pool:x.pool})(),config=await x.settings.get();assert.ok(cat.questions.every(q=>isPublished(q,config)));assert.ok(cat.letters.every(q=>isPublished(q,config)));assert.ok(cat.hints.every(q=>isPublished(q,config)));assert.ok(isPublished(cat.weekly[22],config));
 const urgent=createAiUrgent({pool:x.pool,settings:x.settings});assert.equal(await urgent.evaluate({tags:['кровь'],userId:x.id}),null); // rollout itself remains off
 await x.pool.query("UPDATE gamification_settings SET value=jsonb_set(value,'{enabled}','true'),ai_budget_approved=true WHERE id=1");
 assert.equal((await urgent.evaluate({tags:['кровь'],userId:x.id})).free,true);
 const current=await x.snapshot(),again=await importApprovedStarsSource(x.args),repeated=await x.snapshot();
 assert.equal(again.counts.insert,0);assert.equal(again.counts.approve,0);assert.equal(again.counts.unchanged,plan.counts.total);assert.equal(again.medicalGateChange,false);assert.deepEqual(repeated,current);assert.equal(repeated.settings.ai_budget_approved,true);
});
test('source mismatch, missing owner and invalid evidence cannot create content or an actor',async t=>{
 const x=await setup(t),before=await x.snapshot();
 await assert.rejects(importApprovedStarsSource({...x.args,sourceSha256:'0'.repeat(64)}),e=>e.code==='stars_source_hash_mismatch');
 await assert.rejects(importApprovedStarsSource({...x.args,ownerEmail:'absent@example.invalid'}),e=>e.code==='stars_source_owner_absent');
 await assert.rejects(importApprovedStarsSource({...x.args,evidence:' '}),e=>e.code==='stars_source_evidence_required');
 await assert.rejects(importApprovedStarsSource({...x.args,evidence:'x'.repeat(2000)}),e=>e.code==='stars_source_evidence_required');
 await assert.rejects(importApprovedStarsSource({...x.args,ownerEmail:randomUUID()}),e=>e.code==='stars_source_owner_required');
 assert.deepEqual(await x.snapshot(),before);
});
test('one modified existing draft rolls back the complete import and preserves its content, editor and revision',async t=>{
 const x=await setup(t);
 await x.pool.query("INSERT INTO gamification_content(id,kind,body,medical,revision,status,updated_by,updated_at) VALUES('myth-22-1','questions',$1,true,7,'draft',$2,now())",[{prompt:'Редакторская правка, не утверждённая этим источником'},x.id]);
 const before=await x.snapshot();await assert.rejects(importApprovedStarsSource(x.args),e=>e.code==='stars_source_content_conflict');assert.deepEqual(await x.snapshot(),before);
});
test('late database failure rolls back all draft approvals, source audit and the medical gate',async t=>{
 const x=await setup(t),before=await x.snapshot();
 const failing={async connect(){const client=await x.pool.connect();return {release:()=>client.release(),query:(sql,args)=>sql.startsWith('UPDATE gamification_settings SET medical_approved')?Promise.reject(new Error('synthetic late failure')):client.query(sql,args)};}};
 await assert.rejects(importApprovedStarsSource({...x.args,pool:failing}),/synthetic late failure/);assert.deepEqual(await x.snapshot(),before);
});
test('normal admin editing removes source approval and later source import cannot overwrite that draft',async t=>{
 const x=await setup(t);await importApprovedStarsSource(x.args);
 const row=(await x.pool.query("SELECT * FROM gamification_content WHERE id='myth-22-1'")).rows[0];
 const admin=createGamificationAdmin({pool:x.pool,settings:x.settings,admin:{session:async()=>({id:x.id,role:'owner'})}});
 const edited=await admin.saveContent(x.token,x.id,{id:row.id,kind:row.kind,revision:row.revision,medical:true,body:{...row.body,prompt:'Новая формулировка — требуется отдельная проверка'}});
 assert.equal(edited.status,'draft');assert.equal(edited.approved_by,null);assert.equal(edited.evidence,null);assert.equal(edited.revision,2);
 const before=await x.snapshot();await assert.rejects(importApprovedStarsSource(x.args),e=>e.code==='stars_source_content_conflict');assert.deepEqual(await x.snapshot(),before);
 const cat=await loadGamificationCatalog({pool:x.pool})();assert.equal(isPublished(cat.questions.find(q=>q.id===row.id),await x.settings.get()),false);
});
