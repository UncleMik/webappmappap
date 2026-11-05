async (page) => {
  const base = 'https://app.legkie-rody.ru';
  const accountId = '11111111-1111-4111-8111-111111111111';
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let reason = 'Не удалось уверенно прочитать показатели. Прикрепите более чёткий файл или фото.';
  const quota = { limit: 30, used: 1, remaining: 29, resetsAt: '2026-11-06T21:00:00Z' };
  let mode = 'failed', posts = 0, statusLookups = 0, submittedId;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const user = (id, status = 'failed') => ({ id: '1', role: 'user', requestId: id, status, content: 'Мой вопрос', createdAt: new Date().toISOString(), ...(status === 'failed' ? { failureCode: 'attachment_unreadable', failureMessage: reason } : {}) });
  await page.route(base + '/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (['/app-navigation.js', '/resource-prefetch.js'].includes(pathname)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    return route.fulfill({ status: 200, path: 'Фронт' + pathname });
  });
  await page.route(base + '/api/auth/session', route => route.fulfill({ json: { authenticated: true, user: { id: accountId, email: 'test@example.invalid', profile: { completedAt: '2026-11-01T00:00:00Z', stage: 'pregnancy', dueDate: '2027-02-01', name: 'Тест' } } } }));
  await page.route(base + '/api/auth/ai/history', route => route.fulfill({ json: { accountId, messages: mode === 'empty' ? [] : [user(requestId, mode)], hasMore: false, nextBefore: null, quota } }));
  await page.route(base + '/api/auth/ai/messages', route => {
    posts++; submittedId = route.request().postDataJSON().requestId;
    return route.fulfill({ json: { accountId, requestId: submittedId, status: 'failed', failureMessage: 'Raw provider detail must not replace canonical reason', messages: [user(submittedId)], quota } });
  });
  await page.route(base + '/api/auth/ai/messages/status', route => {
    statusLookups++;
    if (route.request().postDataJSON().requestId !== requestId) throw new Error('Restored status UUID changed');
    return route.fulfill({ json: { accountId, requestId, status: 'failed', messages: [user(requestId)], quota } });
  });
  const assertReason = async () => {
    await page.locator('.message-failed').waitFor();
    if (await page.locator('.message-failed').innerText() !== reason) throw new Error('Failed bubble lost canonical reason');
    if (await page.locator('#chat-status').innerText() !== reason + ' Вопрос учтён в дневном лимите; можно задать новый.') throw new Error('Notice lost canonical reason');
    if (await page.locator('#chat-input').isDisabled()) throw new Error('Terminal failure blocked composer');
    if ((await page.locator('body').innerText()).includes('Raw provider detail')) throw new Error('Raw detail shown');
  };
  await page.goto(base + '/ai.html'); await assertReason();
  await page.reload(); await assertReason();
  mode = 'empty'; await page.reload(); await page.locator('#chat-input').fill('Мой вопрос'); await page.locator('.send-button').click(); await assertReason();
  if (posts !== 1) throw new Error('Failure sent twice');
  mode = 'pending'; await page.reload(); await page.locator('#chat-retry').waitFor(); await page.locator('#chat-retry').click(); await assertReason();
  if (posts !== 1 || statusLookups !== 1) throw new Error('Status resent original UUID');
  reason = '<img src=x onerror="window.failureMarkupExecuted=true">'; mode = 'failed'; await page.reload(); await assertReason();
  if (await page.locator('.message-failed img, #chat-status img').count() || await page.evaluate(() => window.failureMarkupExecuted)) throw new Error('Failure markup executed');
  if (errors.length) throw new Error(errors.join(';'));
  return { canonicalBubble: true, canonicalNotice: true, historyReload: true, post: true, statusUuid: true, noRawProviderDetail: true, failureMarkupPlainText: true, posts, statusLookups, errors };
}
