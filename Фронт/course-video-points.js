import { authRequest } from './auth-client.js?v=20261109-pilot';

const played = video => Array.from({length:video.played.length},(_,index) => [Math.ceil(video.played.start(index)*1000),Math.floor(video.played.end(index)*1000)]).filter(([a,b])=>b>a);
function difference(ranges, previous) {
  const result = [];
  for (const [start,end] of ranges) {
    let cursor = start;
    for (const [left,right] of previous) { if(right<=cursor)continue; if(left>=end)break; if(left>cursor)result.push([cursor,left]); cursor=Math.max(cursor,right); }
    if(cursor<end)result.push([cursor,end]);
  }
  return result;
}
// The backend verifies course, lesson, trusted duration and every video independently.
export function trackCourseVideo(video, material, note) {
  let account, attemptId, baseline=[], pending=null, timer, stopped=false, needsStart=true, again=false;
  const visible = () => !document.hidden && !window.frameElement?.hidden && video.isConnected && !video.closest('[hidden]');
  async function update() {
    clearTimeout(timer);
    if (stopped || !visible()) return;
    if (pending) { again=true; return pending; }
    const id = window.webprilSessionAccountId;
    if (!id || account && account!==id) { if(account)stopped=true; return; }
    if (!attemptId && video.paused && !video.ended) return;
    account=id;
    const task = (async () => {
      try {
        const snapshot=played(video), start=needsStart||!attemptId;
        const result=await authRequest('stars/course-video',{...material,...(start?{}:{attemptId,ranges:difference(snapshot,baseline).slice(0,32)})},{headers:{'X-Webpril-Account':id}});
        if(stopped || window.webprilSessionAccountId!==id || !video.isConnected)return;
        if(result.status==='watching') { baseline=snapshot; if(start){attemptId=result.attemptId;needsStart=!visible();} }
        else if(result.status==='earned'||result.status==='already_earned') {
          stopped=true; note.textContent=result.amount>0?`+${result.amount} ★ за урок.`:'Урок засчитан в прогресс.';
          window.dispatchEvent(new CustomEvent('stars:changed'));
        }
      } catch(error) {
        if([401,403,404].includes(error.status)||error.code==='account_changed')stopped=true;
        if(['video_duration_unverified','video_progress_unsupported'].includes(error.code)) { stopped=true; note.textContent='Просмотр доступен. Награда за этот урок пока не подтверждается.'; }
        if(error.code==='video_attempt_expired'||error.code==='network_error')needsStart=true;
      }
    })(); pending=task;
    try { await task; } finally { pending=null; if(again){again=false;void update();}else if(!stopped&&visible()&&!video.paused)timer=setTimeout(update,10000); }
  }
  video.addEventListener('playing',update); video.addEventListener('pause',update); video.addEventListener('ended',update);
  const hide=()=>{clearTimeout(timer);needsStart=true;};
  const visibility=()=>{if(!visible())hide();else if(!video.paused)void update();};
  document.addEventListener('visibilitychange',visibility);
  const observer=new MutationObserver(records=>{
    if(!video.isConnected){stopped=true;hide();observer.disconnect();frameObserver?.disconnect();document.removeEventListener('visibilitychange',visibility);}
    else if(records.some(record=>record.type==='attributes'&&record.attributeName==='hidden'&&record.target.contains(video.element || video)))visibility();
  });
  const frameObserver=window.frameElement?new MutationObserver(visibility):null;
  frameObserver?.observe(window.frameElement,{attributes:true,attributeFilter:['hidden']});
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
  window.addEventListener('webpril:session-ended',()=>{stopped=true;hide();},{once:true});
  window.addEventListener('pagehide',hide);
  return update;
}
