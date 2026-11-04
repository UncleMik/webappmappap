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
  const assertWaiting = async (expected, phase) => {
    const waiting = page.locator('#conversation .waiting-message');
    await waiting.waitFor({ state: expected ? 'visible' : 'detached' });
    if (await waiting.count() !== (expected ? 1 : 0)) throw new Error('Wrong waiting bubble count: ' + phase);
    if (expected) {
      if (await page.locator('#conversation .assistant-message.waiting-message').count() !== 1) throw new Error('Waiting bubble has wrong speaker: ' + phase);
      if (!(await waiting.isVisible()) || await waiting.locator('.bubble').innerText() !== 'Лара готовит ответ…') throw new Error('Waiting bubble is not an assistant answer: ' + phase);
      if (await page.locator('#conversation > :last-child.waiting-message').count() !== 1) throw new Error('Waiting bubble is not after user question: ' + phase);
    }
    if ((await page.locator('#chat-status').innerText()).includes('Лара готовит ответ')) throw new Error('Waiting text remained in footer: ' + phase);
    if ((await page.locator('#history-list').innerText()).includes('Лара готовит ответ')) throw new Error('Fake assistant answer leaked into history: ' + phase);
  };
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
  await assertWaiting(false, 'failed history');
  await page.locator('#chat-input').fill('Вопрос два');
  await page.locator('.send-button').click();
  await firstWaiting;
  if (await page.locator('#chat-input').inputValue() !== '') throw new Error('Question stayed in composer while sending');
  if (await page.getByText('Вопрос два', { exact: true }).count() !== 1) throw new Error('Pending question was not shown exactly once');
  await assertWaiting(true, 'delayed request');
  releaseFirst();
  await page.locator('#chat-retry').waitFor({ state: 'visible' });
  if (!(await page.locator('#chat-input').isDisabled())) throw new Error('Unknown response allowed duplicate');
  if (await page.getByText('Вопрос два', { exact: true }).count() !== 1) throw new Error('Unknown result lost pending question');
  await assertWaiting(false, 'unknown failure');
  if (!(await page.locator('#chat-status').isVisible()) || !(await page.locator('#chat-status').innerText())) throw new Error('Unknown failure lost footer error');
  await page.locator('#chat-retry').click();
  await page.locator('.message-failed').last().waitFor();
  await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
  if (await page.locator('#chat-input').isDisabled()) throw new Error('Terminal failed request blocked composer');
  if (await page.getByText('Вопрос два', { exact: true }).count() !== 1) throw new Error('Failed response duplicated pending question');
  await assertWaiting(false, 'terminal failure');
  await page.locator('#chat-input').fill('Вопрос три');
  await page.locator('.send-button').click();
  await successWaiting;
  if (await page.locator('#chat-input').inputValue() !== '') throw new Error('Question stayed in composer before success');
  if (await page.getByText('Вопрос три', { exact: true }).count() !== 1) throw new Error('Success request was not shown while waiting');
  await assertWaiting(true, 'delayed success');
  if (await page.locator('#conversation .assistant-message:not(.waiting-message)').count() !== 0) throw new Error('Unexpected assistant answer before success');
  releaseSuccess();
  await page.getByText('Ответ', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
  await assertWaiting(false, 'successful replacement');
  if (await page.locator('#conversation .assistant-message').count() !== 2 || await page.locator('#conversation .assistant-message .bubble').allTextContents().then(texts => texts.join('|')) !== 'Ответ|Ответ без ссылок') throw new Error('Success duplicated or lost assistant answers');
  const links = await page.locator('.message-sources a').evaluateAll(elements => elements.map(element => element.href));
  if (links.length !== 3 || links.some(link => ![base + '/article.html?courseLesson=347472707&course=4302509&section=123', base + '/my-courses.html?course=4302509'].includes(link))) throw new Error('Source allowlist incorrect: ' + links.join(', '));
  const toggle = page.getByRole('button', { name: 'Ссылки на материалы', exact: true });
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
  await assertWaiting(false, 'rejected request');
  if (await toggle.getAttribute('aria-expanded') !== 'true' || await sourceLinks.filter({ visible: true }).count() !== 3) throw new Error('Open sources were lost after a new question and merge');
  historyMode = 'completed';
  await page.reload();
  await page.getByText('Ответ без ссылок', { exact: true }).waitFor();
  await assertWaiting(false, 'completed history');
  if (await toggle.count() !== 1 || await toggle.getAttribute('aria-expanded') !== 'false' || await sourceLinks.filter({ visible: true }).count() !== 0) throw new Error('Reload did not restore collapsed state');
  historyMode = 'pending';
  await page.reload();
  await page.locator('#chat-retry').waitFor({ state: 'visible' });
  if (!(await page.locator('#chat-input').isDisabled())) throw new Error('Reloaded pending request allowed duplicate');
  await assertWaiting(true, 'restored pending history');
  const changed = await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('account:change', { detail: { user: { id: '22222222-2222-4222-8222-222222222222' } } }));
    return { messages: document.querySelectorAll('.message').length, disabled: document.querySelector('#chat-input').disabled };
  });
  if (changed.messages || !changed.disabled) throw new Error('Account change left private chat visible');
  await assertWaiting(false, 'account clear');
  historyMode = 'pending';
  await page.goto(base + '/ai.html');
  await page.locator('#chat-retry').waitFor({ state: 'visible' });
  await assertWaiting(true, 'pending before session end');
  const ended = await page.evaluate(() => {
    window.dispatchEvent(new Event('webpril:session-ended'));
    return { messages: document.querySelectorAll('.message').length, disabled: document.querySelector('#chat-input').disabled };
  });
  if (ended.messages || !ended.disabled) throw new Error('Session end left private chat visible');
  await assertWaiting(false, 'session end');
  // Upload UI uses real browser File objects and fully intercepted API traffic.
  historyMode = 'completed';
  await page.goto(base + '/ai.html');
  await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
  const picker = page.locator('#analysis-file');
  const chip = page.locator('#selected-attachment');
  const pdf = { name: 'Анализ <без HTML>.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nsynthetic lab results') };
  const choose = async file => { await picker.setInputFiles(file); };
  const assertChip = async name => {
    if (await chip.isVisible() !== !!name || name && await page.locator('#attachment-name').innerText() !== name) throw new Error('Selected attachment mismatch');
  };
  await picker.evaluate(element => { element.click = () => { element.dataset.opened = String(Number(element.dataset.opened || 0) + 1); }; });
  for (const trigger of ['#attachment', '#analysis-attachment']) {
    await page.locator(trigger).click(); await choose(pdf); await assertChip(pdf.name);
  }
  if (await picker.getAttribute('data-opened') !== '2') throw new Error('Upload buttons did not open picker');
  await picker.setInputFiles([]); await assertChip(pdf.name); // Cancellation keeps previous selection.
  await choose({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('not a lab') });
  await page.getByText('Выберите один PDF, JPG или PNG до 10 МБ.', { exact: true }).waitFor();
  await assertChip(pdf.name);
  await choose({ name: 'large.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(10485761, 32) });
  await assertChip(pdf.name);
  for (const [name, mimeType] of [['scan.jpg', 'image/jpeg'], ['scan.png', 'image/png']]) {
    await choose({ name, mimeType, buffer: Buffer.from([1, 2, 3]) }); await assertChip(name);
  }
  await choose({ ...pdf, mimeType: '' }); await assertChip(pdf.name);
  if (await chip.locator('img,script').count()) throw new Error('Filename interpreted as HTML');
  await page.locator('#attachment-remove').click(); await assertChip(null);
  if (await page.locator('.send-button').getAttribute('aria-label') !== 'Записать голосом') throw new Error('Empty composer did not return to microphone');
  await choose({ ...pdf, mimeType: '' });
  for (const width of [320, 390, 500]) {
    await page.setViewportSize({ width, height: 500 }); await page.waitForTimeout(100);
    const uploadLayout = await page.evaluate(() => {
      const row = document.querySelector('.suggestions').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth,
        composerOverlaps: document.querySelector('#chat-input').getBoundingClientRect().bottom > document.querySelector('.bottom-navigation').getBoundingClientRect().top,
        clipped: [...document.querySelectorAll('.suggestions button')].some(button => {
          const box = button.getBoundingClientRect();
          if (box.left < row.left - 1 || box.right > row.right + 1) return true;
          return [...button.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).some(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            return [...range.getClientRects()].some(rect => rect.left < box.left - 1 || rect.right > box.right + 1 || rect.top < box.top - 1 || rect.bottom > box.bottom + 1);
          });
        }) };
    });
    if (uploadLayout.overflow || uploadLayout.composerOverlaps || uploadLayout.clipped) throw new Error('Upload composer overflow at ' + width + ': ' + JSON.stringify(uploadLayout));
  }
  let uploadPosts = 0, uploadStatus = 0, originalUpload, releaseUpload, uploadStarted;
  const uploadWaiting = new Promise(resolve => { uploadStarted = resolve; });
  await page.unroute(base + '/api/auth/ai/messages');
  await page.route(base + '/api/auth/ai/messages', async route => {
    const body = JSON.parse(route.request().postData()); uploadPosts++;
    if (uploadPosts === 1) {
      originalUpload = body; uploadStarted(); await new Promise(resolve => { releaseUpload = resolve; });
      return route.fulfill({ status: 502, json: { error: 'ai_unavailable' } });
    }
    if (uploadPosts === 2) {
      if (JSON.stringify(body) !== JSON.stringify(originalUpload)) throw new Error('Unknown upload retry changed UUID, text or bytes');
      return route.fulfill({ status: 503, json: { error: 'ai_upload_busy' } });
    }
    if (uploadPosts === 6) {
      if (body.attachment.mimeType !== 'image/jpeg' || body.attachment.data !== Buffer.from([255, 216, 255, 217]).toString('base64')) throw new Error('Octet-stream JPEG inference changed MIME or bytes');
      return route.fulfill({ status: 413, json: { error: 'invalid_ai_attachment' } });
    }
    if (uploadPosts === 5) return route.fulfill({ json: { accountId, requestId: body.requestId, status: 'failed', failureMessage: 'Не удалось прочитать анализ <без HTML>.', quota: quota(5), messages: [
      { id: 'failed:upload', role: 'user', status: 'failed', requestId: body.requestId, content: body.text + '\n\nФайл анализа: ' + body.attachment.name }
    ] } });
    return route.fulfill({ status: uploadPosts === 3 ? 503 : 413, json: { error: uploadPosts === 3 ? 'ai_upload_busy' : 'invalid_ai_attachment' } });
  });
  await page.route(base + '/api/auth/ai/messages/status', async route => {
    const body = JSON.parse(route.request().postData()); uploadStatus++;
    if (Object.keys(body).join() !== 'requestId' || body.requestId !== originalUpload.requestId) throw new Error('Status lookup resent private file');
    if (uploadStatus === 1) return route.fulfill({ status: 404, json: { error: 'ai_request_not_found' } });
    return route.fulfill({ json: { accountId, requestId: body.requestId, status: 'completed', quota: quota(4), messages: [
      { id: 'upload:question', role: 'user', status: 'completed', requestId: body.requestId, content: originalUpload.text + '\n\nФайл анализа: ' + originalUpload.attachment.name },
      { id: 'upload:answer', role: 'assistant', requestId: body.requestId, content: 'Разбор готов', sources: [] }
    ] } });
  });
  await page.locator('.send-button').click(); await uploadWaiting;
  await assertChip(null); await assertWaiting(true, 'attachment-only send');
  if (originalUpload.text !== 'Помоги разобраться с результатами анализов.' || originalUpload.attachment.data !== pdf.buffer.toString('base64') || originalUpload.attachment.mimeType !== pdf.mimeType) throw new Error('Attachment transport mismatch');
  if (await page.locator('#chat-input').inputValue()) throw new Error('Upload left text in composer');
  releaseUpload(); await page.locator('#chat-retry').waitFor({ state: 'visible' });
  await page.locator('#chat-retry').click();
  await page.getByText('Обработка файлов сейчас занята.', { exact: false }).waitFor();
  if (uploadPosts !== 2 || uploadStatus !== 1) throw new Error('404 recovery did not resend once');
  if (!(await page.locator('#chat-input').isDisabled()) || await chip.isVisible() || await page.locator('.user-message').filter({ hasText: 'Файл анализа:' }).count() !== 1) throw new Error('Busy uncertain retry discarded UUID or restored a new composer');
  await page.locator('#chat-retry').click(); await page.getByText('Разбор готов', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
  if (uploadPosts !== 2 || uploadStatus !== 2 || await page.locator('.user-message').filter({ hasText: 'Файл анализа:' }).count() !== 1) throw new Error('Upload result duplicate or extra send');
  await assertChip(null); await assertWaiting(false, 'upload result');
  if ((await page.locator('#chat-quota').innerText()) !== 'Осталось вопросов сегодня: 26 из 30') throw new Error('Upload quota changed on lookup');
  await page.locator('#chat-input').fill('Мой вопрос'); await choose(pdf);
  await page.locator('.send-button').click();
  await page.getByText('Обработка файлов сейчас занята.', { exact: false }).waitFor(); await assertChip(pdf.name);
  if (await page.locator('#chat-input').inputValue() !== 'Мой вопрос') throw new Error('Busy upload lost text');
  await page.locator('.send-button').click();
  await page.getByText('Не удалось отправить файл.', { exact: false }).waitFor(); await assertChip(pdf.name);
  await page.locator('.send-button').click();
  await page.getByText('Не удалось прочитать анализ <без HTML>. Вопрос учтён в дневном лимите; можно задать новый.', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
  await assertChip(null);
  if (await page.locator('#chat-input').inputValue() || await page.locator('#chat-status img').count()) throw new Error('Accepted failure restored file/text or rendered markup');
  await choose({ name: 'scan.jpeg', mimeType: 'application/octet-stream', buffer: Buffer.from([255, 216, 255, 217]) });
  await page.locator('.send-button').click();
  await page.getByText('Не удалось отправить файл.', { exact: false }).waitFor(); await assertChip('scan.jpeg');
  await page.evaluate(() => window.dispatchEvent(new Event('webpril:session-ended')));
  await assertChip(null);
  if (await page.locator('#conversation .message').count() || !(await page.locator('#attachment').isDisabled())) throw new Error('Session end retained upload state');
  historyMode = 'pending'; await page.goto(base + '/ai.html');
  await page.locator('#chat-retry').waitFor({ state: 'visible' });
  await page.unroute(base + '/api/auth/ai/messages/status');
  await page.route(base + '/api/auth/ai/messages/status', route => route.fulfill({ json: { accountId, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'failed', messages: [{ id: '1', role: 'user', status: 'failed', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', content: 'Старый вопрос' }], quota: quota(4) } }));
  await page.locator('#chat-retry').click();
  await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
  if (uploadPosts !== 6) throw new Error('Restored history resent an upload');
  await choose(pdf);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('account:change', { detail: { user: { id: '22222222-2222-4222-8222-222222222222' } } })));
  await assertChip(null);
  return { uploads: { selectRemove: true, typeSize: true, cancelledSelectionPreserved: true, pdfJpgPng: true, inferredMimePreservesBytes: true, attachmentOnly: true, sameBytesUuidRetry: true, uncertainBusyKeepsRequest: true, statusLookup: true, restoredHistoryStatusOnly: true, rejectionRestoresFile: true, acceptedFailureMessageAndDeletion: true, allSuggestionTextVisible: true, sessionAccountWipe: true, mobileWidths: [320, 390, 500] }, post, firstId, secondId, sources: links.length, sourceToggle: true, keyboard: true, persistOnMerge: true, collapsedOnReload: true, mobileWidths: [320, 390], compactHeight: 500, guards: true, immediateSend: true, rejectedTextRestored: true, waitingAssistantBubble: true, waitingReplacedOnSuccess: true, waitingExcludedFromHistory: true, pendingHistoryRestored: true };
}
