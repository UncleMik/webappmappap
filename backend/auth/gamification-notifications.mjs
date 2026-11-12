import { AuthError, hashToken } from './security.mjs';
import { forGamificationUser } from './gamification-settings.mjs';
import { transaction } from './store.mjs';

export const NOTIFICATION_PRIORITIES = Object.freeze({new_week:0,capsule:1,quest:2,poll_results:3,week_almost:4,daily:5,feature:6,celebration:7});
const defaults = {babyPause:false,timezone:'Europe/Moscow',pushEnabled:false,quietStart:21,quietEnd:9,types:Object.fromEntries(Object.keys(NOTIFICATION_PRIORITIES).map(key=>[key,true]))};
const invalid = () => new AuthError(400,'invalid_notifications','Проверьте настройки уведомлений.');
export function localNotificationTime(now,timezone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
  const p=key=>parts.find(p=>p.type===key).value;
  return {day:`${p('year')}-${p('month')}-${p('day')}`,hour:Number(p('hour'))};
}
export function notificationQuiet(now,prefs) {
  const {hour}=localNotificationTime(now,prefs.timezone);
  // The mandatory 21–09 quiet period cannot be shortened by user preferences.
  if(hour>=21 || hour<9) return true;
  const {quietStart:a,quietEnd:b}=prefs;
  return a===b ? false : a<b ? hour>=a && hour<b : hour>=a || hour<b;
}
function preferencesValue(value={}) {return {...structuredClone(defaults),...value,types:{...defaults.types,...value.types}};}
function validatePatch(patch) {
  if(!patch || typeof patch!=='object' || Array.isArray(patch)) throw invalid();
  const result={...patch};
  if(Object.hasOwn(result,'pauseBaby')) {result.babyPause=result.pauseBaby;delete result.pauseBaby;}
  for(const [key,value] of Object.entries(result)) {
    if(['babyPause','pushEnabled'].includes(key)) {if(typeof value!=='boolean') throw invalid();}
    else if(key==='timezone') {try{if(typeof value!=='string'||value.length>100)throw invalid();localNotificationTime(Date.now(),value);}catch{throw invalid();}}
    else if(['quietStart','quietEnd'].includes(key)) {if(!Number.isInteger(value)||value<0||value>23)throw invalid();}
    else if(key==='types') {if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([k,v])=>!Object.hasOwn(defaults.types,k)||typeof v!=='boolean'))throw invalid();}
    else throw invalid();
  }
  return result;
}
function safeUrl(value) {return typeof value==='string' && /^\/(?!\/)/.test(value) && !/[\\\s\x00-\x1f]/.test(value) ? value : '/index.html';}
// Subscriptions may only target supported browser push services, never an arbitrary SSRF URL.
export function subscriptionValue(value) {
  let url;try{url=new URL(value?.endpoint);}catch{throw invalid();}
  const host=url.hostname;
  if(url.protocol!=='https:'||url.port||url.username||url.password||!['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(host)||url.href.length>2000)throw invalid();
  const {p256dh,auth}=value.keys||{};
  if(typeof p256dh!=='string'||typeof auth!=='string'||!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh)||!/^[A-Za-z0-9_-]+={0,2}$/.test(auth)||Buffer.from(p256dh,'base64url').length!==65||Buffer.from(auth,'base64url').length!==16)throw invalid();
  return {endpoint:url.href,expirationTime:null,keys:{p256dh,auth}};
}
export function createGamificationNotifications({pool,service,settings,clock=Date.now,pushTransport,pushPublicKey=null}) {
  const now=()=>new Date(clock());
  async function account(token,expected) {
    const session=await service.session(token),user=session?.user || session;
    if(!user?.id)throw new AuthError(401,'sign_in_required','Войдите по email.');
    if(!expected||user.id!==expected)throw new AuthError(409,'account_changed','Аккаунт изменился.');
    return user;
  }
  async function ensure(client,userId) {
    await client.query('INSERT INTO gamification_notification_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);
    return (await client.query('SELECT * FROM gamification_notification_preferences WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
  }
  async function authenticated(token,expected,run) {
    const user=await account(token,expected);
    return transaction(pool,async client=>{
      await client.query('SELECT id FROM auth_users WHERE id=$1 FOR UPDATE',[user.id]);
      await ensure(client,user.id);
      const valid=await client.query('SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',[hashToken(token),user.id]);
      if(!valid.rows.length)throw new AuthError(401,'sign_in_required','Войдите по email.');
      return run(client,user);
    });
  }
  async function syncPreferences(client,{userId,...patch},{source='user'}={}) {
    patch=validatePatch(patch);
    const row=await ensure(client,userId),before=preferencesValue(row.value);
    const after={...before,...patch,types:{...before.types,...patch.types}};
    if(after.pushEnabled && !before.pushEnabled) {
      const {rows}=await client.query('SELECT 1 FROM gamification_push_subscriptions WHERE user_id=$1',[userId]);
      if(!rows.length)throw invalid();
    }
    await client.query('UPDATE gamification_notification_preferences SET value=$2 WHERE user_id=$1',[userId,JSON.stringify(after)]);
    if(Object.hasOwn(patch,'babyPause')) await client.query("UPDATE auth_gamification_state SET data=jsonb_set(data,'{preferences}',COALESCE(data->'preferences','{}'::jsonb) || $2::jsonb),updated_at=$3 WHERE user_id=$1",[userId,JSON.stringify({babyPause:after.babyPause}),now()]);
    if(source==='user' && before.pushEnabled && !after.pushEnabled) await client.query("INSERT INTO gamification_audit(actor_id,action,target,before_value,after_value,reason,created_at) VALUES($1,'push_optout','notifications','true','false','Отключено пользователем',$2)",[userId,now()]);
    if(after.babyPause) await client.query("UPDATE gamification_notifications SET push_state='suppressed' WHERE user_id=$1 AND baby_related AND push_state='pending'",[userId]);
    return after;
  }
  async function allowed(client,userId,entry,prefs,config) {
    config=forGamificationUser(config,userId);
    if(!config.enabled||!config.features.notifications||!prefs.types[entry.type]||prefs.babyPause&&(entry.baby_related||entry.type==='capsule'))return false;
    const {rows:[user]}=await client.query('SELECT profile FROM auth_users WHERE id=$1',[userId]);
    if(entry.type!=='capsule' && entry.baby_related && (user?.profile?.stage==='mother'||user?.profile?.birthDate))return false;
    if(entry.medical && !config.medicalApproved)return false;
    if(entry.content_id) {
      const {rows:[content]}=await client.query("SELECT status,revision,medical FROM gamification_content WHERE id=$1",[entry.content_id]);
      if(!content||content.status!=='approved'||content.revision!==entry.content_revision||content.medical&&!config.medicalApproved)return false;
    } else if(entry.medical)return false;
    return true;
  }
  return {
    syncPreferences,
    async enqueue(client,event) {
      const {userId,key,type,title,body='',babyRelated=false,medical=false}=event;
      if(!Object.hasOwn(NOTIFICATION_PRIORITIES,type)||typeof key!=='string'||!key||key.length>200||typeof title!=='string'||!title.trim()||title.length>200||typeof body!=='string'||body.length>3000)throw invalid();
      let contentRevision=null;
      if(medical && !event.contentId)return null;
      if(event.contentId) {
        const {rows:[content]}=await client.query("SELECT * FROM gamification_content WHERE id=$1 AND status='approved'",[event.contentId]);
        if(!content)return null;
        contentRevision=content.revision;
      }
      const config=await settings.get(client), row=await ensure(client,userId),prefs=preferencesValue(row.value);
      if(!await allowed(client,userId,{type,baby_related:babyRelated,medical,content_id:event.contentId,content_revision:contentRevision},prefs,config))return null;
      const at=event.availableAt?new Date(event.availableAt):now();if(!Number.isFinite(+at))throw invalid();
      const {rows:[entry]}=await client.query(`INSERT INTO gamification_notifications(user_id,event_key,type,title,body,url,baby_related,medical,priority,available_at,created_at,content_id,content_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(user_id,event_key) DO NOTHING RETURNING *`,[userId,key,type,title,body,safeUrl(event.url),babyRelated,medical,NOTIFICATION_PRIORITIES[type],at,now(),event.contentId||null,contentRevision]);
      return entry||null;
    },
    list:(token,expected)=>authenticated(token,expected,async(client,user)=>{
      const config=forGamificationUser(await settings.get(client),user.id),prefs=preferencesValue((await ensure(client,user.id)).value);
      const {rows}=await client.query('SELECT * FROM gamification_notifications WHERE user_id=$1 AND available_at<=$2 ORDER BY created_at DESC,id DESC LIMIT 100',[user.id,now()]);
      const items=[];for(const row of rows)if(await allowed(client,user.id,row,prefs,config))items.push({id:String(row.id),type:row.type,title:row.title,body:row.body,url:row.url,createdAt:row.created_at,readAt:row.read_at});
      return {accountId:user.id,items,unread:items.filter(x=>!x.readAt).length,preferences:prefs,pushPublicKey:config.enabled&&config.features.push?pushPublicKey:null,pushSessionId:hashToken(hashToken(token))};
    }),
    read:(token,expected,{ids}={})=>authenticated(token,expected,async(client,user)=>{
      if(!Array.isArray(ids)||ids.length>100||ids.some(x=>!/^\d{1,19}$/.test(String(x))))throw invalid();
      if(ids.length)await client.query('UPDATE gamification_notifications SET read_at=COALESCE(read_at,$3) WHERE user_id=$1 AND id=ANY($2::bigint[])',[user.id,ids,now()]);
      return {ok:true};
    }),
    preferences:(token,expected,patch)=>authenticated(token,expected,async(client,user)=>patch===undefined?preferencesValue((await ensure(client,user.id)).value):syncPreferences(client,{...validatePatch(patch),userId:user.id})),
    subscribe:(token,expected,value)=>authenticated(token,expected,async(client,user)=>{
      if(!pushPublicKey)throw new AuthError(503,'push_unavailable','Push-уведомления пока недоступны.');
      const subscription=subscriptionValue(value?.subscription||value);
      const existing=await client.query('SELECT user_id FROM gamification_push_subscriptions WHERE endpoint=$1',[subscription.endpoint]);
      if(existing.rows.length && existing.rows[0].user_id!==user.id)throw new AuthError(409,'push_account_changed','Отключите уведомления прежнего аккаунта в браузере.');
      await client.query(`INSERT INTO gamification_push_subscriptions(user_id,endpoint,subscription,created_at,session_hash) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(user_id) DO UPDATE SET endpoint=EXCLUDED.endpoint,subscription=EXCLUDED.subscription,created_at=EXCLUDED.created_at,session_hash=EXCLUDED.session_hash`,[user.id,subscription.endpoint,JSON.stringify(subscription),now(),hashToken(token)]);
      return syncPreferences(client,{userId:user.id,pushEnabled:true});
    }),
    unsubscribe:(token,expected,{endpoint}={})=>authenticated(token,expected,async(client,user)=>{
      if(typeof endpoint!=='string')throw invalid();
      await client.query('DELETE FROM gamification_push_subscriptions WHERE user_id=$1 AND endpoint=$2',[user.id,endpoint]);
      return syncPreferences(client,{userId:user.id,pushEnabled:false});
    }),
    visit:(token,expected)=>authenticated(token,expected,async(client,user)=>{
      await client.query('UPDATE gamification_notification_preferences SET last_visit_at=$2 WHERE user_id=$1',[user.id,now()]);
      await client.query('INSERT INTO auth_gamification_visits(user_id,moscow_day) VALUES($1,$2) ON CONFLICT DO NOTHING',[user.id,localNotificationTime(clock(),'Europe/Moscow').day]);return {ok:true};
    }),
    claimPresentation:(token,expected,{kind,sessionId}={})=>authenticated(token,expected,async(client,user)=>{
      if(!['hint','celebration'].includes(kind)||kind==='celebration'&&(typeof sessionId!=='string'||! /^[a-zA-Z0-9_-]{16,100}$/.test(sessionId)))throw invalid();
      const config=forGamificationUser(await settings.get(client),user.id);if(!config.enabled)return {allowed:false};
      const period=kind==='hint'?localNotificationTime(clock(),'Europe/Moscow').day:hashToken(token);
      const {rows}=await client.query('INSERT INTO gamification_presentations(user_id,kind,period,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING kind',[user.id,kind,period,now()]);return {allowed:!!rows.length};
    }),
    async processQueue({limit=100}={}) {
      const config=await settings.get();
      if(!config.enabled||!config.features.notifications||!config.features.push||!pushTransport)return {sent:0,disabled:true};
      limit=Math.max(1,Math.min(500,Number(limit)||100));
      const {rows:users}=await pool.query(`SELECT DISTINCT user_id FROM gamification_notifications WHERE push_state='pending' AND available_at<=$1 LIMIT $2`,[now(),limit]);
      let sent=0;
      for(const {user_id:userId} of users) {
        const job=await transaction(pool,async client=>{
          await client.query('SELECT id FROM auth_users WHERE id=$1 FOR UPDATE',[userId]);
          const row=await ensure(client,userId),prefs=preferencesValue(row.value);
          if(!prefs.pushEnabled || notificationQuiet(clock(),prefs))return null;
          const {rows:[subscription]}=await client.query('SELECT subscription,session_hash FROM gamification_push_subscriptions WHERE user_id=$1',[userId]);
          if(!subscription)return null;
          const day=localNotificationTime(clock(),prefs.timezone).day;
          // Preserve reservations after a worker crash: delivery may have happened, never retry blindly.
          const {rows:[last]}=await client.query('SELECT * FROM gamification_push_days WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[userId]);
          if(last && (last.local_day===day || localNotificationTime(last.created_at,prefs.timezone).day===day))return null;
          const {rows}=await client.query("SELECT * FROM gamification_notifications WHERE user_id=$1 AND push_state='pending' AND available_at<=$2 ORDER BY priority,created_at,id",[userId,now()]);
          let selected=null;
          for(const entry of rows) {
            const stale=localNotificationTime(entry.available_at,prefs.timezone).day!==day;
            const visited=row.last_visit_at && localNotificationTime(row.last_visit_at,prefs.timezone).day===day;
            if(stale || !await allowed(client,userId,entry,prefs,config) || entry.type==='daily'&&visited) {
              await client.query("UPDATE gamification_notifications SET push_state='suppressed' WHERE id=$1",[entry.id]);continue;
            }
            if(!selected)selected=entry;
          }
          if(!selected)return null;
          const reserved=await client.query(`INSERT INTO gamification_push_days(user_id,local_day,notification_id,state,created_at) VALUES($1,$2,$3,'reserved',$4) ON CONFLICT DO NOTHING RETURNING user_id`,[userId,day,selected.id,now()]);
          return reserved.rows.length?{userId,day,entry:selected,subscription:subscription.subscription}:null;
        });
        if(!job)continue;
        try {
          // Recheck under the same user/preferences locks as consent changes. The
          // transport has a bounded timeout; revocation cannot race this final check.
          const delivered=await transaction(pool,async client=>{
            await client.query('SELECT id FROM auth_users WHERE id=$1 FOR UPDATE',[userId]);
            const row=await ensure(client,userId),prefs=preferencesValue(row.value);
            await client.query('SELECT id FROM gamification_settings WHERE id=1 FOR SHARE');
            const fresh=await settings.get(client);
            const {rows:[sub]}=await client.query(`SELECT p.subscription,p.session_hash FROM gamification_push_subscriptions p JOIN auth_sessions s ON s.token_hash=p.session_hash AND s.user_id=p.user_id
              WHERE p.user_id=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 FOR SHARE OF s`,[userId,now()]);
            const {rows:[entry]}=await client.query('SELECT * FROM gamification_notifications WHERE id=$1',[job.entry.id]);
            const day=localNotificationTime(clock(),prefs.timezone).day;
            const visited=row.last_visit_at&&localNotificationTime(row.last_visit_at,prefs.timezone).day===day;
            if(!fresh.features.push||!prefs.pushEnabled||notificationQuiet(clock(),prefs)||day!==job.day||!sub||sub.subscription.endpoint!==job.subscription.endpoint||!entry||entry.push_state!=='pending'||entry.type==='daily'&&visited||!await allowed(client,userId,entry,prefs,fresh)) {
              await client.query("UPDATE gamification_push_days SET state='failed' WHERE user_id=$1 AND local_day=$2",[userId,job.day]);
              await client.query("UPDATE gamification_notifications SET push_state='suppressed' WHERE id=$1",[job.entry.id]);
              return false;
            }
            // Keep personal letters and medical details out of push payloads.
            await pushTransport(sub.subscription,{title:'Лёгкие роды',body:'Для вас есть новое уведомление в приложении.',url:'/index.html',tag:'webpril-for-you',accountId:userId,id:String(entry.id),sessionId:hashToken(sub.session_hash)});
            return true;
          });
          if(!delivered)continue;
          await transaction(pool,async client=>{
            await client.query("UPDATE gamification_push_days SET state='sent' WHERE user_id=$1 AND local_day=$2",[userId,job.day]);
            await client.query("UPDATE gamification_notifications SET push_state='sent' WHERE id=$1",[job.entry.id]);
            await client.query("UPDATE gamification_notifications SET push_state='suppressed' WHERE user_id=$1 AND id<>$2 AND push_state='pending' AND available_at<=$3",[userId,job.entry.id,now()]);
          });sent++;
        } catch(error) {
          await transaction(pool,async client=>{
            await client.query("UPDATE gamification_push_days SET state='ambiguous' WHERE user_id=$1 AND local_day=$2",[userId,job.day]);
            await client.query("UPDATE gamification_notifications SET push_state='ambiguous' WHERE id=$1",[job.entry.id]);
            if([404,410].includes(error.statusCode)) {
              await client.query('DELETE FROM gamification_push_subscriptions WHERE user_id=$1 AND endpoint=$2',[userId,job.subscription.endpoint]);
              await syncPreferences(client,{userId,pushEnabled:false},{source:'provider'});
            }
          });
        }
      }
      return {sent};
    },
  };
}
export async function createGamificationPushTransport({publicKey,privateKey,subject}) {
  if(!publicKey||!privateKey||!/^mailto:|^https:\/\//.test(subject||''))throw new Error('VAPID configuration required');
  const webPush=await import('web-push');
  return (subscription,payload)=>webPush.sendNotification(subscription,JSON.stringify(payload),{vapidDetails:{subject,publicKey,privateKey},TTL:3600,timeout:10000});
}
