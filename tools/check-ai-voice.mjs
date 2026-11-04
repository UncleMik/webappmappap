async page => {
  const base = 'https://app.legkie-rody.ru', accountId = '11111111-1111-4111-8111-111111111111';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.addInitScript(() => {
    window.voiceMock = { calls: 0, stopped: 0, mode: 'normal', size: 20 };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async constraints => {
      const state = window.voiceMock; state.calls++; state.constraints = constraints;
      if (state.mode === 'denied') throw new DOMException('denied', 'NotAllowedError');
      const stream = { getTracks: () => [{ stop() { state.stopped++; } }] };
      if (state.mode === 'late') return new Promise(resolve => { state.grant = () => resolve(stream); });
      return stream;
    } } });
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
      constructor(stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => { this.ondataavailable?.({ data: new Blob([new Uint8Array(window.voiceMock.size).fill(42)], { type: this.mimeType }) }); this.onstop?.(); });
      }
    };
  });
  await page.route(base + '/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (['/app-navigation.js', '/resource-prefetch.js'].includes(path)) return route.fulfill({ body: '', contentType: 'text/javascript' });
    return route.fulfill({ path: 'Фронт' + path });
  });
  await page.route(base + '/api/auth/session', route => route.fulfill({ json: { authenticated: true, user: { id: accountId, email: 'synthetic@example.invalid', profile: { completedAt: '2026-11-01', stage: 'pregnancy', dueDate: '2027-02-01', name: 'Тест' } } } }));
  const quota = { limit: 30, remaining: 30 };
  await page.route(base + '/api/auth/ai/history', route => route.fulfill({ json: { accountId, messages: [], quota, hasMore: false } }));
  let releaseHeldVoice, heldStarted;
  let heldWaiting = new Promise(resolve => { heldStarted = resolve; });
  let chatPosts = 0, voicePosts = 0, voiceMode = 'retry', firstVoice, currentTranscript = 'Что спросить у врача?';
  await page.route(base + '/api/auth/ai/messages', route => {
    chatPosts++; const body = route.request().postDataJSON();
    return route.fulfill({ json: { accountId, status: 'completed', quota: { limit: 30, remaining: 29 }, messages: [{ id: 'u' + chatPosts, role: 'user', content: body.text, requestId: body.requestId }, { id: 'a' + chatPosts, role: 'assistant', content: 'Ответ', requestId: body.requestId }] } });
  });
  await page.route(base + '/api/auth/ai/voice', route => {
    voicePosts++; const body = route.request().postDataJSON();
    assert(Object.keys(body).sort().join() === 'audio,requestId', 'Voice leaked chat fields');
    assert(body.audio.mimeType === 'audio/webm', 'Codec MIME not normalized');
    assert(route.request().headers()['x-webpril-account'] === accountId, 'Missing voice identity header');
    if (voiceMode === 'retry' && !firstVoice) { firstVoice = body; return route.abort('failed'); }
    if (voiceMode === 'retry') assert(JSON.stringify(firstVoice) === JSON.stringify(body), 'Voice retry changed UUID or bytes');
    if (voiceMode === 'hold') {
      heldStarted();
      return new Promise(resolve => { releaseHeldVoice = async () => { await route.fulfill({ json: { accountId, requestId: body.requestId, text: 'Поздний текст' } }).catch(() => {}); resolve(); }; });
    }
    if (voiceMode === 'unavailable') return route.fulfill({ status: 503, json: { error: 'ai_voice_unavailable' } });
    if (voiceMode === 'unrecognized') return route.fulfill({ status: 422, json: { error: 'ai_audio_unrecognized' } });
    if (voiceMode === 'overlong') return route.fulfill({ status: 422, json: { error: 'ai_audio_too_long' } });
    if (voiceMode === 'rate') return route.fulfill({ status: 429, json: { error: 'rate_limited' } });
    if (voiceMode === 'invalid') return route.fulfill({ status: 400, json: { error: 'invalid_ai_audio' } });
    if (voiceMode === 'malformed') return route.fulfill({ json: { accountId, requestId: body.requestId, text: 'x'.repeat(4001) } });
    return route.fulfill({ json: { accountId, requestId: body.requestId, text: currentTranscript } });
  });
  const navigate = async () => { await page.goto(base + '/ai.html'); await page.waitForFunction(() => !document.querySelector('#chat-input').disabled); };
  const recording = async () => { await page.getByRole('button', { name: 'Записать голосом', exact: true }).click(); await page.getByRole('button', { name: 'Остановить запись', exact: true }).waitFor(); };
  const stop = async () => { await page.getByRole('button', { name: 'Остановить запись', exact: true }).click(); };
  await navigate();
  assert(await page.evaluate(() => voiceMock.calls) === 0, 'Requested microphone before click');
  await page.locator('#chat-input').fill('Обычный вопрос');
  await page.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();
  await page.getByText('Ответ', { exact: true }).waitFor();
  assert(await page.evaluate(() => voiceMock.calls) === 0, 'Typing accessed microphone');
  const chatsBeforeVoice = chatPosts;
  await recording();
  assert(await page.locator('#chat-input').isDisabled(), 'Typing remained enabled while recording');
  assert(await page.evaluate(() => JSON.stringify(voiceMock.constraints)) === '{"audio":true}', 'Requested non-audio media');
  for (const width of [320, 390, 500]) {
    await page.setViewportSize({ width, height: 500 }); await page.waitForTimeout(80);
    const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, overlap: document.querySelector('#chat-input').getBoundingClientRect().bottom > document.querySelector('.bottom-navigation').getBoundingClientRect().top, cancelVisible: document.querySelector('#voice-cancel').getBoundingClientRect().right <= innerWidth }));
    assert(!layout.overflow && !layout.overlap && layout.cancelVisible, 'Voice layout failed ' + width);
  }
  await page.screenshot({ path: 'output/playwright/lara-voice-recording-500.png' });
  await stop(); await page.locator('#voice-retry').waitFor({ state: 'visible' });
  assert(await page.evaluate(() => voiceMock.stopped) > 0, 'Tracks not stopped before transcription');
  await page.locator('#voice-retry').click();
  await page.waitForFunction(() => document.querySelector('#chat-input').value === 'Что спросить у врача?');
  assert(voicePosts === 2 && chatPosts === chatsBeforeVoice, 'Transcription sent question or missed retry');
  assert((await page.locator('#chat-quota').innerText()).includes('29 из 30'), 'Transcription modified question quota');
  assert(await page.locator('#voice-controls').isHidden(), 'Audio retained after transcript');
  await page.locator('#chat-input').fill('');
  voiceMode = 'normal';
  await recording(); const beforeCancel = voicePosts;
  await page.locator('#voice-cancel').click();
  assert(await page.locator('#voice-controls').isHidden() && voicePosts === beforeCancel, 'Cancel uploaded audio');
  await page.evaluate(() => { voiceMock.mode = 'late'; });
  await page.getByRole('button', { name: 'Записать голосом', exact: true }).click();
  await page.getByText('Разрешите доступ к микрофону…', { exact: true }).waitFor();
  await page.locator('#voice-cancel').click();
  const stoppedBeforeLate = await page.evaluate(() => voiceMock.stopped);
  await page.evaluate(() => voiceMock.grant()); await page.waitForTimeout(30);
  assert(await page.evaluate(() => voiceMock.stopped) > stoppedBeforeLate && await page.locator('#voice-controls').isHidden(), 'Late permission leaked microphone');
  await page.evaluate(() => { voiceMock.mode = 'denied'; });
  await page.getByRole('button', { name: 'Записать голосом', exact: true }).click();
  await page.getByText('Разрешите доступ к микрофону в настройках браузера', { exact: false }).waitFor();
  assert(!(await page.locator('#chat-input').isDisabled()), 'Permission denial blocked typing');
  await page.evaluate(() => { voiceMock.mode = 'normal'; voiceMock.size = 5242881; });
  await recording(); await stop();
  await page.getByText('Запись слишком длинная.', { exact: false }).waitFor();
  assert(voicePosts === beforeCancel, 'Oversize audio uploaded');
  await page.evaluate(() => { voiceMock.size = 20; });
  for (const mode of ['unavailable', 'unrecognized', 'overlong', 'rate', 'invalid', 'malformed']) {
    voiceMode = mode; await recording(); await stop();
    await page.waitForFunction(() => document.querySelector('#voice-controls').hidden);
    assert(!(await page.locator('#chat-input').isDisabled()) && await page.locator('#chat-input').inputValue() === '', 'Definitive voice failure blocked typing or inserted invalid text: ' + mode);
    if (mode === 'unavailable') {
      const callsAfterFailure = voicePosts; await page.waitForTimeout(60);
      assert(await page.locator('#voice-retry').isHidden() && await page.getByRole('button', { name: 'Записать голосом', exact: true }).isEnabled() && voicePosts === callsAfterFailure, 'Known 503 retained retry or automatically called STT');
    }
  }
  voiceMode = 'hold'; await recording(); await stop(); await heldWaiting;
  await page.locator('#voice-cancel').click(); await releaseHeldVoice(); await page.waitForTimeout(50);
  assert(await page.locator('#chat-input').inputValue() === '' && await page.locator('#voice-controls').isHidden(), 'Late transcript appeared after cancellation');
  voiceMode = 'normal'; currentTranscript = 'Распознанный текст';
  await recording();
  const beforeHidden = voicePosts, stoppedBeforeHidden = await page.evaluate(() => voiceMock.stopped);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  assert(await page.locator('#voice-controls').isHidden() && voicePosts === beforeHidden && await page.evaluate(() => voiceMock.stopped) > stoppedBeforeHidden, 'Hidden page retained recording');
  await navigate();
  await recording();
  await page.evaluate(() => window.dispatchEvent(new Event('webpril:session-ended')));
  assert(await page.locator('#voice-controls').isHidden() && await page.locator('#chat-input').isDisabled(), 'Session ended retained voice state');
  await navigate(); await page.evaluate(() => { voiceMock.mode = 'late'; });
  await page.getByRole('button', { name: 'Записать голосом', exact: true }).click();
  await page.getByText('Разрешите доступ к микрофону…', { exact: true }).waitFor();
  await page.evaluate(() => { window.webprilSessionGate.end = () => {}; window.dispatchEvent(new CustomEvent('account:change', { detail: { user: { id: '22222222-2222-4222-8222-222222222222' } } })); voiceMock.grant(); });
  await page.waitForTimeout(30);
  assert(await page.locator('#voice-controls').isHidden() && await page.evaluate(() => voiceMock.stopped) > 0, 'Account change failed to stop late microphone');
  await navigate(); await page.evaluate(() => { window.MediaRecorder = undefined; });
  await page.getByRole('button', { name: 'Записать голосом', exact: true }).click();
  await page.getByText('Этот браузер не поддерживает запись голоса.', { exact: false }).waitFor();
  assert(!(await page.locator('#chat-input').isDisabled()), 'Unsupported recorder blocked typing');
  await navigate(); await recording();
  const beforePanelHide = await page.evaluate(() => voiceMock.stopped);
  await page.evaluate(() => { document.querySelector('.app').hidden = true; });
  await page.waitForFunction(() => document.querySelector('#voice-controls').hidden);
  assert(await page.evaluate(() => voiceMock.stopped) > beforePanelHide, 'Initial AI panel hidden retained microphone');
  await page.route(base + '/voice-shell.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><iframe id="ai-panel" src="/ai.html"></iframe>' }));
  await page.goto(base + '/voice-shell.html');
  const frame = page.frameLocator('#ai-panel');
  await frame.locator('#chat-input').waitFor();
  await frame.getByRole('button', { name: 'Записать голосом', exact: true }).click();
  await frame.getByRole('button', { name: 'Остановить запись', exact: true }).waitFor();
  await page.locator('#ai-panel').evaluate(element => { element.hidden = true; });
  await page.waitForFunction(() => document.querySelector('#ai-panel').contentDocument.querySelector('#voice-controls').hidden);
  assert(await frame.locator('body').evaluate(() => voiceMock.stopped) > 0, 'Iframe panel hidden retained microphone');
  await page.locator('#ai-panel').evaluate(element => { element.hidden = false; });
  heldWaiting = new Promise(resolve => { heldStarted = resolve; }); voiceMode = 'hold';
  await frame.getByRole('button', { name: 'Записать голосом', exact: true }).click();
  await frame.getByRole('button', { name: 'Остановить запись', exact: true }).click(); await heldWaiting;
  await page.locator('#ai-panel').evaluate(element => { element.hidden = true; });
  await page.waitForFunction(() => document.querySelector('#ai-panel').contentDocument.querySelector('#voice-controls').hidden);
  await releaseHeldVoice(); await page.waitForTimeout(30);
  assert(await frame.locator('#chat-input').inputValue() === '', 'Hidden iframe accepted late transcription');
  voiceMode = 'normal';
  await page.clock.install(); await navigate(); await recording();
  await page.clock.fastForward(119001);
  await page.waitForFunction(() => document.querySelector('#chat-input').value === 'Распознанный текст');
  await page.clock.resume();
  assert(chatPosts === chatsBeforeVoice, 'Automatic stop submitted Lara question');
  return { mockedMicrophoneOnly: true, noRealSTT: true, emptyMicTextSend: true, explicitPermission: true, sameUuidBytesRetry: true, transcriptReviewNoSend: true, stopTracks: true, cancelAndLatePermission: true, cancelledTranscriptionIgnoresLateResponse: true, deniedUnsupported: true, oversizeAndServerErrors: true, known503ResetsWithoutRetry: true, hiddenSessionAccountWipe: true, initialAndIframeHiddenPanelStops: true, hiddenIframeIgnoresLateTranscript: true, max119SecondsAutoStop: true, widths: [320, 390, 500], chatPosts, voicePosts };
}
