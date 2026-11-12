/* No cached private pages; every navigation uses the normal server session check. */
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let data;try{data=event.data?.json();}catch{return;}
    if(!data||typeof data.accountId!=='string'||!/^\d{1,19}$/.test(String(data.id)))return;
    // Delayed messages are only hints: fetch current authenticated visibility.
    try {
      const session=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'});
      if(!session.ok)return;
      const state=await session.json();
      if(state.user?.id!==data.accountId)return;
      const response=await fetch('/api/auth/notifications',{credentials:'same-origin',cache:'no-store',headers:{'X-Webpril-Account':data.accountId}});
      if(!response.ok)return;
      const current=await response.json(),prefs=current.preferences;
      const item=current.items?.find(item=>String(item.id)===String(data.id));
      if(current.accountId!==data.accountId||current.pushSessionId!==data.sessionId||!prefs?.pushEnabled||!current.pushPublicKey||!item||!prefs.types?.[item.type])return;
      const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:prefs.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));
      if(hour>=21||hour<9)return;
      const a=prefs.quietStart,b=prefs.quietEnd;
      if(a!==b&&(a<b?hour>=a&&hour<b:hour>=a||hour<b))return;
    }catch{return;}
    await self.registration.showNotification('Лёгкие роды',{body:'Для вас есть новое уведомление в приложении.',tag:'webpril-for-you',data:{url:'/index.html'},renotify:false});
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    let url;try{url=new URL(event.notification.data?.url||'/index.html',self.location.origin);}catch{return;}
    if(url.origin!==self.location.origin)return;
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const client=windows.find(client=>new URL(client.url).origin===url.origin);
    if(client){await client.navigate(url.href);await client.focus();}else await self.clients.openWindow(url.href);
  })());
});
