import { readFile } from 'node:fs/promises';
import { AuthError, hashToken, isUuid } from './security.mjs';
import { transaction } from './store.mjs';
import { mergeSettings, validateSettingsPatch } from './gamification-settings.mjs';
const bad = message => new AuthError(400,'invalid_gamification_content',message);
function text(value,max) { if(typeof value !== 'string' || !value.trim() || value.length>max || value.includes('\0')) throw bad('Проверьте текст и основание изменения.'); return value.trim(); }
// Exact-day return, only cohorts whose whole observation window has elapsed.
export function retentionMetrics(visits,today) {
  const dates=new Map();
  for(const row of visits) {const day=String(row.moscow_day instanceof Date?row.moscow_day.toISOString():row.moscow_day).slice(0,10);if(day>today)continue; if(!dates.has(row.user_id))dates.set(row.user_id,new Set());dates.get(row.user_id).add(day);}
  return Object.fromEntries([1,7,30].map(n=>{
    let eligible=0,returned=0;
    for(const days of dates.values()) {const first=[...days].sort()[0],target=new Date(Date.parse(first)+n*86400000).toISOString().slice(0,10);if(target>today)continue;eligible++;if(days.has(target))returned++;}
    return ['D'+n,{eligible,returned,rate:eligible?returned/eligible:null,insufficientData:eligible===0}];
  }));
}
export function createGamificationAdmin({pool,admin,settings,clock=Date.now}) {
  async function owner(token,account) {
    const user = await admin.session(token,account);
    if(!account || user.id !== account) throw new AuthError(409,'account_changed','Аккаунт изменился.');
    if(user.role !== 'owner') throw new AuthError(403,'admin_forbidden','Изменять звёздочки может только владелец школы.');
    return user;
  }
  async function write(token,account,run,lockUserId) {
    const user=await owner(token,account);
    return transaction(pool, async client => {
      if(isUuid(lockUserId))await client.query('SELECT id FROM auth_users WHERE id=$1 FOR UPDATE',[lockUserId]);
      // Serialize owner mutations and establish a stable settings/approval revision.
      await client.query('SELECT id FROM gamification_settings WHERE id=1 FOR UPDATE');
      // Recheck session under lock so a revoked session cannot finish a queued mutation.
      const valid=await client.query('SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',[hashToken(token),user.id]);
      if(!valid.rows.length) throw new AuthError(401,'sign_in_required','Войдите по email.');
      return run(client,user);
    });
  }
  async function audit(client,user,action,target,before,after,reason) {
    await client.query(`INSERT INTO gamification_audit(actor_id,action,target,before_value,after_value,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [user.id,action,target,JSON.stringify(before ?? null),JSON.stringify(after ?? null),reason,new Date(clock())]);
  }
  return {
    async state(token,account) {
      await owner(token,account);
      const base=JSON.parse(await readFile(new URL('./gamification-catalog.json',import.meta.url),'utf8'));
      const drafts=new Map();
      function walk(value,kind) {
        if(Array.isArray(value)) {for(const item of value)walk(item,kind);return;}
        if(!value||typeof value!=='object')return;
        if(value.id && kind!=='features' && kind!=='materials') {drafts.set(value.id,{id:value.id,kind,body:value,medical:value.medical!==false,revision:0,status:'draft'});return;}
        for(const [key,item] of Object.entries(value))walk(item,kind||key);
      }
      walk(base,'');
      const source=JSON.parse(await readFile(new URL('../content/gamification-source.json',import.meta.url),'utf8'));
      drafts.set('urgent-help',{id:'urgent-help',kind:'urgent_help',body:{paragraphs:source.urgent_help_source},medical:true,revision:0,status:'draft'});
      for(const row of (await pool.query('SELECT * FROM gamification_content ORDER BY kind,id')).rows)drafts.set(row.id,row);
      const config=await settings.get();
      const accounts=(await pool.query("SELECT id,profile->>'name' AS name,email FROM auth_users ORDER BY (id=ANY($1::uuid[])) DESC,lower(email),id LIMIT 5000",[config.audience.userIds])).rows;
      return {settings:config,accounts,accountsLimit:5000,content:[...drafts.values()],legacyReviews:(await pool.query('SELECT user_id,created_at,preserved_weeks FROM auth_stars_wallet WHERE legacy=true ORDER BY created_at,user_id LIMIT 200')).rows};
    },
    async history(token,account) { await owner(token,account); return (await pool.query('SELECT * FROM gamification_audit ORDER BY id DESC LIMIT 200')).rows; },
    updateSettings:(token,account,{patch,reason}={}) => write(token,account,async (client,user) => {
      validateSettingsPatch(patch); reason=text(reason,1000);
      if(patch.audience?.userIds?.length) {const {rows}=await client.query('SELECT id FROM auth_users WHERE id=ANY($1::uuid[])',[patch.audience.userIds]);if(rows.length!==patch.audience.userIds.length)throw bad('Выберите существующие аккаунты из списка.');}
      const {rows:[row]}=await client.query('SELECT value FROM gamification_settings WHERE id=1');
      const before=mergeSettings(row.value), after=structuredClone(before);
      for(const [group,value] of Object.entries(patch)) after[group]=group==='enabled'?value:{...after[group],...value};
      await client.query('UPDATE gamification_settings SET value=$1,updated_at=$2 WHERE id=1',[JSON.stringify(after),new Date(clock())]);
      await audit(client,user,'settings','settings',before,after,reason); return settings.get(client);
    }),
    saveContent:(token,account,data={}) => write(token,account,async(client,user) => {
      const id=text(data.id,180),kind=text(data.kind,60);
      if(!/^[a-zA-Z0-9_.:-]+$/.test(id) || !/^[a-z_]+$/.test(kind)) throw bad('Проверьте идентификатор.');
      if(!data.body || typeof data.body!=='object' || Array.isArray(data.body) || JSON.stringify(data.body).length>50000) throw bad('Проверьте содержание карточки.');
      const {rows:[before]}=await client.query('SELECT * FROM gamification_content WHERE id=$1 FOR UPDATE',[id]);
      if((before ? before.revision : 0)!==data.revision) throw new AuthError(409,'content_changed','Текст уже изменён. Обновите страницу.');
      const base=JSON.parse(await readFile(new URL('./gamification-catalog.json',import.meta.url),'utf8'));
      let source;if(id==='urgent-help'){const original=JSON.parse(await readFile(new URL('../content/gamification-source.json',import.meta.url),'utf8'));source={paragraphs:original.urgent_help_source,medical:true};}
      const find=value=>{if(!value||typeof value!=='object')return;if(value.id===id)source=value;else for(const item of Object.values(value))find(item);};find(base);
      const medical=data.medical === undefined ? true : data.medical;
      if(typeof medical!=='boolean' || (before?.medical || source?.medical!==false && source) && !medical) throw bad('Медицинский статус существующего текста нельзя снять.');
      if(id==='urgent-help' && (!Array.isArray(data.body.paragraphs)||data.body.paragraphs.length!==source.paragraphs.length||new Set(data.body.paragraphs.map(x=>x.paragraph)).size!==source.paragraphs.length||!source.paragraphs.every(p=>data.body.paragraphs.some(x=>x.paragraph===p.paragraph&&x.style===p.style&&typeof x.text==='string'&&x.text.trim()))))throw bad('Сохраните все исходные пункты срочной помощи.');
      if(source) {
        for(const key of ['id','week','slot','kind','source','source_id','sourceId','source_paragraph','source_hash','style'])if(Object.hasOwn(source,key)&&data.body[key]!==source[key])throw bad('Идентификатор и привязку исходного материала нельзя менять.');
        for(const [key,value] of Object.entries(source))if(!['status','medical','medicalApproved'].includes(key) && (typeof data.body[key]!==typeof value || Array.isArray(value)!==Array.isArray(data.body[key])))throw bad('Сохраните все поля исходного материала.');
        if(source.options && (!data.body.options.every(v=>typeof v==='string'&&v.trim()) || !Number.isInteger(data.body.answer)||data.body.answer<0||data.body.answer>=data.body.options.length))throw bad('Проверьте варианты и правильный ответ.');
      }
      const {rows:[after]}=await client.query(`INSERT INTO gamification_content(id,kind,body,medical,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,body=EXCLUDED.body,medical=EXCLUDED.medical,revision=gamification_content.revision+1,
        status='draft',updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at,approved_by=NULL,approved_at=NULL,evidence=NULL RETURNING *`,[id,kind,JSON.stringify(data.body),medical,user.id,new Date(clock())]);
      await client.query("UPDATE gamification_notifications SET push_state='suppressed' WHERE content_id=$1 AND push_state='pending'",[id]);
      await audit(client,user,'content_saved',id,before,after,'Редактирование'); return after;
    }),
    approveContent:(token,account,{id,revision,evidence}={})=>write(token,account,async(client,user)=>{
      evidence=text(evidence,2000); id=text(id,180);
      const {rows:[before]}=await client.query('SELECT * FROM gamification_content WHERE id=$1 FOR UPDATE',[id]);
      if(!before || before.revision!==revision) throw new AuthError(409,'content_changed','Обновите текст перед утверждением.');
      const {rows:[after]}=await client.query(`UPDATE gamification_content SET status='approved',approved_by=$2,approved_at=$3,evidence=$4 WHERE id=$1 RETURNING *`,[id,user.id,new Date(clock()),evidence]);
      await audit(client,user,'content_approved',id,before,after,evidence); return after;
    }),
    approveGate:(token,account,{gate,approved,evidence}={})=>write(token,account,async(client,user)=>{
      if(!['medical','aiBudget'].includes(gate) || typeof approved!=='boolean') throw bad('Выберите утверждение.');
      evidence=text(evidence,2000); const before=await settings.get(client);
      const column=gate==='medical'?'medical_approved':'ai_budget_approved';
      await client.query(`UPDATE gamification_settings SET ${column}=$1,updated_at=$2 WHERE id=1`,[approved,new Date(clock())]);
      const after=await settings.get(client); await audit(client,user,'gate_approved',gate,before,after,evidence); return after;
    }),
    resolveLegacy:(token,account,{userId,preservedWeeks,evidence}={})=>write(token,account,async(client,user)=>{
      if(!isUuid(userId)||!Array.isArray(preservedWeeks)||preservedWeeks.length>42||preservedWeeks.some(n=>!Number.isInteger(n)||n<1||n>42))throw bad('Укажите аккаунт и недели, доступ к которым подтверждён.');
      evidence=text(evidence,2000);preservedWeeks=[...new Set(preservedWeeks)].sort((a,b)=>a-b);
      await client.query('SELECT id FROM auth_users WHERE id=$1 FOR UPDATE',[userId]);
      const {rows:[before]}=await client.query('SELECT * FROM auth_stars_wallet WHERE user_id=$1 FOR UPDATE',[userId]);
      if(!before)throw bad('Аккаунт не найден в сверке.');
      // A later review may add proven rights, never silently withdraw previously preserved ones.
      if((before.preserved_weeks||[]).some(n=>!preservedWeeks.includes(n)))throw bad('Ранее подтверждённые недели должны остаться доступными.');
      const {rows:[after]}=await client.query('UPDATE auth_stars_wallet SET legacy=false,preserved_weeks=$2 WHERE user_id=$1 RETURNING *',[userId,preservedWeeks]);
      await client.query(`INSERT INTO auth_stars_legacy_reviews(user_id,preserved_weeks,resolved_by,resolved_at,evidence) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(user_id) DO UPDATE SET preserved_weeks=EXCLUDED.preserved_weeks,resolved_by=EXCLUDED.resolved_by,resolved_at=EXCLUDED.resolved_at,evidence=EXCLUDED.evidence`,[userId,preservedWeeks,user.id,new Date(clock()),evidence]);
      await audit(client,user,'legacy_resolved',userId,before,after,evidence);return {userId,legacy:false,preservedWeeks};
    },userId),
    async metrics(token,account) {
      await owner(token,account);
      const today=new Date(+new Date(clock())+3*3600000).toISOString().slice(0,10);
      const visits=(await pool.query('SELECT user_id,moscow_day FROM auth_gamification_visits')).rows;
      const {rows:[materials]}=await pool.query('SELECT count(*)::int AS total FROM auth_stars_material_progress');
      const {rows:[weeks]}=await pool.query('SELECT count(*)::int AS total FROM auth_stars_weeks');
      const {rows:[spends]}=await pool.query('SELECT COALESCE(-sum(amount),0)::bigint AS total,count(*)::int AS operations FROM auth_points_ledger WHERE amount<0');
      const {rows:[free]}=await pool.query('SELECT COALESCE(sum(used),0)::bigint AS total FROM ai_chat_daily_usage');
      const {rows:[paid]}=await pool.query('SELECT COALESCE(sum(used),0)::bigint AS total FROM auth_stars_ai_daily_usage');
      const {rows:[optout]}=await pool.query("SELECT count(*)::int AS events,count(DISTINCT actor_id)::int AS accounts FROM gamification_audit WHERE action='push_optout'");
      const daily=new Map();
      for(const row of visits) {const day=String(row.moscow_day instanceof Date?row.moscow_day.toISOString():row.moscow_day).slice(0,10);if(day<=today)daily.set(day,(daily.get(day)||0)+1);}
      return {asOf:today,scope:'recorded_history',activeDays:[...daily.values()].reduce((a,b)=>a+b,0),activeAccounts:new Set(visits.filter(r=>String(r.moscow_day instanceof Date?r.moscow_day.toISOString():r.moscow_day).slice(0,10)<=today).map(r=>r.user_id)).size,
        dailyVisits:[...daily].sort(([a],[b])=>a.localeCompare(b)).slice(-30).map(([day,accounts])=>({day,accounts})),retention:retentionMetrics(visits,today),
        completedMaterials:materials.total,completedWeeks:weeks.total,spends:{stars:Number(spends.total),operations:spends.operations},aiUnits:{free:Number(free.total),paid:Number(paid.total),basis:'reserved_units_net_refunds'},pushOptout:optout,coursePurchases:null,providerActualCost:null};
    },
    async publishedContent(id) {
      const config=await settings.get(); if(!config.enabled) return null;
      const {rows:[row]}=await pool.query("SELECT * FROM gamification_content WHERE id=$1 AND status='approved'",[id]);
      return row && (!row.medical || config.medicalApproved) ? row : null;
    },
  };
}
