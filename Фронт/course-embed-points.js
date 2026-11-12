import { trackCourseVideo } from './course-video-points.js?v=20261112-stars';

// Samples media time from the providers' documented APIs, never elapsed page time.
// https://developers.google.com/youtube/iframe_api_reference
// https://rutube.ru/info/embed/
export function playbackSampler(frame) {
  const media = new EventTarget();
  let ranges = [], previous = null, playing = false, advert = false;
  Object.defineProperties(media, {
    isConnected: {get:()=>frame.isConnected}, paused:{get:()=>!playing}, ended:{value:false,writable:true},
    played:{get:()=>({length:ranges.length,start:i=>ranges[i][0],end:i=>ranges[i][1]})},
  });
  media.element = frame;
  media.closest = selector => frame.closest(selector);
  const visible = () => !document.hidden && !window.frameElement?.hidden && frame.isConnected && !frame.closest('[hidden]');
  return {
    media,
    state(value) {
      const was = playing; playing = value === 'playing'; media.ended = value === 'ended'; previous = null;
      if (playing !== was || media.ended) media.dispatchEvent(new Event(media.ended?'ended':playing?'playing':'pause'));
    },
    advertising(value) { advert = value; previous = null; },
    sample(time, stamp = performance.now()) {
      if (!Number.isFinite(time) || time < 0 || !playing || advert || !visible()) { previous = null; return; }
      if (previous) {
        const delta=time-previous.time, wall=(stamp-previous.stamp)/1000;
        if (wall>0 && wall<=3 && delta>0 && delta<=wall*2+.15) {
          ranges.push([previous.time,time]); ranges.sort((a,b)=>a[0]-b[0]);
          ranges=ranges.reduce((all,item)=>{const last=all.at(-1);if(last&&item[0]<=last[1]+.025)last[1]=Math.max(last[1],item[1]);else all.push([...item]);return all;},[]);
        }
      }
      previous={time,stamp};
    },
    clear() { previous=null; },
  };
}
let youtubeReady;
function loadYoutube() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!youtubeReady) youtubeReady = new Promise((resolve,reject) => {
    const prior=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=()=>{prior?.();resolve(window.YT);};
    const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.async=true;script.onerror=()=>reject(new Error('youtube_api_unavailable'));document.head.append(script);
  }).catch(error=>{youtubeReady=null;throw error;});
  return youtubeReady;
}
export function prepareCourseEmbed(video) {
  const url=new URL(video.url,location.href);
  if(video.provider==='youtube') {url.searchParams.set('enablejsapi','1');url.searchParams.set('origin',location.origin);url.searchParams.set('playsinline','1');}
  return url.href;
}
export function trackCourseEmbed(frame, provider, material, note) {
  const sampler=playbackSampler(frame); trackCourseVideo(sampler.media,material,note);
  let timer, player, disposed=false;
  const onMessage=event=>{
    if(provider!=='rutube'||event.source!==frame.contentWindow||event.origin!==new URL(frame.src).origin)return;
    let message;try{message=typeof event.data==='string'?JSON.parse(event.data):event.data;}catch{return;}
    if(!message||typeof message!=='object')return;
    if(message.type==='player:changeState')sampler.state(message.data?.state==='stopped'?'ended':message.data?.state);
    if(message.type==='player:currentTime')sampler.sample(message.data?.time);
    if(message.type==='player:adStart')sampler.advertising(true);
    if(message.type==='player:adEnd')sampler.advertising(false);
    if(message.type==='player:rollState')sampler.advertising(message.data?.state==='play');
  };
  window.addEventListener('message',onMessage);
  if(provider==='youtube') void loadYoutube().then(YT=>{
    if(disposed||!frame.isConnected)return;
    player=new YT.Player(frame,{events:{onStateChange:event=>{
      sampler.state(event.data===YT.PlayerState.PLAYING?'playing':event.data===YT.PlayerState.ENDED?'ended':'paused');
    }}});
    timer=setInterval(()=>{if(player?.getPlayerState?.()===YT.PlayerState.PLAYING)sampler.sample(player.getCurrentTime());else sampler.clear();},500);
  }).catch(()=>{note.textContent='Видео можно смотреть. Сейчас не удалось подтвердить прогресс через плеер.';});
  function dispose() {if(disposed)return;disposed=true;clearInterval(timer);window.removeEventListener('message',onMessage);observer.disconnect();sampler.state('paused');}
  const observer=new MutationObserver(()=>{if(!frame.isConnected||!frame.getAttribute('src'))dispose();});observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});
  window.addEventListener('webpril:session-ended',dispose,{once:true});window.addEventListener('pagehide',dispose,{once:true});
  return dispose;
}
