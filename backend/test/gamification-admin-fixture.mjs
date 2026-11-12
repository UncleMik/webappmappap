import {readFile} from 'node:fs/promises';
import {randomUUID,createECDH,randomBytes} from 'node:crypto';
import {testPool} from './auth-pool.mjs';
import {hashToken} from '../auth/security.mjs';
import {createGamificationSettings} from '../auth/gamification-settings.mjs';
import {createGamificationAdmin} from '../auth/gamification-admin.mjs';
import {createGamificationNotifications} from '../auth/gamification-notifications.mjs';
export function subscription(endpoint='https://fcm.googleapis.com/fcm/send/test') {
 const key=createECDH('prime256v1');key.generateKeys();
 return {endpoint,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
}
export async function fixture(t) {
 const db=await testPool();t.after(()=>db.close());const {pool}=db;
 for(const name of ['club-chat-migration.sql','points-migration.sql','points-article-migration.sql','points-video-migration.sql','weekly-poll.sql','stars-migration.sql','gamification-admin-migration.sql','gamification-migration.sql','ai-chat-migration.sql','stars-ai-migration.sql'])await pool.query(await readFile(new URL('../auth/'+name,import.meta.url),'utf8'));
 let now=Date.parse('2026-11-12T09:00:00Z');const clock=()=>now,id=randomUUID(),token=randomUUID(),other=randomUUID();
 for(const uid of [id,other])await pool.query('INSERT INTO auth_users(id,email,getcourse_id,profile) VALUES($1,$2,$3,$4)',[uid,uid+'@example.invalid',uid===id?1:2,{stage:'pregnancy',dueDate:'2027-03-18'}]);
 await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),id,new Date('2099-01-01')]);
 let role='owner';const session=async()=>({id,role}),settings=createGamificationSettings({pool});
 const admin=createGamificationAdmin({pool,admin:{session},settings,clock});
 const sent=[];let transport=async(sub,payload)=>{sent.push({sub,payload});};
 const noticesWithPool=(dbPool=pool)=>createGamificationNotifications({pool:dbPool,service:{session},settings,clock,pushPublicKey:'test-public-key',pushTransport:(...args)=>transport(...args)});
 const notices=noticesWithPool();
 await pool.query('UPDATE gamification_settings SET value=$1 WHERE id=1',[{enabled:true,audience:{mode:'all',userIds:[]},features:{stars:true,notifications:true,push:true}}]);
 return {pool,id,other,token,admin,settings,notices,noticesWithPool,sent,setRole:r=>role=r,setTime:value=>now=Date.parse(value),transport:fn=>transport=fn,
 enqueue:async(key,type='daily',extra={})=>{const c=await pool.connect();try{return await notices.enqueue(c,{userId:id,key,type,title:'Личный текст',body:'Не передавать провайдеру',...extra});}finally{c.release();}}};
}
