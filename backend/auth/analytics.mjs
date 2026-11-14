import { AuthError, hashToken, isUuid } from './security.mjs';
import { transaction } from './store.mjs';

export const ANALYTICS_PAGES = ['index.html','journey.html','ai.html','club.html','profile.html','article.html','articles.html','baby.html','club-chat.html','courses.html','favorites.html','mom.html','my-courses.html','personal-data.html','video.html','about.html'];
const types = ['page_view','active_time','content_open','article_progress','video_start','video_progress','video_completed','action','transition','ai_request','ai_result','error'];
const actions = ['nav_open','course_open','lesson_open','video_open','external_video_open','favorite_add','favorite_remove','points_open','calendar_open','poll_vote','ai_open','ai_voice_transcribed','ai_limit','ai_error','network','unavailable'];
const fields = ['eventId','visitId','type','page','resourceType','resourceId','action','activeMs','progress','fromPage','format','outcome'];
const invalid = () => new AuthError(400,'invalid_analytics','Неверные события аналитики.');
const unauthorized = () => new AuthError(401,'sign_in_required','Войдите в аккаунт.');
const accountChanged = () => new AuthError(409,'account_changed','Аккаунт изменился.');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function validateAnalyticsBatch(data) {
  if (!object(data) || Object.keys(data).some(k=>k!=='events') || !Array.isArray(data.events) || !data.events.length || data.events.length>30) throw invalid();
  return data.events.map(e=>{
    if (!object(e) || Object.keys(e).some(k=>!fields.includes(k)) || !isUuid(e.eventId) || !isUuid(e.visitId) || !types.includes(e.type) || !ANALYTICS_PAGES.includes(e.page)) throw invalid();
    const resource = e.resourceType !== undefined || e.resourceId !== undefined;
    if (resource && (!['article','video','lesson','course'].includes(e.resourceType) || typeof e.resourceId!=='string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(e.resourceId))) throw invalid();
    if (e.action!==undefined && !actions.includes(e.action)) throw invalid();
    if (e.activeMs!==undefined && (e.type!=='active_time' || !Number.isInteger(e.activeMs) || e.activeMs<1 || e.activeMs>60000)) throw invalid();
    if (e.progress!==undefined && (!['article_progress','video_progress'].includes(e.type) || ![25,50,75,90,100].includes(e.progress))) throw invalid();
    if (e.fromPage!==undefined && (e.type!=='transition' || !ANALYTICS_PAGES.includes(e.fromPage))) throw invalid();
    if (e.format!==undefined && (!['ai_request','ai_result'].includes(e.type) || !['text','file','voice'].includes(e.format))) throw invalid();
    if (e.outcome!==undefined && (!['ai_request','ai_result'].includes(e.type) || !['accepted','completed','failed','limit'].includes(e.outcome))) throw invalid();
    if (e.type==='active_time' && !e.activeMs || e.type==='transition' && !e.fromPage || ['action','error'].includes(e.type) && !e.action || ['ai_request','ai_result'].includes(e.type) && (!e.format || !e.outcome)) throw invalid();
    if (e.type==='error' && !['ai_limit','ai_error','network','unavailable'].includes(e.action)) throw invalid();
    if (['content_open','article_progress','video_start','video_progress','video_completed'].includes(e.type) && !resource) throw invalid();
    if (e.type==='article_progress' && (e.resourceType!=='article' || !e.progress) || ['video_start','video_progress','video_completed'].includes(e.type) && !['video','lesson'].includes(e.resourceType) || e.type==='video_progress' && !e.progress) throw invalid();
    return e;
  });
}

export function createAnalytics({pool,admin,ownerEmail='',store,titleForResource=()=>null,clock=Date.now}) {
  async function live(client,token,account) {
    if (!token) throw unauthorized();
    const {rows:[user]}=await client.query(`SELECT u.id,u.email,u.profile FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 FOR SHARE OF s,u`,[hashToken(token),new Date(clock())]);
    if (!user) throw unauthorized();
    if (typeof account!=='string' || user.id!==account.toLowerCase()) throw accountChanged();
    return user;
  }
  const eligible = `FROM auth_analytics_events e JOIN auth_users u ON u.id=e.user_id
    WHERE e.recorded_at >= $1 AND e.recorded_at < $2 AND e.recorded_at >= $4 AND u.email<>$3
    AND NOT EXISTS(SELECT 1 FROM admin_editors a WHERE a.user_id=e.user_id)
    AND NOT EXISTS(SELECT 1 FROM auth_analytics_exclusions x WHERE x.user_id=e.user_id)`;
  const n = row => Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='string' && /^\d+$/.test(v) && !['id','day'].includes(k)?Number(v):v]));
  return {
    async ingest(token,account,data) {
      const events=validateAnalyticsBatch(data);
      // Rate limiting uses the existing separate pool connection; do not nest it
      // inside a held transaction, which could exhaust the pool under concurrency.
      const preliminary=await live(pool,token,account);
      await store?.rateLimit('analytics_user',preliminary.id,60);
      return transaction(pool,async client=>{
        const user=await live(client,token,account);
        if (!user.profile?.completedAt) throw new AuthError(403,'profile_required','Заполните профиль.');
        const {rows}=await client.query(`SELECT 1 FROM admin_editors WHERE user_id=$1 UNION ALL SELECT 1 FROM auth_analytics_exclusions WHERE user_id=$1`,[user.id]);
        if (user.email===ownerEmail || rows.length) return {accepted:0,excluded:true};
        let accepted=0;
        for (const e of events) {
          const result=await client.query(`INSERT INTO auth_analytics_events(user_id,event_id,visit_id,type,page,resource_type,resource_id,action,active_ms,progress,from_page,format,outcome,recorded_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(user_id,event_id) DO NOTHING RETURNING event_id`,
          [user.id,e.eventId,e.visitId,e.type,e.page,e.resourceType??null,e.resourceId??null,e.action??null,e.activeMs??0,e.progress??null,e.fromPage??null,e.format??null,e.outcome??null,new Date(clock())]);
          accepted+=result.rows.length;
        }
        return {accepted};
      });
    },
    async report(token,account,days=7) {
      if (![7,30,90].includes(days)) throw invalid();
      const user=await admin?.session(token,account);
      if (!user) throw unauthorized();
      if (!account || user.id!==account) throw accountChanged();
      if (user.role!=='owner') throw new AuthError(403,'admin_forbidden','Аналитика доступна владельцу.');
      const now=Number(new Date(clock())),today=new Date(now+10800000).toISOString().slice(0,10);
      const from=new Date(Date.parse(today+'T00:00:00+03:00')-(days-1)*86400000);
      const to=new Date(Date.parse(today+'T00:00:00+03:00')+86400000);
      return transaction(pool,async client=>{
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await live(client,token,account);
        const args=[from,to,ownerEmail,new Date(now-90*86400000)];
        const rows=async(sql)=> (await client.query(sql,args)).rows.map(n);
        const counts=`COUNT(DISTINCT e.user_id)::int AS users,COUNT(DISTINCT (e.user_id,e.visit_id))::int AS visits,COUNT(*) FILTER(WHERE e.type='page_view')::int AS views,COALESCE(SUM(e.active_ms),0)::bigint AS "activeMs"`;
        const [summary]=await rows(`SELECT ${counts} ${eligible}`);
        const daily=await rows(`SELECT to_char(e.recorded_at AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day,${counts} ${eligible} GROUP BY day ORDER BY day`);
        const screens=await rows(`SELECT e.page,COUNT(DISTINCT e.user_id)::int AS users,COUNT(*) FILTER(WHERE e.type='page_view')::int AS views,COALESCE(SUM(e.active_ms),0)::bigint AS "activeMs" ${eligible} GROUP BY e.page ORDER BY views DESC,e.page`);
        const milestones=[25,50,75,90].map(p=>`COUNT(DISTINCT (e.user_id,e.visit_id,e.resource_type,e.resource_id)) FILTER(WHERE e.progress=${p})::int AS "progress${p}"`).join(',');
        const completed=`COUNT(DISTINCT (e.user_id,e.visit_id,e.resource_type,e.resource_id)) FILTER(WHERE e.type='video_completed' OR e.progress=100)::int AS completed`;
        const baseContent=`e.resource_type AS type,e.resource_id AS id,COUNT(DISTINCT e.user_id)::int AS users,COUNT(*) FILTER(WHERE e.type='content_open')::int AS opens,COALESCE(SUM(e.active_ms),0)::bigint AS "activeMs",${milestones},${completed}`;
        const content=await rows(`SELECT ${baseContent} ${eligible} AND e.resource_id IS NOT NULL GROUP BY e.resource_type,e.resource_id ORDER BY opens DESC,users DESC,e.resource_type,e.resource_id LIMIT 100`);
        const videos=await rows(`SELECT ${baseContent},COUNT(*) FILTER(WHERE e.type='video_start')::int AS starts ${eligible} AND e.resource_type IN ('video','lesson') GROUP BY e.resource_type,e.resource_id ORDER BY starts DESC,opens DESC,e.resource_type,e.resource_id LIMIT 100`);
        for (const row of [...content,...videos]) row.title=await titleForResource(row.type,row.id) || null;
        const actions=await rows(`SELECT e.action,COUNT(*)::int AS count,COUNT(DISTINCT e.user_id)::int AS users ${eligible} AND e.type='action' GROUP BY e.action ORDER BY count DESC,e.action LIMIT 100`);
        const transitions=await rows(`SELECT e.from_page AS "from",e.page AS "to",COUNT(*)::int AS count,COUNT(DISTINCT e.user_id)::int AS users ${eligible} AND e.type='transition' GROUP BY e.from_page,e.page ORDER BY count DESC,e.from_page,e.page LIMIT 100`);
        const ai=await rows(`SELECT e.format,e.outcome,COUNT(*)::int AS count,COUNT(DISTINCT e.user_id)::int AS users ${eligible} AND e.type IN ('ai_request','ai_result') GROUP BY e.format,e.outcome ORDER BY e.format,e.outcome`);
        const errors=await rows(`SELECT e.action,COUNT(*)::int AS count,COUNT(DISTINCT e.user_id)::int AS users ${eligible} AND e.type='error' GROUP BY e.action ORDER BY count DESC,e.action`);
        const {rows:[state]}=await client.query('SELECT collection_started_at FROM auth_analytics_state WHERE id=1');
        return {generatedAt:new Date(now).toISOString(),collectionStartedAt:new Date(state.collection_started_at).toISOString(),period:{days,timezone:'Europe/Moscow',from:new Date(+from+10800000).toISOString().slice(0,10),to:today},overview:{users:summary.users,visits:summary.visits,screenViews:summary.views,activeMs:summary.activeMs},daily,screens,content,actions,transitions,ai,errors,videos};
      });
    },
    async cleanup() { await pool.query('DELETE FROM auth_analytics_events WHERE recorded_at<$1',[new Date(clock()-90*86400000)]); },
  };
}
