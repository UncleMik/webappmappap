async (page) => {
  const accountId = '11111111-1111-4111-8111-111111111111';
  const base = 'https://app.legkie-rody.ru';
  const quota = used => ({ limit: 30, used, remaining: 30 - used, resetsAt: '2026-11-05T21:00:00Z' });
  const source = url => ({ id: url, title: 'Урок', url });
  const good = '/article.html?courseLesson=347472707&course=4302509&section=123';
  const course = '/my-courses.html?course=4302509';
  const sourceList = [source(good), source(base + good), source(course), source('/api/auth/logout'), source('//evil.example/x'), source('https://evil.example' + good), source(good + '#bad'), source(good + '&x=1'), source(course + '&next=logout'), source('/my-courses.html?course=0')];
  const savedAnswers = () => [
    { id: '3:answer', role: 'assistant', requestId: secondId, content: 'Ответ', createdAt: '2026-11-04T11:02:00Z', sources: sourceList },
    { id: '4:answer', role: 'assistant', requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', content: 'Ответ без ссылок', createdAt: '2026-11-04T11:03:00Z', sources: [source('/api/auth/logout')] },
  ];
  let post = 0, firstId, secondId, historyMode = 'failed', releaseFirst, releaseSuccess;
  let firstStarted, successStarted;
  const firstWaiting = new Promise(resolve => { firstStarted = resolve; });
  const successWaiting = new Promise(resolve => { successStarted = resolve; });
  await page.route(base + '/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (['/app-navigation.js', '/resource-prefetch.js'].includes(pathname)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    return route.fulfill({ status: 200, path: 'Фронт' + pathname });
  });
  await page.route(base + '/api/auth/session', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, user: { id: accountId, email: 'test@example.invalid', profile: { completedAt: '2026-11-01T00:00:00Z', stage: 'pregnancy', dueDate: '2027-02-01', name: 'Тест' } } }) }));
  await page.route(base + '/api/auth/ai/history', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    accountId, messages: historyMode === 'completed' ? savedAnswers() : [{ id: '1', role: 'user', status: historyMode, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', content: 'Старый вопрос', createdAt: '2026-11-04T11:00:00Z' }],
    hasMore: false, nextBefore: null, quota: quota(1)
  }) }));
  await page.route(base + '/api/auth/ai/messages', async route => {
    const body = JSON.parse(route.request().postData());
    post++;
    if (post === 1) {
      firstId = body.requestId;
      firstStarted();
      await new Promise(resolve => { releaseFirst = resolve; });
      await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'ai_unavailable' }) });
      return;
    }
    if (post === 2) {
      if (body.requestId !== firstId) throw new Error('Retry changed requestId');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        accountId, requestId: firstId, status: 'failed', messages: [{ id: '2', role: 'user', status: 'failed', requestId: firstId, content: body.text, createdAt: '2026-11-04T11:01:00Z' }], quota: quota(2)
      }) });
      return;
    }
    if (post === 4) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_ai_message' }) });
      return;
    }
    secondId = body.requestId;
    if (secondId === firstId) throw new Error('New question reused failed requestId');
    successStarted();
    await new Promise(resolve => { releaseSuccess = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      accountId, requestId: secondId, status: 'completed', messages: [
        { id: '3', role: 'user', status: 'completed', requestId: secondId, content: body.text, createdAt: '2026-11-04T11:02:00Z' },
        ...savedAnswers()
      ], quota: quota(3)
    }) });
  });
  await page.goto(base + '/ai.html');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 650 });
    await page.waitForTimeout(350); // Allow viewport and visualViewport resize handlers to settle.
    const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
      app: document.querySelector('.app').getBoundingClientRect().width,
      nav: document.querySelector('.bottom-navigation').getBoundingClientRect().bottom,
      input: document.querySelector('#chat-input').getBoundingClientRect().bottom }));
    if (layout.overflow || layout.app > width + 1 || layout.nav > 652 || layout.input > 652) throw new Error('Mobile layout overflow at ' + width + ': ' + JSON.stringify(layout));
  }
  await page.setViewportSize({ width: 320, height: 500 });
  await page.waitForTimeout(350);
  const compact = await page.evaluate(() => ({ input: document.querySelector('#chat-input').getBoundingClientRect().bottom, nav: document.querySelector('.bottom-navigation').getBoundingClientRect().top }));
  if (compact.input > compact.nav) throw new Error('Composer overlaps navigation in compact viewport');
  await page.getByText('Ответ не получен. Вопрос учтён', { exact: false }).waitFor();
  if (await page.locator('#chat-input').isDisabled()) throw new Error('Reloaded failed request blocked composer');
  await page.locator('#chat-input').fill('Вопрос два');
  await page.locator('.send-button').click();
  await firstWaiting;
  if (await page.locator('#chat-input').inputValue() !== '') throw new Error('Question stayed in composer while sending');
  if (await page.getByText('Вопрос два', { exact: true }).count() !== 1) throw new Error('Pending question was not shown exactly once');
  if (await page.locator('#chat-status').innerText() !== 'Лара готовит ответ…') throw new Error('Waiting status missing');
  releaseFirst();
  await page.locator('#chat-retry').waitFor({ state: 'visible' });
  if (!(await page.locator('#chat-input').isDisabled())) throw new Error('Unknown response allowed duplicate');
  if (await page.getByText('Вопрос два', { exact: true }).count() !== 1) throw new Error('Unknown result lost pending question');
  await page.locator('#chat-retry').click();
  await page.locator('.message-failed').last().waitFor();
  await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
  if (await page.locator('#chat-input').isDisabled()) throw new Error('Terminal failed request blocked composer');
  if (await page.getByText('Вопрос два', { exact: true }).count() !== 1) throw new Error('Failed response duplicated pending question');
  await page.locator('#chat-input').fill('Вопрос три');
  await page.locator('.send-button').click();
  await successWaiting;
  if (await page.locator('#chat-input').inputValue() !== '') throw new Error('Question stayed in composer before success');
  if (await page.getByText('Вопрос три', { exact: true }).count() !== 1) throw new Error('Success request was not shown while waiting');
  releaseSuccess();
  await page.getByText('Ответ', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
  const links = await page.locator('.message-sources a').evaluateAll(elements => elements.map(element => element.href));
  if (links.length !== 3 || links.some(link => ![base + '/article.html?courseLesson=347472707&course=4302509&section=123', base + '/my-courses.html?course=4302509'].includes(link))) throw new Error('Source allowlist incorrect: ' + links.join(', '));
  const toggle = page.getByRole('button', { name: 'Ссылка на материалы', exact: true });
  if (await toggle.count() !== 1) throw new Error('Expected one exact-label button only for answer with valid sources');
  const sourceLinks = page.locator('.message-sources a');
  if (await sourceLinks.count() !== 3 || await sourceLinks.filter({ visible: true }).count() !== 0 || await toggle.getAttribute('aria-expanded') !== 'false') throw new Error('Sources are not initially collapsed');
  await toggle.click();
  if (await sourceLinks.filter({ visible: true }).count() !== 3 || await toggle.getAttribute('aria-expanded') !== 'true') throw new Error('Click did not open sources');
  await toggle.click();
  if (await sourceLinks.filter({ visible: true }).count() !== 0 || await toggle.getAttribute('aria-expanded') !== 'false') throw new Error('Click did not close sources');
  await toggle.focus();
  await page.keyboard.press('Enter');
  if (await toggle.getAttribute('aria-expanded') !== 'true' || await sourceLinks.filter({ visible: true }).count() !== 3) throw new Error('Enter did not open sources');
  await page.keyboard.press('Space');
  if (await toggle.getAttribute('aria-expanded') !== 'false' || await sourceLinks.filter({ visible: true }).count() !== 0) throw new Error('Space did not close sources');
  await toggle.click();
  if (await page.locator('#chat-input').isDisabled()) throw new Error('Completed response blocked composer');
  if (await page.getByText('Вопрос три', { exact: true }).count() !== 1) throw new Error('Success response duplicated pending question');
  await page.locator('#chat-input').fill('Отклонённый вопрос');
  await page.locator('.send-button').click();
  await page.getByText('Проверьте текст вопроса и отправьте снова.', { exact: true }).waitFor();
  if (await page.locator('#chat-input').inputValue() !== 'Отклонённый вопрос') throw new Error('Rejected question was not restored to composer');
  if (await page.getByText('Отклонённый вопрос', { exact: true }).count() !== 0) throw new Error('Rejected question remained in conversation');
  if (await toggle.getAttribute('aria-expanded') !== 'true' || await sourceLinks.filter({ visible: true }).count() !== 3) throw new Error('Open sources were lost after a new question and merge');
  historyMode = 'completed';
  await page.reload();
  await page.getByText('Ответ без ссылок', { exact: true }).waitFor();
  if (await toggle.count() !== 1 || await toggle.getAttribute('aria-expanded') !== 'false' || await sourceLinks.filter({ visible: true }).count() !== 0) throw new Error('Reload did not restore collapsed state');
  historyMode = 'pending';
  await page.reload();
  await page.locator('#chat-retry').waitFor({ state: 'visible' });
  if (!(await page.locator('#chat-input').isDisabled())) throw new Error('Reloaded pending request allowed duplicate');
  const changed = await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('account:change', { detail: { user: { id: '22222222-2222-4222-8222-222222222222' } } }));
    return { messages: document.querySelectorAll('.message').length, disabled: document.querySelector('#chat-input').disabled };
  });
  if (changed.messages || !changed.disabled) throw new Error('Account change left private chat visible');
  historyMode = 'failed';
  await page.goto(base + '/ai.html');
  await page.locator('.message-failed').waitFor();
  const ended = await page.evaluate(() => {
    window.dispatchEvent(new Event('webpril:session-ended'));
    return { messages: document.querySelectorAll('.message').length, disabled: document.querySelector('#chat-input').disabled };
  });
  if (ended.messages || !ended.disabled) throw new Error('Session end left private chat visible');
  return { post, firstId, secondId, sources: links.length, sourceToggle: true, keyboard: true, persistOnMerge: true, collapsedOnReload: true, mobileWidths: [320, 390], compactHeight: 500, guards: true, immediateSend: true, rejectedTextRestored: true };
}
