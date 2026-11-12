/* Opt-in push helpers. Permission is requested only from an explicit user action. */
(() => {
  const accountId = () => window.webprilSessionAccountId || window.webprilAccount?.user?.id || null;
  let subscribedAccount = null;
  async function clearLocalPush(unsubscribe = false) {
    const registration=await navigator.serviceWorker?.getRegistration('/');
    for(const notice of await registration?.getNotifications() || [])notice.close();
    if(unsubscribe)await (await registration?.pushManager.getSubscription())?.unsubscribe();
  }
  window.addEventListener('webpril:session-ended',()=>{subscribedAccount=null;void clearLocalPush(true).catch(()=>{});});
  window.addEventListener('account:change',()=>{if(subscribedAccount&&subscribedAccount!==accountId()){subscribedAccount=null;void clearLocalPush(true).catch(()=>{});}});
  const call = async (method, body) => {
    const account = accountId();
    if (!account) throw new Error('Сначала войдите в приложение.');
    const response = await fetch('/api/auth/notifications/' + method, {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Webpril-Account':account},body:JSON.stringify(body),cache:'no-store'});
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Не удалось изменить уведомления.');
    return data;
  };
  function keyBytes(key) {
    const raw=atob(key.replace(/-/g,'+').replace(/_/g,'/'));
    return Uint8Array.from(raw,c=>c.charCodeAt(0));
  }
  window.WebprilPush = {
    supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext,
    // accountId and api are injectable to match the existing authenticated client.
    async enable({publicKey,api=call}={}) {
      if (!this.supported() || !publicKey) throw new Error('Этот браузер пока не поддерживает уведомления.');
      const initialAccount=accountId();
      const permission=await Notification.requestPermission();
      if(permission!=='granted') return {enabled:false,permission};
      const registration=await navigator.serviceWorker.register('/push-worker.js',{scope:'/'});
      await navigator.serviceWorker.ready;
      const previous=await registration.pushManager.getSubscription();
      const subscription=previous || await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(publicKey)});
      try {if(initialAccount && accountId()!==initialAccount)throw new Error('Аккаунт изменился.');await api('subscribe',subscription.toJSON());subscribedAccount=initialAccount;}
      catch(error) {if(!previous)await subscription.unsubscribe();throw error;}
      return {enabled:true,permission};
    },
    async disable({api=call}={}) {
      const registration=await navigator.serviceWorker.getRegistration('/');
      const subscription=await registration?.pushManager.getSubscription();
      if(subscription) {await api('unsubscribe',{endpoint:subscription.endpoint});await subscription.unsubscribe();}
      else await api('preferences',{pushEnabled:false});
      subscribedAccount=null;await clearLocalPush();
      return {enabled:false};
    },
    async preferences(patch,{api=call}={}) {const result=await api('preferences',patch);if(patch.babyPause||patch.pauseBaby||patch.pushEnabled===false)await clearLocalPush();return result;},
  };
})();
