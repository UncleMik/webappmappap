import * as gamificationSettings from './gamification-settings.mjs';
import { createHash } from 'node:crypto';
import { matchesUrgent } from './ai-urgent.mjs';
import { transaction } from './store.mjs';
import { AuthError } from './security.mjs';
import { loadGamificationCatalog, isPublished, guessQuestion, materialTags } from './gamification-content.mjs';
const DAY=86400000;
const invalid=()=>new AuthError(400,'invalid_gamification','Проверьте данные действия.');
const unavailable=()=>new AuthError(409,'feature_unavailable','Возможность пока недоступна.');
const dateDay=x=>new Date(x).toISOString().slice(0,10);
const nowMs=clock=>Number(new Date(clock()));
const moscow=x=>dateDay(x+3*3600000);
const trimester=w=>w<14?1:w<28?2:3;
const mod=(n,d)=>((n%d)+d)%d;
const payloadFor=body=>body.type==='capsule_save'?{...body,text:undefined,textHash:createHash('sha256').update(String(body.text)).digest('hex')}:body;
const ACTION_FIELDS={checkin:['mood','tags'],surprise:[],myth_answer:['questionId','answer'],quest_done:['questId'],checklist_update:['list','itemId','status','note'],first_kick:[],kick_record:[],capsule_save:['text'],capsule_delete:[],feature_hint_seen:['feature'],celebration_seen:['eventId'],game_reveal:['format','choice']};
const MOODS=['good','calm','tired','anxious','unwell'];
const MOOD_LABEL={good:'Радуюсь',calm:'Спокойно',tired:'Устала',anxious:'Тревожно',unwell:'Нехорошо'};
export function pregnancyTiming(profile, day) {
  if(profile?.stage!=='pregnancy'||!profile.completedAt||!/^\d{4}-\d\d-\d\d$/.test(profile.dueDate||'')) return {week:null,days:null,day:null};
  const days=280-Math.round((Date.parse(profile.dueDate)-Date.parse(day))/DAY);
  return Number.isFinite(days)?{week:Math.max(1,Math.min(42,Math.floor(days/7))),days,day:mod(days,7)+1}:{week:null,days:null,day:null};
}
export function softStreak(active, start, current) {
  let count=0, forgiven={};
  for(let week=start;week<=current;week++) {
    if(active.includes(week)) count++;
    else if(week<current) { const tri=trimester(week); if(!forgiven[tri]) forgiven[tri]=true; else count=Math.max(0,count-1); }
  }
  return {count,forgiven};
}
export function selectRecommendations(materials, week, preferences={}, mood=null) {
  const score=m=>(m.completed?0:100)+(m.tags||[]).filter(t=>preferences.interests?.includes(t)).length*10+(['anxious','tired','unwell'].includes(mood)&&(m.tags||[]).some(t=>/забот|спокой|отдых|тревог/i.test(t))?20:0);
  const distress=['anxious','tired','unwell'].includes(mood);
  const preferred={anxious:['Эмоции','Дыхание и расслабление'],tired:['Сон','Эмоции'],unwell:['Забота']}[mood]||[];
  const safe=(materials||[]).filter(m=>m.accessible===true&&m.week<=week&&(!distress||(m.tags||[]).some(t=>preferred.includes(t)||/забот|спокой|отдых|тревог/i.test(t))));
  return [...safe.filter(m=>m.week===week).sort((a,b)=>score(b)-score(a)),...safe.filter(m=>m.week===week-1&&!m.completed).sort((a,b)=>score(b)-score(a)).slice(0,2)].map(({id,kind,week,title})=>({id,kind,week,title}));
}
function fresh() { return {preferences:{quiet:false,babyPause:false,interests:[],timezone:'Europe/Moscow'},checkins:{},surprises:{},reveals:{},surpriseCards:{},poolSeen:{},answers:{},completedQuests:[],checklists:{bag:{},doctor:{}},unlocked:{},activeWeeks:[],letters:[],capsule:null,firstKick:null,kicks:{},hintDays:{},seenHints:[],seenCelebrations:[],celebrationSessions:{}}; }
const forUser=(cfg,userId)=>typeof gamificationSettings.forGamificationUser==='function'?gamificationSettings.forGamificationUser(cfg,userId):cfg.audience?{...cfg,enabled:false}:cfg;
const enabledFlag=(s,k)=>s.features?.[k]===true;
export function createGamification({pool,service,stars,settings,catalog=loadGamificationCatalog(),notifications,clock=Date.now}={}) {
  if(!stars?.withAccount) throw new TypeError('stars.withAccount required');
  const config=async(client)=>typeof settings?.get==='function'?settings.get(client):settings||{enabled:false,features:{}};
  async function load(client,ctx,{worker=false}={}) {
    const now=nowMs(clock),day=moscow(now);
    await client.query('INSERT INTO auth_gamification_state(user_id,first_day) VALUES($1,$2) ON CONFLICT DO NOTHING',[ctx.userId,day]);
    const row=(await client.query('SELECT first_day::text AS first_day,data FROM auth_gamification_state WHERE user_id=$1 FOR UPDATE',[ctx.userId])).rows[0];
    const data={...fresh(),...row.data};data.preferences={...fresh().preferences,...data.preferences};data.seenHints||=[];for(const feature of Object.values(data.hintDays))if(!data.seenHints.includes(feature))data.seenHints.push(feature);
    const notificationPreferences=(await client.query('SELECT value FROM gamification_notification_preferences WHERE user_id=$1',[ctx.userId])).rows[0]?.value;
    if(typeof notificationPreferences?.babyPause==='boolean')data.preferences.babyPause=notificationPreferences.babyPause;
    if(typeof notificationPreferences?.timezone==='string')data.preferences.timezone=notificationPreferences.timezone;
    let firstDay=typeof row.first_day==='string'?row.first_day.slice(0,10):dateDay(row.first_day);
    const timing=pregnancyTiming(ctx.profile,day),cfg=forUser(await config(client),ctx.userId);
    const cat=typeof catalog==='function'?await catalog(ctx,client):catalog;
    const env={client,ctx,data,now,day,firstDay,age:Math.max(0,Math.round((Date.parse(day)-Date.parse(firstDay))/DAY)),cfg,cat,week:timing.week,days:timing.days,personalDay:timing.day};
    if(data.startWeek===undefined&&timing.week) data.startWeek=timing.week;
    env.enabled=cfg.enabled===true&&enabledFlag(cfg,'stars')&&ctx.pointsEnabled!==false;
    env.dailyEnabled=env.enabled&&enabledFlag(cfg,'daily');
    if(env.enabled) {
      if(!data.started) {
        await client.query('INSERT INTO auth_gamification_launch(id,launched_at) VALUES(1,$1) ON CONFLICT DO NOTHING',[new Date(now)]);
        const launch=(await client.query('SELECT launched_at FROM auth_gamification_launch WHERE id=1')).rows[0];
        const user=(await client.query('SELECT created_at FROM auth_users WHERE id=$1',[ctx.userId])).rows[0];
        const launchDay=moscow(Number(new Date(launch.launched_at))),createdDay=moscow(Number(new Date(user.created_at)));
        firstDay=[launchDay,createdDay>day?day:createdDay].sort().at(-1);
        await client.query('UPDATE auth_gamification_state SET first_day=$2 WHERE user_id=$1',[ctx.userId,firstDay]);
        data.startWeek=timing.week||undefined;env.firstDay=firstDay;env.age=Math.max(0,Math.round((Date.parse(day)-Date.parse(firstDay))/DAY));data.started=true;
      }
      const released=(await client.query('SELECT week FROM auth_stars_weeks WHERE user_id=$1 AND letter=true',[ctx.userId])).rows;
      for(const row of released)if(!data.letters.includes(row.week))data.letters.push(row.week);
      const activity=(await client.query('SELECT completed_at FROM auth_stars_material_progress WHERE user_id=$1',[ctx.userId])).rows;
      for(const row of activity) {
        const completedDay=moscow(Number(new Date(row.completed_at)));
        const activeWeek=pregnancyTiming(ctx.profile,completedDay).week;
        if(completedDay>=firstDay&&completedDay<=day&&activeWeek&&!data.activeWeeks.includes(activeWeek))data.activeWeeks.push(activeWeek);
      }
      env.weeks=(await client.query('SELECT week,completed_at,released_at,letter FROM auth_stars_weeks WHERE user_id=$1 ORDER BY week',[ctx.userId])).rows;
      const inventory=(cat.inventory||(worker?cat.materials||[]:await stars.materials?.(ctx)||cat.materials||[])).map(m=>({...m,...(cat.materials||[]).find(a=>a.accessible===true&&a.kind===m.kind&&String(a.id)===String(m.id))}));
      const progress=(await client.query('SELECT kind,material_id,week FROM auth_stars_material_progress WHERE user_id=$1',[ctx.userId])).rows;
      const purchased=(await client.query('SELECT week FROM auth_stars_week_purchases WHERE user_id=$1',[ctx.userId])).rows.map(x=>x.week);
      env.materials=inventory.map(m=>({...m,tags:m.tags||materialTags(m.title,cat.tags),accessible:m.accessible??Boolean(m.available!==false&&(m.week<=timing.week||purchased.includes(m.week)||ctx.preservedWeeks?.includes(m.week)||ctx.legacy)),completed:progress.some(p=>p.kind===m.kind&&p.material_id===String(m.id))}));
      env.weeks=Array.from({length:42},(_,i)=>i+1).map(week=>{
        const target=env.materials.filter(m=>m.week===week&&['article','video'].includes(m.kind));
        const completedCount=target.filter(m=>m.completed).length,row=env.weeks.find(w=>w.week===week);
        const locked=enabledFlag(cfg,'weekLocks')&&(!timing.week||week>timing.week)&&!purchased.includes(week)&&!ctx.preservedWeeks?.includes(week)&&!ctx.legacy;
        return {week,available:!locked,purchased:purchased.includes(week),completedCount,total:row?.completed_at?completedCount:target.length,completed:Boolean(row?.completed_at),locked,rewardPending:Boolean(row?.completed_at&&!row.released_at),letter:Boolean(row?.letter)};
      });
      const weekStart=dateDay(Date.parse(day)-((timing.day||1)-1)*DAY);
      const earned=(await client.query('SELECT COALESCE(sum(amount) FILTER(WHERE amount>0),0)::int AS amount FROM auth_points_ledger WHERE user_id=$1 AND occurred_at>=$2 AND occurred_at<=$3',[ctx.userId,new Date(Date.parse(weekStart)-3*3600000),new Date(now)])).rows[0];
      env.summary={...(env.weeks.find(w=>w.week===timing.week)||{}),earned:earned.amount,joyfulDays:Object.entries(data.checkins).filter(([d,v])=>d>=weekStart&&d<=day&&['good','calm'].includes(v.mood)).length};
      env.urgent=await urgentScreen(env,data.checkins[day]?.tags||[]);
      await advance(env);
    }
    return env;
  }
  const persist=e=>e.client.query('UPDATE auth_gamification_state SET data=$2,updated_at=$3 WHERE user_id=$1',[e.ctx.userId,e.data,new Date(e.now)]);
  const allowed=(e,item)=>isPublished(item,e.cfg);
  const babyVisible=e=>!e.data.preferences.babyPause&&e.ctx.profile?.stage!=='mother';
  const live=e=>e.dailyEnabled&&e.week&&e.ctx.profile?.stage!=='mother';
  function features(e) {
    const result={};
    for(const f of e.cat.features||[]) {
      const base=['week_ring','ai_limit','peek_next_week','poll'].includes(f.id)?e.enabled&&e.week&&e.ctx.profile?.stage!=='mother':live(e);
      const stage=base&&e.week>=f.minWeek&&e.week<=f.maxWeek&&e.age>=f.minDays;
      const flag=f.id==='myth'?'myths':f.id==='quests'?'quests':f.id==='time_capsule'?'capsule':f.novelty?'games':null;
      result[f.id]=Boolean((stage||f.novelty&&e.data.unlocked[f.id]!==undefined&&live(e))&&(!flag||enabledFlag(e.cfg,flag))&&(!f.novelty||e.data.unlocked[f.id]!==undefined));
    }
    if(e.enabled&&e.data.capsule&&!e.data.preferences.babyPause)result.time_capsule=true;
    if(e.week<22||e.week>36)result.guess_size=false;
    if(e.week>40)result.streak=false;
    if(!babyVisible(e)) for(const key of ['first_kick','kicks_daily','guess_size']) result[key]=false;
    return result;
  }
  async function advance(e) {
    if(e.week) {
      e.data.lastWeek=e.week;
      const candidates=(e.cat.features||[]).filter(f=>f.novelty&&e.age>=f.minDays&&e.week>=f.minWeek&&e.week<=f.maxWeek&&e.data.unlocked[f.id]===undefined).sort((a,b)=>a.priority-b.priority);
      const last=e.data.lastNoveltyDay;
      if(live(e)&&e.week<37&&candidates.length&&(last===undefined||e.age-last>=3)&&enabledFlag(e.cfg,'games')) {
        const f=candidates[0]; if(f.id!=='time_capsule'||enabledFlag(e.cfg,'capsule')) {e.data.unlocked[f.id]=e.age;e.data.lastNoveltyDay=e.age;}
      }
      if(live(e)&&e.week===40&&!e.data.letters.includes(40)) e.data.letters.push(40);
      if(live(e)&&babyVisible(e)&&notifications?.enqueue) {
        if(e.data.notifiedWeek!==e.week) {await enqueue(e,`new-week-${e.week}`,'new_week',`Началась ${e.week}-я неделя`);e.data.notifiedWeek=e.week;}
        const availableQuests=quests(e).filter(q=>!q.done);
        if(availableQuests[0])await enqueue(e,`quest-${availableQuests[0].id}`,'quest','Для тебя есть актуальное дело');
        const current=e.weeks?.find(w=>w.week===e.week);
        if(current?.total&&current.completedCount/current.total>=.8&&current.completedCount<current.total)await enqueue(e,`almost-${e.week}`,'week_almost','Неделя почти завершена');
        if(features(e).checkin)await enqueue(e,`daily-${e.day}`,'daily','Как ты сегодня?');
      }
    }
    const cap=e.data.capsule, birth=e.ctx.profile?.birthDate;
    if(cap&&!cap.opened&&e.ctx.profile?.stage==='mother'&&birth&&!e.data.preferences.babyPause&&!e.data.preferences.quiet) {
      const b=new Date(birth+'T00:00:00Z'); const targetMonth=b.getUTCMonth()+1;
      const open=new Date(Date.UTC(b.getUTCFullYear(),targetMonth,1));
      const max=new Date(Date.UTC(open.getUTCFullYear(),open.getUTCMonth()+1,0)).getUTCDate();
      open.setUTCDate(Math.min(b.getUTCDate(),max));
      if(Number.isFinite(+open)&&e.day>=dateDay(open)) {cap.opened=e.day;await enqueue(e,'capsule','capsule','Твоё письмо ждёт тебя',{babyRelated:false});}
    }
  }
  async function credit(e,code,ref,amount,capped) {
    const key={checkin:'checkin',surprise:'surprise',myth_answer:'mythAnswer',myth_correct:'mythCorrect',quest:'quest',first_kick:'firstKick',kicks:'kicks',capsule:'capsule',trimester:'trimester'}[code]||code;
    const result=await stars.credit(e.client,e.ctx,{code,ref,amount:e.cfg.rewards?.[key]??amount,capped,metadata:{week:e.week}});
    return result.duplicate?{...result,previousAmount:result.actualAmount,actualAmount:0}:result;
  }
  async function enqueue(e,key,type,title,extra={}) {
    if(notifications?.enqueue&&!e.data.preferences.babyPause&&!e.data.preferences.quiet) await notifications.enqueue(e.client,{userId:e.ctx.userId,key,type,title,body:'',url:'/profile.html',babyRelated:true,medical:false,...extra});
  }
  function questions(e) {
    if(!features(e).myth||!babyVisible(e)||e.week>40) return [];
    const published=(e.cat.questions||[]).filter(q=>allowed(e,q)&&q.week===e.week);
    const guess=features(e).guess_size&&allowed(e,e.cat.weekly?.[e.week])?guessQuestion(e.cat.weekly[e.week]):null;
    const schedule=guess?[[1,1],[3,'guess'],[5,3],[7,2]]:[[1,1],[3,2],[5,3]];
    const assigned=[];
    for(const [day,slot] of schedule) {
      if(day>e.personalDay) continue;
      const key=`${e.week}-${day}`;
      e.data.assigned||={};
      let q=e.data.assigned[key] ? [...(e.cat.questions||[]),...(guess?[guess]:[])].find(q=>q.id===e.data.assigned[key]) : null;
      if(!q) {
        const used=new Set(Object.values(e.data.assigned));
        const promptKey=q=>q.prompt.trim().toLocaleLowerCase('ru').replace(/[?!.,«»]/g,'');
        const answeredPrompts=new Set((e.cat.questions||[]).filter(x=>e.data.answers[x.id]||used.has(x.id)).map(promptKey));
        const freshQuestion=q=>!used.has(q.id)&&!e.data.answers[q.id]&&!answeredPrompts.has(promptKey(q));
        q=slot==='guess'?guess:published.find(q=>q.slot===slot&&freshQuestion(q));
        if(!q&&slot!=='guess') q=(e.cat.questions||[]).find(q=>q.week<=e.week&&trimester(q.week)===trimester(e.week)&&allowed(e,q)&&freshQuestion(q));
        if(q) e.data.assigned[key]=q.id;
      }
      if(q&&allowed(e,q)) assigned.push({day,q});
    }
    return assigned;
  }
  function publicQuestion(e,q) { const answered=e.data.answers[q.id],article=(e.materials||[]).find(m=>m.kind==='article'&&m.id===q.articleId&&m.accessible===true&&m.week<=e.week);return {id:q.id,kind:q.kind,week:q.week,prompt:q.prompt,options:q.options,answered:Boolean(answered),...(answered?{answer:q.answer,explanation:q.explanation,selected:answered.answer,correct:answered.correct,article:article?{id:article.id,kind:'article',week:article.week}:null}:{})}; }
  function poolCard(e,pool,items) {
    if(!items.length)return null;
    const opened=e.data.surpriseCards?.[e.day];
    const old=opened?.pool===pool?items.find(x=>x.id===opened.id):null;
    const unseen=items.filter(x=>!(e.data.poolSeen?.[pool]||[]).includes(x.id));
    const candidates=unseen.length?unseen:items;
    const selected=old||candidates[mod(Math.floor(Date.parse(e.day)/DAY),candidates.length)];
    return {id:selected.id,text:selected.text,pool};
  }
  function care(e) {
    const tri=['I','II','III'][trimester(e.week||1)-1];
    return poolCard(e,'care-'+tri,(e.cat.care||[]).filter(x=>allowed(e,x)&&(!e.data.preferences.babyPause||x.babyRelated===false)&&(!x.trimester||x.trimester==='Все'||x.trimester===tri)));
  }
  function surprise(e) {
    if(!features(e).surprise_tap||!babyVisible(e)||e.week>40) return null;
    const mood=e.data.checkins[e.day]?.mood;
    if(['tired','anxious','unwell'].includes(mood)) return care(e);
    const w=e.cat.weekly?.[e.week],sentences=(s,n)=>String(s||'').split(/(?<=[.!?])\s+/).slice(0,n).join(' ');
    if([1,3,5].includes(e.personalDay)) {
      if(!allowed(e,w))return care(e);
      const text=e.personalDay===1?[w.baby||sentences(w.development,1),w.measurements].filter(Boolean).join(' · '):e.personalDay===3?[w.momTitle,sentences(w.mom,1)].filter(Boolean).join('. '):sentences(w.development,2);
      return text?{id:`${w.id}-${e.personalDay}`,text}:care(e);
    }
    if(e.personalDay===4) {
      const items=(e.cat.ideas||[]).filter(x=>allowed(e,x)&&(!x.minWeek||e.week>=x.minWeek)&&(!x.maxWeek||e.week<=x.maxWeek)&&(!(e.data.poolSeen?.ideas||[]).includes(x.id)||e.data.surpriseCards?.[e.day]?.id===x.id));
      return poolCard(e,'ideas',items)||care(e);
    }
    if(e.personalDay===6) {
      const video=(e.materials||[]).find(m=>m.kind==='video'&&m.week===e.week&&m.accessible&&/упражнен|самомассаж|массаж|практик|дыхан|дышать|расслабл|разминк|растяжк|движен|подвижност|выдох|точки/i.test(m.title||''));
      if(video)return {id:`practice-video-${video.id}`,text:video.title,material:{id:video.id,kind:video.kind,week:video.week}};
      return poolCard(e,'practices',(e.cat.practices||[]).filter(x=>allowed(e,x)))||care(e);
    }
    if(e.personalDay===7) {
      const s=e.summary||{};
      return {id:`summary-${e.week}`,text:`За эту неделю: ${s.completedCount||0} из ${s.total||0} материалов${s.joyfulDays?`, ${s.joyfulDays} спокойных и радостных дней`:''}, +${s.earned||0} ★.`,summary:s};
    }
    return care(e);
  }
  function publicLetters(e) {
    if(!e.enabled||e.data.preferences.babyPause) return [];
    return (e.cat.letters||[]).filter(x=>e.data.letters.includes(x.week)&&allowed(e,x)).map(({week,text})=>({week,text}));
  }
  function quests(e) {
    if(!features(e).quests||!babyVisible(e)) return [];
    return (e.cat.quests||[]).filter(q=>allowed(e,q)&&q.week>=e.data.startWeek-3&&e.week>=q.week&&e.week<=q.week+3&&!q.conditional).map(q=>({id:q.id,week:q.week,type:q.type,title:q.title,text:q.text,done:e.data.completedQuests.includes(q.id),personalRecord:true}));
  }
  function checklist(e,list) {
    if(!features(e)[list==='bag'?'bag_checklist':'birth_questions']||!babyVisible(e)) return [];
    return (e.cat.checklists?.[list]||[]).filter(x=>allowed(e,x)).map(x=>({id:x.id,text:x.text,conditional:x.conditional,status:e.data.checklists[list][x.id]?.status||'todo',note:e.data.checklists[list][x.id]?.note||''}));
  }
  async function urgentScreen(e,tags) {
    if(!tags.length||!e.cfg.medicalApproved||e.ctx.profile?.stage!=='pregnancy')return null;
    const row=(await e.client.query("SELECT * FROM gamification_content WHERE id='urgent-help' AND status='approved'")).rows[0];
    const paragraphs=row?.body?.paragraphs;
    if(!row?.medical||!row.approved_by||!row.approved_at||!row.evidence||!Array.isArray(paragraphs)||![2586,2587,2588,2589,2594,2596,2598,2600,2602,2604,2606,2607].every(id=>paragraphs.some(p=>p.paragraph===id&&typeof p.text==='string'&&p.text.trim())))return null;
    if(!matchesUrgent('',paragraphs,tags))return null;
    const at=id=>paragraphs.find(p=>p.paragraph===id).text;
    return {contentId:row.id,revision:row.revision,title:at(2586),body:at(2587),reassurance:at(2588),actions:[{type:'call',label:'Позвонить 103',href:'tel:103'},{type:'continue',label:'Вернуться к приложению'}],free:true};
  }
  function hint(e) {
    if(!e.enabled||e.data.hintDays[e.day])return null;
    const f=features(e);
    const item=(e.cat.hints||[]).find(h=>allowed(e,h)&&f[h.feature]&&!e.data.seenHints.includes(h.feature)&&(!h.babyRelated||babyVisible(e))&&(h.feature!=='peek_next_week'||enabledFlag(e.cfg,'peekNextWeek'))&&(h.feature!=='time_capsule'||!e.data.capsule)&&(h.feature!=='first_kick'||!e.data.firstKick));
    return item?{id:item.id,feature:item.feature,text:hintText(e,item)}:null;
  }
  function hintText(e,item) {
    let text=item.text;
    if(item.feature==='week_ring')text=text.replace('6 материалов недели','все материалы недели').replace(/\+50\s*★/u,`+${e.cfg.rewards?.weekComplete??50} ★`);
    if(item.feature==='checkin')text=text.replace(/\+5\s*★/u,`+${e.cfg.rewards?.checkin??5} ★`);
    if(item.feature==='kicks_daily')text=text.replace(/\+5\s*★/u,`+${e.cfg.rewards?.kicks??5} ★`);
    if(item.feature==='quests')text=text.replace(/\+15\s*★/u,`+${e.cfg.rewards?.quest??15} ★`);
    if(item.feature==='peek_next_week')text=text.replace(/100\s*★/u,`${e.cfg.prices?.peekNextWeek??100} ★`);
    return text;
  }
  function celebration(e,row) {
    if(!row||e.data.seenCelebrations.includes(String(row.id)))return null;
    const common={eventId:String(row.id),kind:row.event_code};
    if(row.event_code==='welcome')return {...common,title:'Рады видеть тебя!',body:`Начислено ${row.amount} ★ за знакомство.`};
    if(!babyVisible(e))return null;
    if(row.event_code==='week_complete'&&/^(?:[1-9]|[1-3][0-9]|4[0-2])$/.test(row.event_ref))return {...common,title:`Неделя ${row.event_ref} завершена`,body:`Изучены все материалы недели. Начислено ${row.amount} ★.`};
    if(row.event_code==='trimester_complete'&&['14','28'].includes(row.event_ref))return {...common,title:'Триместр завершён',body:`Начислено ${row.amount} ★ за завершение триместра.`};
    return null;
  }
  async function presentation(e) {
    if(!e.enabled)return {hint:null,celebration:null};
    let event=null;
    if(e.ctx.sessionHash&&!e.data.celebrationSessions[e.ctx.sessionHash]) {
      const rows=(await e.client.query("SELECT id,event_code,event_ref,amount FROM auth_points_ledger WHERE user_id=$1 AND event_code IN ('welcome','week_complete','trimester_complete') ORDER BY occurred_at,id",[e.ctx.userId])).rows;
      event=rows.map(row=>celebration(e,row)).find(Boolean)||null;
    }
    return {hint:hint(e),celebration:event};
  }
  async function view(e) {
    const qs=questions(e), q=qs.find(x=>x.day===e.personalDay)?.q;
    const mood=e.data.checkins[e.day]?.mood;
    const reply=(e.cat.replies||[]).find(x=>(!e.data.preferences.babyPause||x.babyRelated===false)&&x.mood===MOOD_LABEL[mood]&&x.trimester===['I','II','III'][trimester(e.week||1)-1]&&allowed(e,x));
    const cap=e.data.capsule;
    return {accountId:e.ctx.userId,presentation:await presentation(e),enabled:e.enabled,dailyEnabled:e.dailyEnabled,tier:e.ctx.tier,currentWeek:e.week,pregnancyDay:e.days,wallet:await stars.wallet(e.client,e.ctx),today:e.dailyEnabled?{day:e.personalDay,urgent:e.urgent||null,checkin:e.data.checkins[e.day]||null,reply:reply?.text||null,surprise:surprise(e),surpriseOpened:Boolean(e.data.surprises[e.day]),reveal:e.data.reveals?.[e.day]||null,question:q?publicQuestion(e,q):null,questions:qs.map(x=>publicQuestion(e,x.q)),care:(e.week>40||e.data.preferences.babyPause||['anxious','tired','unwell'].includes(mood))?(care(e)?.text||null):null,offerCourse:live(e)&&!e.data.preferences.babyPause&&!['anxious','unwell'].includes(mood),recommendations:live(e)&&babyVisible(e)?selectRecommendations(e.materials||e.cat.materials,e.week,e.data.preferences,mood):[]}:null,weeks:e.weeks||[],features:features(e),preferences:{...e.data.preferences,postpartum:e.ctx.profile?.stage==='mother',birthDate:e.ctx.profile?.birthDate||null},letters:publicLetters(e),quests:quests(e),checklists:{bag:checklist(e,'bag'),doctor:checklist(e,'doctor')},capsule:{saved:Boolean(cap),opened:Boolean(cap?.opened)&&!e.data.preferences.babyPause,...(cap?.opened&&!e.data.preferences.babyPause?{text:cap.text}:{})},streak:softStreak(e.data.activeWeeks,e.data.startWeek||e.week||1,e.week||1),settings:{features:{peekNextWeek:features(e).peek_next_week&&enabledFlag(e.cfg,'peekNextWeek'),aiPacks:enabledFlag(e.cfg,'aiPacks')&&e.cfg.aiBudgetApproved===true,capsule:features(e).time_capsule===true},rewards:e.cfg.rewards||{},limits:e.cfg.limits||{},prices:e.cfg.prices||{},ai:e.cfg.ai||{},medicalApproved:e.cfg.medicalApproved===true,medicalContentAvailable:e.cfg.medicalApproved===true,aiBudgetApproved:e.cfg.aiBudgetApproved===true},firstKick:e.data.preferences.babyPause?null:e.data.firstKick,kicks:e.data.kicks[e.day]||null};
  }
  async function state(token,account) { return stars.withAccount(token,account,async(client,ctx)=>{
    const e=await load(client,ctx);
    if(e.enabled) {
      const table=(await client.query("SELECT to_regclass('auth_gamification_visits') AS name")).rows[0];
      if(table?.name)await client.query('INSERT INTO auth_gamification_visits(user_id,moscow_day) VALUES($1,$2) ON CONFLICT DO NOTHING',[ctx.userId,e.day]);
      if(notifications)await client.query('INSERT INTO gamification_notification_preferences(user_id,last_visit_at) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET last_visit_at=EXCLUDED.last_visit_at',[ctx.userId,new Date(e.now)]);
    }
    const result=await view(e);await persist(e);return result;
  }); }
  async function letters(token,account) { return stars.withAccount(token,account,async(client,ctx)=>{const e=await load(client,ctx);await persist(e);return {accountId:ctx.userId,letters:publicLetters(e)};}); }
  async function preferences(token,account,body) {
    if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['quiet','babyPause','interests','timezone'].includes(k))) throw invalid();
    for(const k of ['quiet','babyPause']) if(body[k]!==undefined&&typeof body[k]!=='boolean') throw invalid();
    if(body.interests!==undefined&&(!Array.isArray(body.interests)||body.interests.length>12||body.interests.some(x=>typeof x!=='string'||x.length>80))) throw invalid();
    if(body.timezone!==undefined) {if(typeof body.timezone!=='string'||body.timezone.length>80)throw invalid();try{new Intl.DateTimeFormat('en',{timeZone:body.timezone});}catch{throw invalid();}}
    return stars.withAccount(token,account,async(client,ctx)=>{
      const e=await load(client,ctx),wasQuiet=e.data.preferences.quiet;
      Object.assign(e.data.preferences,body);
      if(notifications?.syncPreferences) {
        const patch={userId:ctx.userId,babyPause:e.data.preferences.babyPause,timezone:e.data.preferences.timezone};
        if(e.data.preferences.quiet!==wasQuiet) {
          const keys=['new_week','capsule','quest','poll_results','week_almost','daily','feature','celebration'];
          if(e.data.preferences.quiet) {
            const row=(await client.query('SELECT value FROM gamification_notification_preferences WHERE user_id=$1',[ctx.userId])).rows[0];
            e.data.notificationTypesBeforeQuiet=Object.fromEntries(keys.map(k=>[k,row?.value?.types?.[k]!==false]));
            patch.types=Object.fromEntries(keys.map(k=>[k,false]));
          } else {patch.types=e.data.notificationTypesBeforeQuiet||Object.fromEntries(keys.map(k=>[k,true]));delete e.data.notificationTypesBeforeQuiet;}
        }
        await notifications.syncPreferences(client,patch);
      }
      await advance(e);const result=await view(e);await persist(e);return result;
    });
  }
  async function action(token,account,body) {
    if(!body||typeof body.type!=='string'||typeof body.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId)) throw invalid();
    if(!Object.hasOwn(ACTION_FIELDS,body.type)||Object.keys(body).some(key=>!['type','requestId',...ACTION_FIELDS[body.type]].includes(key)))throw invalid();
    return stars.withAccount(token,account,async(client,ctx)=>{
      const e=await load(client,ctx);
      const previous=(await client.query('SELECT payload,result FROM auth_gamification_actions WHERE user_id=$1 AND request_id=$2',[ctx.userId,body.requestId])).rows[0];
      if(previous) {
        const a=JSON.stringify(Object.entries(previous.payload).sort()),b=JSON.stringify(Object.entries(JSON.parse(JSON.stringify(payloadFor(body)))).sort());
        if(a!==b)throw new AuthError(409,'request_conflict','Повтор действия отличается.');
        const restored={...previous.result};
        if(body.type==='checkin')restored.result=e.urgent?{urgent:e.urgent}:null;
        if(body.type==='myth_answer') {const current=questions(e).find(x=>x.q.id===body.questionId)?.q;restored.result=current?publicQuestion(e,current):null;}
        if(['surprise','game_reveal'].includes(body.type)) {const card=surprise(e);restored.result=card?{card}:null;}
        const state=await view(e);await persist(e);
        return {...restored,state,duplicate:true};
      }
      if(!e.enabled) throw unavailable();
      const f=features(e);let reward=null,result=null;
      const requireFeature=id=>{if(!f[id]) throw unavailable();};
      switch(body.type) {
        case 'checkin':
          requireFeature('checkin');if(!MOODS.includes(body.mood)||body.tags!==undefined&&(!Array.isArray(body.tags)||body.tags.length>4||body.tags.some(t=>!['кровь','сильная боль','малыш затих','подтекание'].includes(t)))) throw invalid();
          e.data.checkins[e.day]={mood:body.mood,...(body.tags?{tags:[...new Set(body.tags)]}:{})};e.urgent=await urgentScreen(e,body.tags||[]);result=e.urgent?{urgent:e.urgent}:null;if(!e.data.activeWeeks.includes(e.week))e.data.activeWeeks.push(e.week);
          reward=await credit(e,'checkin',e.day,5,true);break;
        case 'surprise': case 'game_reveal': {
          requireFeature('surprise_tap');const card=surprise(e);if(!card) throw unavailable();
          if(body.type==='game_reveal') {const feature={scratch:'surprise_scratch',flip:'surprise_flip',choose:'surprise_pick3'}[body.format];if(!feature)throw invalid();requireFeature(feature);if(body.format==='choose'&&![0,1,2].includes(body.choice))throw invalid();e.data.reveals||={};e.data.reveals[e.day]||={format:body.format,...(body.format==='choose'?{choice:body.choice}:{})};}
          e.data.surprises[e.day]=true;
          if(card.pool&&e.data.surpriseCards?.[e.day]?.id!==card.id) {
            e.data.poolSeen||={};e.data.surpriseCards||={};
            if(e.data.poolSeen[card.pool]?.includes(card.id))e.data.poolSeen[card.pool]=[];
            e.data.poolSeen[card.pool]||=[];e.data.poolSeen[card.pool].push(card.id);
            e.data.surpriseCards[e.day]={id:card.id,pool:card.pool};
          }
          result={card};reward=await credit(e,'surprise',e.day,5,true);break;
        }
        case 'myth_answer': {
          requireFeature('myth');const q=questions(e).find(x=>x.q.id===body.questionId)?.q;if(!q||!Number.isInteger(body.answer)||body.answer<0||body.answer>=q.options.length) throw invalid();
          const old=e.data.answers[q.id];if(!old) {const correct=body.answer===q.answer;e.data.answers[q.id]={answer:body.answer,correct};const a=await credit(e,'myth_answer',q.id,5,true);const b=correct?await credit(e,'myth_correct',q.id,5,true):null;reward={actualAmount:a.actualAmount+(b?.actualAmount||0),balance:b?.balance??a.balance};}result=publicQuestion(e,q);break;
        }
        case 'quest_done': {
          requireFeature('quests');const q=quests(e).find(x=>x.id===body.questId);if(!q) throw unavailable();if(q.type==='bag')throw new AuthError(409,'checklist_required','Отметьте пункты списка.');
          if(!e.data.completedQuests.includes(q.id))e.data.completedQuests.push(q.id);reward=await credit(e,'quest',q.id,15,false);break;
        }
        case 'checklist_update': {
          if(!['bag','doctor'].includes(body.list))throw invalid();const items=checklist(e,body.list),item=items.find(x=>x.id===body.itemId);if(!item)throw unavailable();
          if(!['todo','done','na'].includes(body.status)||body.status==='na'&&!item.conditional||body.note!==undefined&&(typeof body.note!=='string'||[...body.note].length>2000))throw invalid();
          e.data.checklists[body.list][item.id]={status:body.status,note:body.note||''};
          if(body.list==='bag') {const updated=checklist(e,'bag').filter(x=>x.status!=='na'),done=updated.filter(x=>x.status==='done').length;if(updated.length&&done/updated.length>=.8) {reward=await credit(e,'quest','bag',15,false);for(const q of e.cat.quests||[])if(q.type==='bag'&&!e.data.completedQuests.includes(q.id))e.data.completedQuests.push(q.id);}}break;
        }
        case 'first_kick':requireFeature('first_kick');e.data.firstKick||=e.day;reward=await credit(e,'first_kick','first',15,false);break;
        case 'kick_record':requireFeature('kicks_daily');e.data.kicks[e.day]=true;reward=await credit(e,'kicks',e.day,5,true);break;
        case 'capsule_save':
          requireFeature('time_capsule');if(!babyVisible(e)||e.data.capsule||typeof body.text!=='string'||!body.text.trim()||[...body.text].length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body.text))throw invalid();
          e.data.capsule={text:body.text.trim(),saved:e.day,opened:null};reward=await credit(e,'capsule','one',15,false);break;
        case 'capsule_delete':if(!e.data.capsule||e.data.capsule.opened)throw unavailable();e.data.capsule=null;break;
        case 'feature_hint_seen': {
          if(e.data.seenHints.includes(body.feature)||e.data.hintDays[e.day]) {result={shown:false};break;}
          const current=hint(e);if(!current||current.feature!==body.feature)throw unavailable();
          e.data.seenHints.push(body.feature);e.data.hintDays[e.day]=body.feature;result={shown:true};break;
        }
        case 'celebration_seen': {
          if(typeof body.eventId!=='string'||!/^[1-9]\d{0,18}$/.test(body.eventId)||BigInt(body.eventId)>9223372036854775807n)throw invalid();
          const row=(await client.query("SELECT id,event_code,event_ref,amount FROM auth_points_ledger WHERE user_id=$1 AND id=$2 AND event_code IN ('welcome','week_complete','trimester_complete')",[ctx.userId,body.eventId])).rows[0];
          if(!row)throw unavailable();
          if(!ctx.sessionHash||e.data.celebrationSessions[ctx.sessionHash]||e.data.seenCelebrations.includes(body.eventId)){result={shown:false};break;}
          if(!celebration(e,row))throw unavailable();
          e.data.seenCelebrations.push(body.eventId);e.data.celebrationSessions[ctx.sessionHash]=body.eventId;result={shown:true};break;
        }
        default:throw invalid();
      }
      const state=await view(e);await persist(e);const response={ok:true,reward,result};
      await client.query('INSERT INTO auth_gamification_actions(user_id,request_id,payload,result,created_at) VALUES($1,$2,$3,$4,$5)',[ctx.userId,body.requestId,payloadFor(body),response,new Date(e.now)]);
      return {...response,state};
    });
  }
  async function notifyMaterialComplete(client,ctx,{week,weekComplete=false}) {
    const e=await load(client,ctx);if(e.week&&!e.data.activeWeeks.includes(e.week))e.data.activeWeeks.push(e.week);
    if(weekComplete&&week<=e.week&&!e.data.letters.includes(week))e.data.letters.push(week);
    await persist(e);
  }
  async function scheduleNotifications({limit=100,afterUserId=null}={}) {
    if(!pool||!notifications?.enqueue)return {processed:0,nextCursor:null};
    if(!Number.isInteger(limit)||limit<1||limit>500||afterUserId!==null&&!/^[a-f0-9-]{36}$/i.test(afterUserId))throw invalid();
    const cfg=await config(pool);
    if(!cfg.enabled||!enabledFlag(cfg,'daily')||!enabledFlag(cfg,'notifications'))return {processed:0,nextCursor:null};
    // Only already enrolled, explicitly opted-in accounts. No remote course checks.
    const {rows}=await pool.query(`SELECT g.user_id FROM auth_gamification_state g
      JOIN gamification_notification_preferences n ON n.user_id=g.user_id
      WHERE n.value->>'pushEnabled'='true'
      AND COALESCE(g.data->'preferences'->>'babyPause','false')<>'true'
      AND COALESCE(g.data->'preferences'->>'quiet','false')<>'true'
      AND ($1::uuid IS NULL OR g.user_id>$1::uuid)
      ORDER BY g.user_id LIMIT $2`,[afterUserId,limit]);
    let processed=0;
    for(const row of rows)await transaction(pool,async client=>{
      // Same lock order as stars.withAccount; no balance operations or session impersonation.
      const user=(await client.query('SELECT profile FROM auth_users WHERE id=$1 FOR UPDATE',[row.user_id])).rows[0];
      if(!user)return;
      await client.query('SELECT pg_advisory_xact_lock($1::int,hashtext($2))',[0x504f494e,row.user_id]);
      const wallet=(await client.query('SELECT legacy FROM auth_stars_wallet WHERE user_id=$1 FOR UPDATE',[row.user_id])).rows[0];
      if(!wallet)return;
      const now=nowMs(clock),day=moscow(now);
      const userSettings=forUser(cfg,row.user_id);if(!userSettings.enabled)return;
      const ctx={userId:row.user_id,profile:user.profile||{},currentWeek:pregnancyTiming(user.profile,day).week,moscowDay:day,now:new Date(now),tier:'free',legacy:wallet.legacy,pointsEnabled:enabledFlag(userSettings,'stars'),settings:userSettings};
      const e=await load(client,ctx,{worker:true});
      await persist(e);processed++;
    });
    return {processed,nextCursor:rows.length===limit?rows.at(-1).user_id:null};
  }
  return {state,action,preferences,letters,notifyMaterialComplete,scheduleNotifications};
}
