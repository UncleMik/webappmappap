// Synthetic content only. Real domain modules and isolated PGlite; never production.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { testPool } from '../backend/test/auth-pool.mjs';
import { createStars } from '../backend/auth/stars-core.mjs';
import { createGamification } from '../backend/auth/gamification.mjs';
import { createStarsAi } from '../backend/auth/stars-ai.mjs';
import { createGamificationNotifications } from '../backend/auth/gamification-notifications.mjs';
import { DEFAULT_GAMIFICATION_SETTINGS } from '../backend/auth/gamification-settings.mjs';
import { loadGamificationCatalog } from '../backend/auth/gamification-content.mjs';
import { hashToken } from '../backend/auth/security.mjs';
export async function createUiFixture({presentations=false}={}) {
  if(process.env.AUTH_TEST_DATABASE_URL)throw new Error('UI fixtures require isolated in-memory PGlite');
  const db=await testPool(),{pool}=db;
  for(const file of ['club-chat-migration.sql','points-migration.sql','points-article-migration.sql','points-video-migration.sql','weekly-poll.sql','stars-migration.sql','ai-chat-migration.sql','stars-ai-migration.sql','gamification-admin-migration.sql','gamification-migration.sql']) await pool.query(await readFile(new URL('../backend/auth/'+file,import.meta.url),'utf8'));
  let now=Date.parse('2026-11-12T09:00:00Z'),clock=()=>now;
  const config={...structuredClone(DEFAULT_GAMIFICATION_SETTINGS),audience:{mode:'all',userIds:[]},enabled:true,medicalApproved:false,aiBudgetApproved:true};for(const key in config.features)config.features[key]=true;
  config.aiPacksEnabled=true;
  const settings={get:async()=>config};
  await pool.query('UPDATE auth_stars_launch SET launched_at=$1 WHERE id=1',['2026-10-01T00:00:00Z']);
  const users=new Map();
  const service={session:async token=>users.get(token)};
  const catalog=loadGamificationCatalog();
  const pub=item=>({...item,status:'published',medical:false,medicalApproved:false});
  catalog.questions=catalog.questions.map(item=>pub({...item,prompt:'Синтетический вопрос для проверки интерфейса',options:['Вариант А','Вариант Б'],answer:0,explanation:'Синтетическое объяснение после ответа.'}));
  for(const key of ['care','ideas','practices','replies','quests'])catalog[key]=catalog[key].map(item=>pub({...item,title:'Задание для проверки',text:'Синтетический текст проверки.'}));
  catalog.letters=catalog.letters.map(item=>pub({...item,text:'Личное тестовое письмо.'}));
  catalog.weekly=Object.fromEntries(Object.entries(catalog.weekly).map(([key,item])=>[key,pub({...item,baby:'Тестовый факт',mom:'Тестовый текст',development:'Тестовое развитие'})]));
  for(const key of ['bag','doctor'])catalog.checklists[key]=catalog.checklists[key].map((item,index)=>pub({...item,text:`${key==='bag'?'Предмет':'Вопрос'} ${index+1} для проверки`}));
  catalog.hints=(catalog.hints || []).map(item=>pub({...item,text:'Синтетическая подсказка: '+item.feature}));
  const materials=[{kind:'article',id:'fixture-article',week:35,title:'Тестовая статья',accessible:true},{kind:'video',id:'103',week:35,title:'Тестовое видео',accessible:true}];catalog.materials=materials;
  const stars=createStars({pool,service,settings,clock,catalog:{materials}}),ai=createStarsAi({pool,settings,clock});
  const notifications=createGamificationNotifications({pool,service,settings,clock});
  const daily=createGamification({pool,service,stars,settings,catalog,notifications,clock});
  async function account(width=390) {
    const id=randomUUID(),token=randomUUID(),profile={stage:'pregnancy',completedAt:'2026-11-01T00:00:00Z',dueDate:'2026-12-15',name:'Проверка '+width,goals:[]};
    await pool.query('INSERT INTO auth_users(id,email,profile,getcourse_id) VALUES($1,$2,$3,$4)',[id,id+'@example.invalid',profile,users.size+1]);
    await pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),id,new Date(now+365*86400000)]);
    const user={id,email:id+'@example.invalid',profile};users.set(token,user);
    await pool.query('UPDATE auth_users SET created_at=$2 WHERE id=$1',[id,'2026-10-01T00:00:00Z']);
    await daily.state(token,id);
    await pool.query('UPDATE auth_stars_wallet SET legacy=false WHERE user_id=$1',[id]);
    await pool.query('UPDATE auth_gamification_launch SET launched_at=$1 WHERE id=1',['2026-10-01T00:00:00Z']);
    await pool.query('UPDATE auth_gamification_state SET first_day=$2,data=data || $3::jsonb WHERE user_id=$1',[id,'2026-10-01',{unlocked:{time_capsule:1,surprise_scratch:2,surprise_flip:3,surprise_pick3:4,streak:5,guess_size:6},lastNoveltyDay:35,letters:[34]}]);
    await stars.withAccount(token,id,async(client,c)=>{await stars.credit(client,c,{code:'fixture',ref:'balance',amount:1000,capped:false});for(let i=0;i<24;i++)await stars.credit(client,c,{code:'fixture',ref:'history-'+i,amount:1,capped:false});});
    if(!presentations){const ids=(await pool.query("SELECT id::text FROM auth_points_ledger WHERE user_id=$1 AND event_code IN ('welcome','week_complete','trimester_complete')",[id])).rows.map(row=>row.id);await pool.query('UPDATE auth_gamification_state SET data=data || $2::jsonb WHERE user_id=$1',[id,{seenCelebrations:ids,seenHints:catalog.features.map(item=>item.id)}]);}
    return {id,token,user};
  }
  return {db,pool,config,stars,daily,ai,notifications,account,clock,advance:days=>{now+=days*86400000;},renewSession:async actor=>{const next=randomUUID();await pool.query('UPDATE auth_sessions SET token_hash=$1 WHERE token_hash=$2',[hashToken(next),hashToken(actor.token)]);users.delete(actor.token);users.set(next,actor.user);actor.token=next;}};
}
