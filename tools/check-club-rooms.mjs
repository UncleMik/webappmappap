async (page) => {
  const base = 'https://app.legkie-rody.ru';
  const account = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  let accountId = account, paid = false, purchaseFailure = false, wrongRoom = false, failSend = false;
  let releaseSearch, searchStarted, delayedSearch = false, holdList = false, releaseList;
  const bannerMetrics = [];
  const originalBios = [["Член Ассоциации «АКЕВ»", "Консультант по ГВ, сну и прикорму", "Преподаватель «ВОЗ ЮНИСЕФ» по грудному вскармливанию", "Сооснователь школы «Легкие роды» и ведущая курсов подготовки к родам", "Выпускница «МГУ» кафедры «Психология»", "Сопровождает роды в роддомах г. Москвы"], ["Ведёт беременности и роды разной степени сложности", "Проводит оперативные роды", "Приняла более 2000 родов", "Выпускница «БГМУ»", "Проходила стажировку в Хорватии в акушерско-гинекологическом отделении", "С 2017 г. работает в Клиническом госпитале «Мать и дитя» в г. Уфа"], ["Опыт работы более 10 лет", "Ведёт врачебную деятельность в одном из топовых родильных отделений Уфы — клиническом госпитале «Мать и дитя»", "Мама двух детей", "Закончила Башкирский медуниверситет, неоднократно проходила повышение квалификации в Санкт-Петербурге. Имеет диплом педиатра", "Более 5 лет проводит «Завтрак с неонатологом», где помогает мамам разобраться с проблемами в развитии малышей", "Максимально придерживается принципов доказательной медицины, но убеждена: в каждом деле важен индивидуальный подход"]];
  const originalRoles = ["Перинатальный психолог, доула, мама", "Врач акушер-гинеколог", "Врач-неонатолог"];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests = [], attempts = [], errors = [];
  const roomIds = ['pregnancy-trimester-1', 'pregnancy-trimester-2', 'pregnancy-trimester-3', 'mother-0-6', 'mother-6-plus', 'experts-birth', 'experts-motherhood'];
  const titles = ['Беременность — 1 триместр', 'Беременность — 2 триместр', 'Беременность — 3 триместр', 'Я мама — от 0 до 6 месяцев', 'Я мама — от 6 месяцев', 'По родам', 'По материнству'];
  const rooms = roomIds.map((id, i) => ({ id, title: titles[i], kind: i < 5 ? 'participants' : 'experts' }));
  const readState = { initialized: true, lastReadId: '1', unreadCount: 2, firstUnreadId: '2' };
  const meta = room => ({ accountId, room: wrongRoom ? rooms.find(r => r.id !== room.id) : room,
    access: room.kind === 'participants' || paid ? 'available' : 'purchase_required',
    canSend: room.kind === 'participants' || paid, canModerate: false, readState,
    serverTime: new Date().toISOString(), checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString() });
  const message = (room, id = '1') => ({ id, text: room.id + ' message ' + id, revision: id, deleted: false, createdAt: new Date().toISOString(), own: true, canDelete: true, author: { name: 'Тест' }, reply: null });
  const windowData = room => ({ ...meta(room), messages: [message(room), message(room, '2')], reactions: [], changeCursor: '2', hasBefore: false, hasAfter: false, hasMore: false });
  page.on('pageerror', error => errors.push(error.message));
  const check = (value, label) => { if (!value) throw new Error(label); };
  await page.route(base + '/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (['/app-navigation.js', '/resource-prefetch.js'].includes(pathname)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    return route.fulfill({ status: 200, path: 'Фронт' + pathname });
  });
  await page.route(base + '/api/auth/session', route => route.fulfill({ json: { authenticated: true, user: { id: accountId, email: 'test@example.invalid', profile: { completedAt: '2026-11-01T00:00:00Z', stage: 'pregnancy', dueDate: '2027-02-01', name: 'Тест' } } } }));
  await page.route(base + '/api/auth/club**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.slice('/api/auth/'.length), id = url.searchParams.get('room');
    requests.push({ path, id, account: route.request().headers()['x-webpril-account'] });
    if (path === 'club' && !id) {
      if (holdList) await new Promise(resolve => { releaseList=resolve; });
      return route.fulfill({ json: { accountId, serverTime: new Date().toISOString(), rooms: rooms.map(room => ({ ...room, ...meta(room), allowed: room.kind === 'participants' || paid,
      ...(room.kind === 'experts' && purchaseFailure ? { access: 'temporarily_unavailable', allowed: false } : {}) })) } });
    }
    const room = rooms.find(r => r.id === id);
    check(room, 'Club request omitted/invalid room: ' + url);
    if (room.kind === 'experts' && purchaseFailure) return route.fulfill({ status: 503, json: { error: 'club_unavailable', message: 'Не удалось проверить покупку.' } });
    if (path === 'club') return route.fulfill({ json: meta(room) });
    if (path === 'club/search') {
      if (delayedSearch) { searchStarted?.(); await new Promise(resolve => { releaseSearch = resolve; }); }
      return route.fulfill({ json: { ...windowData(room), nextBefore: null } });
    }
    if (path === 'club/read' || path === 'club/reactions/read' || path === 'club/reactions') return route.fulfill({ json: { ...meta(room), reactions: [] } });
    if (path.endsWith('/delete')) return route.fulfill({ json: meta(room) });
    if (path.startsWith('club/changes/')) return route.fulfill({ json: { ...windowData(room), messages: [] } });
    if (path === 'club/messages' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); attempts.push({ room: id, accountId, ...body });
      if (failSend) return route.abort('failed');
      return route.fulfill({ json: { ...meta(room), message: message(room, '3') } });
    }
    return route.fulfill({ json: windowData(room) });
  });
  await page.goto(base + '/club.html');
  await page.locator('#club-pregnancy-rooms a[href]').first().waitFor();
  check(await page.locator('#community-content a[href*="club-chat"]').count() === 5, 'Free rooms missing');
  check(await page.locator('#club-expert-rooms a[href="courses.html"]').count() === 2, 'Experts purchase gate missing');
  check(!(await page.locator('body').innerText()).includes('Чат участниц курса'), 'Legacy card remains');
  check(JSON.stringify(await page.locator('.speaker-full-bio').evaluateAll(bios => bios.map(bio => [...bio.querySelectorAll('li')].map(li => li.textContent))))===JSON.stringify(originalBios),'Original complete biographies changed');
  check(JSON.stringify(await page.locator('.speaker-full-role').allTextContents())===JSON.stringify(originalRoles),'Original full roles changed');
  check(await page.getByRole('tab').count() === 2, 'Expert tab remains');
  check(await page.locator('[data-category="participants"] [data-room]').count() === 7, 'Rooms not in main tab');
  const ordered = await page.locator('[data-category="participants"] [data-room]').evaluateAll(rows => rows.map(row => row.dataset.room));
  check(ordered.join('|') === [...roomIds.slice(5),...roomIds.slice(0,5)].join('|'), 'Room group order');
  check(await page.locator('#club-expert-rooms .club-room-lock:visible').count() === 2, 'Purchase-required locks missing');
  for (const [width,height] of [[320,568],[390,844],[500,900],[1440,900]]) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(200);
    for (let slide=0;slide<3;slide++) {
      await page.locator('[data-speaker="'+slide+'"]').click();
      const metric=await page.evaluate(() => {
        const banner=document.querySelector('.speaker-carousel'), active=banner.querySelector('.is-active');
        const box=banner.getBoundingClientRect(), image=active.querySelector('img'), description=active.querySelector('.speaker-description').getBoundingClientRect();
        return {width:innerWidth,height:innerHeight,bannerHeight:box.height,ratio:box.height/innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,bioInside:description.bottom<=box.bottom,photoContained:getComputedStyle(image).objectFit==='contain',font:parseFloat(getComputedStyle(active.querySelector('.speaker-description')).fontSize)};
      });
      bannerMetrics.push(metric);check(!metric.overflow && metric.bioInside && metric.photoContained && metric.font>=12, 'Compact carousel clipping '+JSON.stringify(metric));
      check(metric.ratio>=.28 && metric.ratio<=.43, 'Carousel height not near third '+JSON.stringify(metric));
      await page.screenshot({path:'output/playwright/club-grouped-'+width+'-slide-'+slide+'.png'});
      const toggle=page.locator('#speaker-toggle');
      check(await toggle.getAttribute('aria-expanded')==='false' && await toggle.getAttribute('aria-controls')==='speaker-bio-'+slide,'Collapsed disclosure state');
      await toggle.focus();await page.keyboard.press('Enter');
      check(await toggle.innerText()==='Свернуть' && await toggle.getAttribute('aria-expanded')==='true','Expand label/aria');
      const full=page.locator('#speaker-bio-'+slide);await full.waitFor();
      check(await full.locator('li').count()===6 && await page.locator('.speaker-full-bio:visible').count()===1,'Full bio content/speaker mismatch');
      const opened=await full.evaluate(bio => {const box=bio.getBoundingClientRect(),card=bio.closest('.speaker-carousel').getBoundingClientRect();return {inside:box.bottom<=card.bottom,unclipped:bio.scrollHeight<=bio.clientHeight,overflow:document.documentElement.scrollWidth>innerWidth};});
      check(opened.inside&&opened.unclipped&&!opened.overflow,'Expanded biography clipped '+width+' slide '+slide);
      check(await page.locator('.speaker-slide.is-active .speaker-description').isHidden(),'Preview duplicated full biography');
      if ((width===390 && slide===0)||(width===320 && slide===2)) await page.screenshot({path:'output/playwright/club-speaker-expanded-'+width+'-'+slide+'.png'});
      await page.keyboard.press('Space');
      check(await toggle.getAttribute('aria-expanded')==='false' && await toggle.innerText()==='Подробнее' && await full.isHidden(),'Keyboard collapse failed');

    }
  }
  check(await page.locator('.speaker-slide.is-active').evaluate(slide => getComputedStyle(slide).transitionDuration)==='0s','Reduced-motion CSS changed');
  await page.setViewportSize({width:320,height:568});await page.waitForTimeout(150);
  const disclosure=page.locator('#speaker-toggle');await disclosure.click();
  await page.waitForTimeout(5100);
  check(await page.locator('[data-speaker="2"]').getAttribute('aria-current')==='true','Auto advanced during reading');
  await page.locator('#speaker-bio-2 li').last().scrollIntoViewIfNeeded();
  await page.keyboard.press('Space');
  check(await disclosure.getAttribute('aria-expanded')==='false','Focused Space did not collapse');
  const focused=await disclosure.evaluate(button=>{const box=button.getBoundingClientRect(),nav=document.querySelector('.bottom-navigation').getBoundingClientRect();return document.activeElement===button&&box.top>=0&&box.bottom<=Math.min(innerHeight,nav.top);});
  check(focused,'Collapse left focused control offscreen');
  await page.screenshot({path:'output/playwright/club-speaker-collapse-focus-320.png'});
  await page.waitForTimeout(5100);
  check(await page.locator('[data-speaker="0"]').getAttribute('aria-current')==='true','Auto did not resume after collapse');
  await disclosure.click();await page.locator('[data-speaker="1"]').click();
  check(await disclosure.getAttribute('aria-expanded')==='false'&&await disclosure.getAttribute('aria-controls')==='speaker-bio-1'&&await page.locator('.speaker-full-bio:visible').count()===0,'Manual switch retained previous biography');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.getByRole('tab',{name:'События',exact:true}).click();
  await page.getByText('Событий пока нет.',{exact:true}).waitFor();
  await page.getByRole('tab',{name:'Чаты участниц',exact:true}).click();
  await page.locator('#search-toggle').click();await page.locator('#club-query').fill('По родам');
  check(await page.locator('[data-room]:visible').count()===1,'Search across main groups');
  await page.locator('#search-toggle').click();
  await page.setViewportSize({width:390,height:844});
  purchaseFailure = true; await page.reload();
  await page.locator('#club-access-retry').waitFor();
  check(await page.locator('#community-content a[href*="club-chat"]').count() === 5, 'GetCourse outage blocked free');
  check(await page.locator('#club-expert-rooms a[href]').count() === 0, 'GetCourse outage opened experts');
  check(await page.locator('.club-room-lock:visible').count()===0,'Verification error incorrectly means no purchase');
  await page.screenshot({path:'output/playwright/club-grouped-gc-error-390.png'});
  purchaseFailure = false; paid = true; await page.reload();
  await page.locator('#club-expert-rooms a[href*="club-chat"]').first().waitFor();
  check(await page.locator('#club-expert-rooms a[href*="club-chat"]').count() === 2, 'Any purchase did not open both experts');
  check(await page.locator('.club-room-lock:visible').count()===0,'Paid rooms still locked');
  await page.screenshot({path:'output/playwright/club-grouped-paid-390.png'});
  paid=false;await page.reload();await page.locator('#club-expert-rooms a[href="courses.html"]').first().waitFor();
  check(await page.locator('.club-room-lock:visible').count()===2,'Expired purchase did not lock experts');
  await page.screenshot({path:'output/playwright/club-grouped-expired-390.png'});
  holdList=true;await page.reload();await page.locator('[data-room]').first().waitFor();
  check(await page.locator('.club-room-lock:visible').count()===0 && await page.locator('[data-room][href]').count()===0,'Loading confused with absent purchase');
  holdList=false;releaseList();await page.locator('#club-expert-rooms a[href="courses.html"]').first().waitFor();
  const logout=await page.evaluate(() => {window.dispatchEvent(new Event('webpril:session-ended'));return {links:document.querySelectorAll('[data-room][href]').length,locks:document.querySelectorAll('.club-room-lock:not([hidden])').length};});
  check(logout.links===0&&logout.locks===0,'Logout retained room access/locks');
  paid=true;
  await page.goto(base + '/club-chat.html?room=pregnancy-students');
  await page.waitForURL(base + '/club.html#participants');
  check(!requests.some(request => request.id === 'pregnancy-students'), 'Legacy API called');
  for (let i = 0; i < rooms.length; i++) {
    await page.goto(base + '/club-chat.html?room=' + rooms[i].id);
    await page.locator('#chat-controls').waitFor();
    check(await page.locator('h1').innerText() === titles[i], 'Wrong room title');
    check((await page.locator('#chat-messages').innerText()).includes(rooms[i].id), 'Wrong room messages');
    await page.locator('#chat-text').fill('draft ' + rooms[i].id);
  }
  await page.goto(base + '/club-chat.html?room=' + rooms[0].id); await page.locator('#chat-controls').waitFor();
  check(await page.locator('#chat-text').inputValue() === 'draft ' + rooms[0].id, 'Room draft lost/mixed');
  for (const width of [320, 390, 500, 1440]) {
    await page.setViewportSize({ width, height: 650 }); await page.waitForTimeout(200);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#chat-form').getBoundingClientRect().bottom <= innerHeight), 'Chat overflow ' + width);
    await page.screenshot({ path: 'output/playwright/club-room-chat-' + width + '.png' });
  }
  await page.locator('#chat-search-toggle').click(); await page.locator('#chat-search-text').fill('message'); await page.locator('#chat-search-form button[type="submit"]').click();
  await page.locator('#chat-search-results li').first().waitFor();
  check((await page.locator('#chat-search-results').innerText()).includes(rooms[0].id), 'Search used wrong room');
  await page.locator('#chat-search-results button').last().click();
  await page.locator('.chat-message-more').first().click(); await page.locator('[data-chat-action="reply"]').click();
  await page.locator('#chat-reply').waitFor();
  failSend = true; await page.locator('#chat-send').click(); await page.locator('#chat-retry').waitFor();
  failSend = false; await page.locator('#chat-retry').click(); await page.locator('#chat-controls').waitFor();
  await page.locator('#chat-send').click(); await page.getByText('Сообщение отправлено.', { exact: true }).waitFor();
  check(attempts.length === 2 && attempts[0].requestId === attempts[1].requestId && attempts[0].room === rooms[0].id && attempts[1].replyTo === attempts[0].replyTo, 'Retry changed room/UUID/reply');
  await page.locator('.add-reaction').first().click(); await page.getByRole('button', { name: 'Сердце', exact: true }).click();
  await page.getByText('Реакция сохранена.', { exact: true }).waitFor();
  await page.locator('.chat-message-more').first().click(); await page.locator('[data-chat-action="delete"]').click(); await page.locator('#chat-delete-confirm').click();
  await page.locator('#chat-delete-dialog').waitFor({ state: 'hidden' });
  check(await page.locator('.discussion-message[data-id="1"]').count() === 0, 'Deletion did not remove room message');
  delayedSearch = true;
  const waitSearch = new Promise(resolve => { searchStarted = resolve; });
  await page.locator('#chat-search-toggle').click(); await page.locator('#chat-search-text').fill('delayed'); await page.locator('#chat-search-form button[type="submit"]').click();
  await waitSearch;
  await page.goto(base + '/club-chat.html?room=' + rooms[1].id); await page.locator('#chat-controls').waitFor();
  releaseSearch(); await page.waitForTimeout(100);
  check(!(await page.locator('#chat-messages').innerText()).includes(rooms[0].id), 'Late old room search affected next room');
  delayedSearch = false;
  check(await page.locator('#chat-text').inputValue() === 'draft ' + rooms[1].id, 'Other draft damaged by send');
  accountId = other; await page.reload(); await page.locator('#chat-controls').waitFor();
  check(await page.locator('#chat-text').inputValue() === '', 'Account draft leaked');
  await page.locator('#chat-text').fill('other account');
  await page.evaluate(() => window.dispatchEvent(new Event('webpril:session-ended')));
  check(await page.locator('#chat-messages > *').count() === 0 && await page.locator('#chat-text').inputValue() === '', 'Session end did not wipe UI');
  check(await page.evaluate(({id, room}) => localStorage.getItem('webpril:club-draft:v1:' + room + ':' + id), { id: other, room: rooms[1].id }) === null, 'Session draft not purged');
  accountId = account; wrongRoom = true; await page.goto(base + '/club-chat.html?room=' + rooms[0].id);
  await page.getByText('Не удалось подтвердить комнату. Повторите подключение.', { exact: true }).waitFor();
  check(await page.locator('#chat-messages > *').count() === 0 && await page.locator('#chat-controls').isHidden(), 'Mismatched response exposed room');
  wrongRoom = false;
  const emptyClubScript = route => route.fulfill({status:200,contentType:'text/javascript',body:''});
  await page.route(base+'/club.js**',emptyClubScript);await page.goto(base+'/club.html');
  await page.locator('[data-room]').first().waitFor();
  await page.evaluate(() => document.querySelectorAll('#speaker-toggle,.speaker-full-bio').forEach(element=>element.remove()));
  await page.unroute(base+'/club.js**',emptyClubScript);await page.addScriptTag({url:base+'/club.js?v=20261105-speaker-bios'});
  await page.locator('[data-speaker="1"]').click();await page.waitForTimeout(5100);
  check(await page.locator('[data-speaker="2"]').getAttribute('aria-current')==='true','Old DOM auto carousel broke');
  await page.getByRole('tab',{name:'События',exact:true}).click();
  check(await page.getByRole('tab',{name:'События',exact:true}).getAttribute('aria-selected')==='true','Old DOM tabs broke');
  await page.getByRole('tab',{name:'Чаты участниц',exact:true}).click();await page.locator('#search-toggle').click();
  check(await page.locator('#club-search').isVisible(),'Old DOM search broke');
  check(!errors.length, 'Browser errors: ' + errors.join(';'));
  check(requests.filter(r => r.path !== 'club').every(r => roomIds.includes(r.id)), 'Endpoint without room');
  return { groupedMainList: true, freePaidExpiredErrorLoadingLogout: true, carouselMetrics: bannerMetrics, carouselDotsAutoAndReducedMotionCss: true, fullBiographiesExact: true, missingDisclosureDomCompatibility: true, disclosureKeyboardAndAria: true, autoPauseReadingAndResume: true, manualSwitchCollapses: true, collapseFocusVisible: true, rooms: 7, freeRoomsDuringPurchaseFailure: 5, paidExperts: 2, widths: [320,390,500,1440], legacyRedirect: true, roomAccountDraftIsolation: true, searchRoom: true, delayedRoomSearch: true, reactions: true, deletion: true, replyPendingUuidRetry: true, sessionWipe: true, mismatchedResponseRejected: true, requests: requests.length, errors };
}

