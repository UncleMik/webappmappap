import { randomUUID, createHash } from 'node:crypto';
import { AuthError, hashToken, isUuid } from './security.mjs';
import { transaction } from './store.mjs';
import { mergeWatched } from './points-video.mjs';
import { forGamificationUser } from './gamification-settings.mjs';
const DAY=86400000, LOCK=0x504f494e;
const fail=(status,code,message)=>new AuthError(status,code,message);
export const starsDay=now=>new Date(+new Date(now)+3*3600000).toISOString().slice(0,10);
export function starsWeek(profile,now=Date.now()) {
 if(profile?.stage!=='pregnancy'||!profile.completedAt||!/^\d{4}-\d{2}-\d{2}$/.test(profile.dueDate||'')||!Number.isFinite(Date.parse(profile.dueDate))) return null;
 const days=280+Math.floor((Date.parse(starsDay(now)+'T00:00:00Z')-Date.parse(profile.dueDate+'T00:00:00Z'))/DAY);
 return Math.max(1,Math.min(42,Math.floor(days/7)));
}
const size=ranges=>ranges.reduce((n,[a,b])=>n+b-a,0);
export function createStars({pool,service,courseMaterials,settings,catalog,clock=Date.now}) {
 async function options(client){return typeof settings?.get==='function'?await settings.get(client):settings||{};}
 const enabled=s=>s.enabled===true && s.features?.stars===true;
 async function materials(context){
  if(context?._materials)return context._materials;
  const list=typeof catalog?.materials==='function'?await catalog.materials(context):typeof catalog?.listMaterials==='function'?await catalog.listMaterials(context):catalog?.materials||[];
  const result=Array.isArray(list)?list.filter(m=>m.available!==false&&Number.isInteger(m.week)&&m.week>=1&&m.week<=42):[];
  if(context)context._materials=result;
  return result;
 }
 async function prepare(userId,profile,config){
  config=forGamificationUser(config,userId);
  let tier='free';
  if(courseMaterials){const access=await courseMaterials.aiContext(userId); if(access.courses?.length)tier='course';}
  const now=new Date(clock());
  return {userId,profile:profile||{},tier,currentWeek:starsWeek(profile,now),moscowDay:starsDay(now),now,settings:config,pointsEnabled:enabled(config)};
 }
 async function lock(client,context){
  const {rows:[user]}=await client.query(`SELECT u.id,GREATEST(u.created_at,l.launched_at) AS started_at
   FROM auth_users u CROSS JOIN auth_stars_launch l WHERE u.id=$1 FOR UPDATE OF u`,[context.userId]);
  context.startedAt=user.started_at;
  await client.query('SELECT pg_advisory_xact_lock($1::int,hashtext($2))',[LOCK,context.userId]);
  await client.query('INSERT INTO auth_stars_wallet(user_id,created_at) VALUES($1,$2) ON CONFLICT DO NOTHING',[context.userId,context.now]);
  const {rows:[row]}=await client.query('SELECT * FROM auth_stars_wallet WHERE user_id=$1 FOR UPDATE',[context.userId]);
  Object.assign(context,{legacy:row.legacy,preservedWeeks:row.preserved_weeks||[],joinedWeek:row.joined_week??context.currentWeek,lastWeek:row.last_week});
  if(row.joined_week===null&&context.currentWeek)await client.query('UPDATE auth_stars_wallet SET joined_week=$2,last_week=$2 WHERE user_id=$1',[context.userId,context.currentWeek]);
  await client.query('INSERT INTO auth_stars_ai_credits(user_id) VALUES($1) ON CONFLICT DO NOTHING',[context.userId]);
  return context;
 }
 async function wallet(client,c,{before=null}={}){
  const {rows:[row]}=await client.query(`SELECT COALESCE(sum(amount),0)::int AS balance,
   COALESCE(sum(amount) FILTER(WHERE capped AND amount>0 AND moscow_day=$2),0)::int AS daily
   FROM auth_points_ledger WHERE user_id=$1`,[c.userId,c.moscowDay]);
  const dailyLimit=c.tier==='course'?(c.settings.limits?.courseDaily??150):(c.settings.limits?.freeDaily??100);
  const {rows}=await client.query(`SELECT id,event_code,event_ref,amount,occurred_at,article_id,video_id,poll_id,metadata
   FROM auth_points_ledger WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2::bigint) ORDER BY id DESC LIMIT 21`,[c.userId,before]);
  const history=rows.slice(0,20).map(r=>({id:String(r.id),kind:r.event_code||(r.article_id?'article_read':r.video_id?'video_watch':r.poll_id?'weekly_poll':'club_message'),ref:r.event_ref,amount:r.amount,occurredAt:new Date(r.occurred_at).toISOString(),metadata:r.metadata}));
  return {balance:row.balance,dailyLimit,dailyEarned:row.daily,dailyRemaining:Math.max(0,dailyLimit-row.daily),history,nextCursor:rows.length>20?history.at(-1).id:null};
 }
 async function event(client,c,{code,ref,amount,capped=false,metadata={}},expense){
  if(!c.pointsEnabled)throw fail(403,'stars_unavailable','Звёздочки пока недоступны.');
  if(typeof code!=='string'||!code||typeof ref!=='string'||!ref||ref.length>240||!Number.isSafeInteger(amount)||amount<0||amount>32767)throw new Error('Invalid server stars event');
  const {rows:[previous]}=await client.query('SELECT amount FROM auth_points_ledger WHERE user_id=$1 AND event_code=$2 AND event_ref=$3',[c.userId,code,ref]);
  const w=await wallet(client,c);
  if(previous)return {actualAmount:Math.abs(previous.amount),balance:w.balance,duplicate:true,limited:false};
  if(expense&&w.balance<amount)throw fail(409,'insufficient_stars','Недостаточно звёздочек.');
  const actual=expense?-amount:capped?Math.min(amount,w.dailyRemaining):amount;
  await client.query(`INSERT INTO auth_points_ledger(user_id,event_code,event_ref,amount,capped,metadata,occurred_at,moscow_day)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[c.userId,code,ref,actual,!expense&&capped,metadata,c.now,c.moscowDay]);
  return {actualAmount:Math.abs(actual),balance:w.balance+actual,duplicate:false,limited:!expense&&actual<amount};
 }
 const credit=(client,c,args)=>event(client,c,args,false);
 const debit=(client,c,args)=>event(client,c,args,true);
 async function progressRows(client,c){
  if(!c._progress)c._progress=(await client.query('SELECT kind,material_id,week,completed_at FROM auth_stars_material_progress WHERE user_id=$1',[c.userId])).rows;
  return c._progress;
 }
 async function releaseWeek(client,c,week){
  if(week>c.currentWeek||!c.currentWeek)return null;
  const {rows:[row]}=await client.query(`UPDATE auth_stars_weeks SET released_at=$3,letter=true
   WHERE user_id=$1 AND week=$2 AND released_at IS NULL RETURNING *`,[c.userId,week,c.now]);
  if(!row)return null;
  const reward=week>=c.joinedWeek?await credit(client,c,{code:'week_complete',ref:String(week),amount:c.settings.rewards?.weekComplete??50}):null;
  return {week,reward,letter:true};
 }
 async function completeMaterial(client,c,{kind,id,week,eligibleForReward=true}){
  if(!c.pointsEnabled)throw fail(403,'stars_unavailable','Звёздочки пока недоступны.');
  const list=await materials(c),material=list.find(m=>m.kind===kind&&String(m.id)===String(id));
  if(kind!=='course_lesson'&&!material)throw fail(404,'stars_material_not_found','Материал недоступен.');
  week=material?.week??week??null; id=String(id);
  if(week&&c.settings.features?.weekLocks===true&&(!c.currentWeek||week>c.currentWeek)&&!c.legacy&&!c.preservedWeeks?.includes(week)){
   const {rows}=await client.query('SELECT 1 FROM auth_stars_week_purchases WHERE user_id=$1 AND week=$2',[c.userId,week]);
   if(!rows.length)throw fail(403,'week_locked','Эта неделя пока закрыта.');
  }
  const {rows}=await client.query(`INSERT INTO auth_stars_material_progress(user_id,kind,material_id,week,completed_at,reward_eligible)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING material_id`,[c.userId,kind,id,week,c.now,Boolean(eligibleForReward&&(!week||week<=c.currentWeek))]);
  if(rows.length)c._progress=undefined;
  let reward=null;
  if(rows.length&&eligibleForReward&&(!week||week<=c.currentWeek))reward=await credit(client,c,{code:kind==='article'?'article_read':kind==='video'?'video_watch':'course_lesson',ref:id,amount:kind==='article'?(c.settings.rewards?.article??10):kind==='video'?(c.settings.rewards?.video??20):(c.settings.rewards?.courseLesson??30),capped:true});
  let completion=null;
  if(week){
   const target=list.filter(m=>m.week===week&&['article','video'].includes(m.kind));
   const done=await progressRows(client,c);
   if(target.length&&target.every(m=>done.some(p=>p.kind===m.kind&&p.material_id===String(m.id)))){
    await client.query(`INSERT INTO auth_stars_weeks(user_id,week,completed_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[c.userId,week,c.now]);
    completion=await releaseWeek(client,c,week);
   }
  }
  return {progress:{kind,id,week,completed:true,duplicate:!rows.length},reward,completion,letter:completion?.letter?{week}:null};
 }
 async function lifecycle(client,c){
  if(!c.pointsEnabled)return;
  if(c.currentWeek){
   await credit(client,c,{code:'welcome',ref:'once',amount:c.settings.rewards?.welcome??100});
   for(const boundary of [14,28])if(c.lastWeek&&c.lastWeek<boundary&&c.currentWeek>=boundary)await credit(client,c,{code:'trimester_complete',ref:String(boundary),amount:c.settings.rewards?.trimester??30});
   if(c.lastWeek!==c.currentWeek)await client.query('UPDATE auth_stars_wallet SET last_week=$2 WHERE user_id=$1',[c.userId,c.currentWeek]);
   const list=await materials(c);
   // Only historical rows need normalization, once. Reuse this one progress read.
   const done=await progressRows(client,c),byId=new Map(list.map(m=>[`${m.kind}:${m.id}`,m]));
   const missing=done.filter(p=>p.week===null&&byId.has(`${p.kind}:${p.material_id}`));
   if(missing.length){
    const updates=missing.map(p=>({kind:p.kind,id:p.material_id,week:byId.get(`${p.kind}:${p.material_id}`).week}));
    await client.query(`UPDATE auth_stars_material_progress p SET week=m.week
    FROM jsonb_to_recordset($2::jsonb) AS m(kind text,id text,week integer)
    WHERE p.user_id=$1 AND p.week IS NULL AND p.kind=m.kind AND p.material_id=m.id`,
    [c.userId,JSON.stringify(updates)]);
    for(const p of missing)p.week=byId.get(`${p.kind}:${p.material_id}`).week;
   }
   const completed=new Set(done.map(p=>`${p.kind}:${p.material_id}`)),groups=new Map();
   for(const m of list.filter(m=>['article','video'].includes(m.kind))){if(!groups.has(m.week))groups.set(m.week,[]);groups.get(m.week).push(m);}
   const weeks=[...groups].filter(([,target])=>target.every(m=>completed.has(`${m.kind}:${m.id}`))).map(([week])=>week);
   if(weeks.length)await client.query(`INSERT INTO auth_stars_weeks(user_id,week,completed_at)
    SELECT $1,week,$3 FROM unnest($2::int[]) AS week ON CONFLICT DO NOTHING`,[c.userId,weeks,c.now]);
   const {rows}=await client.query('SELECT week FROM auth_stars_weeks WHERE user_id=$1 AND released_at IS NULL AND week<=$2',[c.userId,c.currentWeek]);
   for(const row of rows)await releaseWeek(client,c,row.week);
  }
 }
 async function withAccount(token,expected,callback){
  if(!token)throw fail(401,'sign_in_required','Войдите в аккаунт.');
  // All remote course checks complete before the wallet transaction starts.
  const user=await service.session(token);
  if(!user)throw fail(401,'sign_in_required','Войдите в аккаунт.');
  if(!isUuid(expected)||expected!==user.id)throw fail(409,'account_changed','Аккаунт изменился. Обновите страницу.');
  const c=await prepare(user.id,user.profile,await options());
  return transaction(pool,async client=>{
   const {rows:[s]}=await client.query(`SELECT s.expires_at,u.profile FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
    WHERE token_hash=$1 AND s.user_id=$2 AND revoked_at IS NULL AND expires_at>$3 FOR SHARE OF s FOR UPDATE OF u`,[hashToken(token),user.id,c.now]);
   if(!s)throw fail(401,'sign_in_required','Войдите в аккаунт.');
   c.profile=s.profile||{};c.currentWeek=starsWeek(c.profile,c.now);c.sessionHash=hashToken(token);
   await lock(client,c);await lifecycle(client,c);
   const result=await callback(client,c);
   if(+new Date(s.expires_at)<=clock())throw fail(401,'sign_in_required','Войдите в аккаунт.');
   return result;
  });
 }
 async function stateFor(client,c){
  if(!c.pointsEnabled)return {accountId:c.userId,enabled:false};
  const progress=(await progressRows(client,c)).map(({material_id,...row})=>({...row,id:material_id}));
  const {rows:weeks}=await client.query('SELECT week,completed_at,released_at,letter FROM auth_stars_weeks WHERE user_id=$1 ORDER BY week',[c.userId]);
  const {rows:purchased}=await client.query('SELECT week FROM auth_stars_week_purchases WHERE user_id=$1 ORDER BY week',[c.userId]);
  const {rows:[ai]}=await client.query('SELECT balance FROM auth_stars_ai_credits WHERE user_id=$1',[c.userId]);
  const list=await materials(c),done=new Set(progress.map(p=>`${p.kind}:${p.id}`)),purchasedWeeks=purchased.map(r=>r.week);
  const weekProgress=Array.from({length:42},(_,i)=>{
   const week=i+1,target=list.filter(m=>m.week===week&&['article','video'].includes(m.kind)),row=weeks.find(w=>w.week===week);
   const locked=c.settings.features?.weekLocks===true&&!c.legacy&&(!c.currentWeek||week>c.currentWeek)&&!purchasedWeeks.includes(week)&&!c.preservedWeeks?.includes(week);
   return {week,total:target.length,completedCount:target.filter(m=>done.has(`${m.kind}:${m.id}`)).length,available:!locked,locked,purchased:purchasedWeeks.includes(week),completed:Boolean(row),rewardPending:Boolean(row&&!row.released_at),letter:Boolean(row?.letter)};
  });
  return {accountId:c.userId,enabled:true,tier:c.tier,currentWeek:c.currentWeek,legacy:c.legacy,wallet:await wallet(client,c),progress,weeks:weekProgress,weekProgress,purchasedWeeks,purchaseOptions:await purchaseOptions(client,c,purchasedWeeks),aiCredits:ai?.balance||0};
 }
 async function state(token,account){return withAccount(token,account,stateFor);}
 async function pollAvailability(client,userId){
  const config=forGamificationUser(await options(client),userId);
  // Outside the stars pilot, preserve the existing poll without onboarding gates.
  if(!enabled(config))return {available:true,pilot:false,reason:null,availableAt:null};
  const {rows:[user]}=await client.query(`SELECT GREATEST(u.created_at,l.launched_at) AS started_at,
   u.created_at<=l.launched_at AS prelaunch
   FROM auth_users u CROSS JOIN auth_stars_launch l WHERE u.id=$1`,[userId]);
  if(!user)return {available:false,pilot:true,reason:'poll_unavailable',availableAt:null};
  // The poll predates stars. A material-access review must never revoke it.
  if(user.prelaunch)return {available:true,pilot:true,reason:null,availableAt:null};
  const start=Date.parse(starsDay(user.started_at)),day=Date.parse(starsDay(clock()));
  const available=day-start>=2*DAY;
  return {available,pilot:true,reason:available?null:'poll_onboarding',availableAt:new Date(start+2*DAY-3*3600000).toISOString()};
 }
 async function purchaseOptions(client,c,purchasedWeeks){
  if(!purchasedWeeks)purchasedWeeks=(await client.query('SELECT week FROM auth_stars_week_purchases WHERE user_id=$1',[c.userId])).rows.map(r=>r.week);
  const week=c.currentWeek&&c.currentWeek<42?c.currentWeek+1:null;
  const reason=!c.pointsEnabled?'stars_unavailable':!week?'invalid_week':
   c.legacy||c.preservedWeeks?.includes(week)||c.settings.features?.weekLocks!==true||purchasedWeeks.includes(week)?'week_already_available':
   c.settings.features?.peekNextWeek!==true||Date.parse(c.moscowDay)-Date.parse(starsDay(c.startedAt))<3*DAY?'peek_unavailable':null;
  return {peekNextWeek:{available:reason===null,week,price:c.settings.prices?.peekNextWeek??100,reason}};
 }
 async function purchase(token,account,{kind,requestId,week}={}){
  if(!['peek_next_week','ai_pack'].includes(kind)||!isUuid(requestId))throw fail(400,'invalid_purchase','Проверьте покупку.');
  return withAccount(token,account,async(client,c)=>{
   if(!c.pointsEnabled)throw fail(403,'stars_unavailable','Звёздочки пока недоступны.');
   const {rows:[prev]}=await client.query('SELECT event_code,metadata FROM auth_points_ledger WHERE user_id=$1 AND event_ref=$2 AND event_code IN (\'peek_next_week\',\'ai_pack\')',[c.userId,requestId]);
   if(prev){if(prev.event_code!==kind||(kind==='peek_next_week'&&prev.metadata.week!==week))throw fail(409,'request_conflict','Этот запрос уже использован.');return {...prev.metadata,duplicate:true,wallet:await wallet(client,c),purchaseOptions:await purchaseOptions(client,c)};}
   let metadata;
   if(kind==='peek_next_week'){
    if(!c.currentWeek||c.currentWeek>=42||week!==c.currentWeek+1)throw fail(400,'invalid_week','Можно открыть только следующую неделю.');
    const {rows}=await client.query('SELECT week FROM auth_stars_week_purchases WHERE user_id=$1 AND week=$2',[c.userId,week]);
    if(rows.length)return {kind,week,duplicate:true,wallet:await wallet(client,c),purchaseOptions:await purchaseOptions(client,c)};
    if(c.legacy||c.preservedWeeks?.includes(week)||c.settings.features?.weekLocks!==true)throw fail(409,'week_already_available','Эта неделя уже доступна.');
    if(c.settings.features?.peekNextWeek!==true)throw fail(403,'peek_unavailable','Раннее открытие пока недоступно.');
    if(Date.parse(c.moscowDay)-Date.parse(starsDay(c.startedAt))<3*DAY)throw fail(403,'peek_unavailable','Раннее открытие появится немного позже.');
    metadata={kind,week};await debit(client,c,{code:kind,ref:requestId,amount:c.settings.prices?.peekNextWeek??100,metadata});
    await client.query('INSERT INTO auth_stars_week_purchases(user_id,week,request_id,purchased_at) VALUES($1,$2,$3,$4)',[c.userId,week,requestId,c.now]);
   }else{
    if(c.settings.features?.aiPacks!==true||c.settings.aiBudgetApproved!==true)throw fail(403,'ai_packs_unavailable','Покупка вопросов пока недоступна.');
    const paid=c.tier==='course',limit=paid?(c.settings.ai?.coursePurchases??1):(c.settings.ai?.freePurchases??2),units=paid?(c.settings.ai?.coursePack??10):(c.settings.ai?.freePack??3);
    const {rows:[count]}=await client.query("SELECT count(*)::int AS n FROM auth_points_ledger WHERE user_id=$1 AND event_code='ai_pack' AND moscow_day=$2",[c.userId,c.moscowDay]);
    if(count.n>=limit)throw fail(409,'ai_purchase_limit','Дневной предел покупок достигнут.');
    const {rows:[used]}=await client.query('SELECT used FROM auth_stars_ai_daily_usage WHERE user_id=$1 AND day_moscow=$2',[c.userId,c.moscowDay]);
    if((used?.used||0)>=(paid?(c.settings.ai?.coursePaidDaily??10):(c.settings.ai?.freePaidDaily??6)))throw fail(409,'ai_paid_daily_limit','Купленные вопросы на сегодня закончились.');
    metadata={kind,units};await debit(client,c,{code:kind,ref:requestId,amount:paid?(c.settings.prices?.aiPackCourse??100):(c.settings.prices?.aiPackFree??50),metadata});
    await client.query('UPDATE auth_stars_ai_credits SET balance=balance+$2 WHERE user_id=$1',[c.userId,units]);
   }
   return {...metadata,duplicate:false,wallet:await wallet(client,c),purchaseOptions:await purchaseOptions(client,c)};
  });
 }
 // For already authorized in-transaction domain hooks (Club/poll).
 async function contextFor(client,userId){const {rows:[u]}=await client.query('SELECT profile FROM auth_users WHERE id=$1',[userId]);return lock(client,await prepare(userId,u?.profile,await options(client)));}
 return {withAccount,credit,debit,wallet,completeMaterial,state,stateFor,weekProgress:async(client,c)=>(await stateFor(client,c)).weekProgress||[],pollAvailability,purchaseOptions,purchase,contextFor,materials,
  async isEnabled(userId){const config=await options();return enabled(userId===undefined?config:forGamificationUser(config,userId));},
  async materialAccess(client,c,kind,id){const m=(await materials(c)).find(m=>m.kind===kind&&String(m.id)===String(id));if(!m)throw fail(404,'stars_material_not_found','Материал недоступен.');if(c.pointsEnabled&&c.settings.features?.weekLocks===true&&!c.legacy&&!c.preservedWeeks?.includes(m.week)&&(!c.currentWeek||m.week>c.currentWeek)){const {rows}=await client.query('SELECT 1 FROM auth_stars_week_purchases WHERE user_id=$1 AND week=$2',[c.userId,m.week]);if(!rows.length)throw fail(403,'week_locked','Эта неделя пока закрыта.');}return m;},
  async courseVideoWatching(token,account,data){
   const {productId,lessonId,videoKey,attemptId,ranges}=data||{};
   if(!Number.isSafeInteger(productId)||productId<1||!Number.isSafeInteger(lessonId)||lessonId<1||typeof videoKey!=='string'||(attemptId===undefined&&ranges!==undefined))throw fail(400,'invalid_video_progress','Проверьте данные просмотра.');
   if(!token)throw fail(401,'sign_in_required','Войдите в аккаунт.');
   const user=await service.session(token);if(!user)throw fail(401,'sign_in_required','Войдите в аккаунт.');
   if(!isUuid(account)||user.id!==account)throw fail(409,'account_changed','Аккаунт изменился. Обновите страницу.');
   const access=await courseMaterials.aiContext(user.id);
   if(!access.courses.some(c=>c.productId===productId))throw fail(403,'course_required','Нужен доступ к курсу.');
   const result=await courseMaterials.lesson(user.id,productId,lessonId);
   const videos=result.lesson.blocks.flatMap((b,bi)=>(b.videos||[]).map((v,vi)=>({...v,key:`${bi}:${vi}`})));
   if(!videos.length||videos.some(v=>!v.url||v.unsupported===true||v.status==='unsupported'))throw fail(409,'video_progress_unsupported','Просмотр всех роликов этого урока пока не подтверждается.');
   // Duration must come from a trusted server manifest, never from the browser.
   const manifest=typeof catalog?.courseVideos==='function'?await catalog.courseVideos(lessonId):null;
   if(!Array.isArray(manifest)||!manifest.length||videos.some(v=>!manifest.some(m=>m.key===v.key&&Number.isSafeInteger(m.durationMs)&&m.durationMs>0&&/^[a-f0-9]{64}$/.test(m.contentHash||''))))throw fail(409,'video_duration_unverified','Просмотр этого урока пока не подтверждается.');
   const video=manifest.find(v=>v.key===videoKey);if(!video||!videos.some(v=>v.key===videoKey))throw fail(404,'video_not_found','Видео не найдено.');
   const contentHash=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
   if(attemptId!==undefined&&(!isUuid(attemptId)||!Array.isArray(ranges)||ranges.length>32||ranges.some(r=>!Array.isArray(r)||r.length!==2||!r.every(Number.isSafeInteger)||r[0]<0||r[1]<=r[0]||r[1]>video.durationMs)))throw fail(400,'invalid_video_progress','Проверьте данные просмотра.');
   return withAccount(token,account,async(client,c)=>{
    if(!c.pointsEnabled)throw fail(403,'stars_unavailable','Звёздочки пока недоступны.');
    if(c.tier!=='course'||!Number.isFinite(Date.parse(result.validUntil))||Date.parse(result.validUntil)<=+c.now)throw fail(403,'course_required','Обновите доступ к курсу.');
    const args=[c.userId,String(lessonId),videoKey];
    const {rows:[view]}=await client.query('SELECT * FROM auth_stars_course_views WHERE user_id=$1 AND lesson_id=$2 AND video_key=$3',args);
    if(attemptId===undefined){const id=randomUUID();await client.query(`INSERT INTO auth_stars_course_views(user_id,lesson_id,video_key,session_hash,attempt_id,last_seen_at,duration_ms,watched,content_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,lesson_id,video_key) DO UPDATE SET session_hash=$4,attempt_id=$5,last_seen_at=$6,duration_ms=$7,
      watched=CASE WHEN auth_stars_course_views.content_hash=$9 THEN auth_stars_course_views.watched ELSE '[]'::jsonb END,content_hash=$9`,[...args,c.sessionHash,id,c.now,video.durationMs,JSON.stringify([]),contentHash]);return {status:'watching',attemptId:id};}
    if(!view||view.attempt_id!==attemptId||view.session_hash!==c.sessionHash||view.content_hash!==contentHash)throw fail(409,'video_attempt_expired','Начните просмотр снова.');
    const elapsed=+c.now-+new Date(view.last_seen_at),submitted=mergeWatched(ranges),watched=elapsed>=0&&elapsed<=30000&&size(submitted)<=elapsed*2?mergeWatched([...view.watched,...submitted]):view.watched;
    await client.query('UPDATE auth_stars_course_views SET watched=$4,last_seen_at=$5 WHERE user_id=$1 AND lesson_id=$2 AND video_key=$3',[...args,JSON.stringify(watched),c.now]);
    const {rows:all}=await client.query('SELECT video_key,watched,duration_ms,content_hash FROM auth_stars_course_views WHERE user_id=$1 AND lesson_id=$2',[c.userId,String(lessonId)]);
    if(videos.every(v=>all.some(r=>r.video_key===v.key&&r.content_hash===contentHash&&r.duration_ms===manifest.find(m=>m.key===v.key).durationMs&&size(r.watched)*5>=r.duration_ms*4))){const completion=await completeMaterial(client,c,{kind:'course_lesson',id:String(lessonId)});return {status:'earned',amount:completion.reward?.actualAmount||0,...completion};}
    return {status:'watching'};
   });
  }
 };
}
