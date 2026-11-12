async page => {
  const base = 'https://app.legkie-rody.ru';
  const accountId = '11111111-1111-4111-8111-111111111111';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(base + '/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/session') return route.fulfill({ json: { authenticated: true, user: { id: accountId, email: 'test@example.invalid', profile: { completedAt: '2026-11-01T00:00:00Z', stage: 'pregnancy', dueDate: '2027-02-01', name: 'Тест', goals: [] } } } });
    if (pathname === '/api/auth/ai/conversations') return route.fulfill({ json: { accountId, conversations: [], hasMore: false } });
    if (pathname === '/api/auth/ai/quota') return route.fulfill({ json: { accountId, quota: { limit: 30, remaining: 30 } } });
    if (pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.fulfill({ path: 'Фронт' + pathname });
  });
  const results = [];
  for (const mode of ['direct', 'iframe']) {
    await page.goto(base + (mode === 'direct' ? '/ai.html' : '/index.html'));
    if (mode === 'iframe') await page.locator('body > .bottom-navigation a[href="ai.html"]').click();
    const frame = mode === 'direct' ? page : page.frameLocator('iframe[data-app-panel="ai.html"]');
    const input = frame.locator('#chat-input');
    await input.waitFor({ state: 'visible' });
    await input.fill('Тест'); await input.focus();
    if (!await input.evaluate(element => !element.disabled && document.activeElement === element && element.value === 'Тест')) throw Error(mode + ': input unavailable');
    await page.evaluate(() => {
      const viewport = visualViewport;
      // Model independently shifted fixed navigation and visual viewport; the old formula collapsed to zero. This is not OS keyboard emulation.
      window.__testViewport = { top: 350, height: 400 };
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => window.__testViewport.top });
      Object.defineProperty(viewport, 'pageTop', { configurable: true, get: () => window.__testViewport.top });
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => window.__testViewport.height });
      const nav = document.querySelector('body > .bottom-navigation'), real = nav.getBoundingClientRect.bind(nav);
      nav.getBoundingClientRect = () => { const rect = real(); return new DOMRect(rect.x, 320, rect.width, rect.height); };
      viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll'));
    });
    const panel = page.locator(mode === 'direct' ? 'body > .app' : 'iframe[data-app-panel="ai.html"]');
    const box = await panel.boundingBox();
    if (!box || box.height < 300) throw Error(mode + ': collapsed chat: ' + JSON.stringify(box));
    const inputBox = await input.boundingBox();
    if (!inputBox || inputBox.y < 349 || inputBox.y + inputBox.height > 751) throw Error(mode + ': composer outside visible viewport: ' + JSON.stringify(inputBox));
    await page.evaluate(() => { window.__testViewport.top = 0; window.__testViewport.height = 844; visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll')); });
    const closed = await panel.boundingBox();
    if (!closed || Math.abs(closed.y) > 1 || closed.height < 700) throw Error(mode + ': keyboard close did not restore chat: ' + JSON.stringify(closed));
    results.push({ mode, height: box.height, composerBottom: inputBox.y + inputBox.height, closedHeight: closed.height });
  }
  return results;
}

