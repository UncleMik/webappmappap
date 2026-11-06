async page => {
  const base='https://app.legkie-rody.ru';
  page.setDefaultTimeout(10000);
  const assert=(value,label)=>{if(!value)throw new Error(label);};
  const errors=[],consoleErrors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  await page.unrouteAll({behavior:'ignoreErrors'});
  await page.context().clearCookies();
  await page.addInitScript(()=>{localStorage.clear();sessionStorage.clear();});
  let requestCount=0,verifyCount=0,completeCount=0,currentChallenge;
  let verifyMode='invalid',completeMode='network',holdVerify=false,releaseVerify,holdRequest=false,releaseRequest;
  const user={id:'11111111-1111-4111-8111-111111111111',email:'email@example.invalid',profile:{completedAt:'2026-11-01T00:00:00Z'}};
  const verificationBodies=[],completionBodies=[];
  await page.route(base+'/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(['/club.html','/index.html','/onboarding.html'].includes(path)) {
      return route.fulfill({contentType:'text/html',body:'<!doctype html><title>QA destination</title><p>QA destination</p>'});
    }
    return route.fulfill({path:'Фронт'+path});
  });
  await page.route(base+'/api/auth/**',async route=>{
    const path=new URL(route.request().url()).pathname.split('/').pop();
    if(path==='session')return route.fulfill({json:{authenticated:false}});
    const body=route.request().postDataJSON();
    if(path==='request'){
      requestCount++;assert(body.email==='email@example.invalid','Non-synthetic email requested');
      if(holdRequest)await new Promise(resolve=>{releaseRequest=resolve;});
      currentChallenge=String.fromCharCode(64+requestCount).repeat(43);
      return route.fulfill({json:{challenge:currentChallenge,retryAfter:2}});
    }
    if(path==='verify'){
      verifyCount++;verificationBodies.push(body);
      assert(typeof body.code==='string'&&/^[0-9]{6}$/.test(body.code),'Invalid aggregate code shape');
      assert(body.challenge===currentChallenge,'Wrong challenge after request/resend');
      if(holdVerify)await new Promise(resolve=>{releaseVerify=resolve;});
      if(verifyMode==='network')return route.abort('failed');
      if(verifyMode==='success')return route.fulfill({json:{user}});
      if(verifyMode==='onboarding')return route.fulfill({json:{user:{...user,profile:{}}}});
      if(verifyMode==='pending')return route.fulfill({status:503,json:{error:'getcourse_pending',message:'Почта подтверждена. Завершаем регистрацию.',retryAfter:2}});
      const expired=verifyMode==='expired';
      return route.fulfill({status:401,json:{error:verifyMode==='challenge'?'invalid_challenge':'invalid_code',message:expired?'Срок действия кода истёк.':'Проверьте код из письма.'}});
    }
    if(path==='complete'){
      completeCount++;completionBodies.push(body);assert(!Object.hasOwn(body,'code'),'Complete retried OTP');
      if(completeMode==='network')return route.abort('failed');
      if(completeMode==='pending')return route.fulfill({status:503,json:{error:'getcourse_pending',message:'Завершаем регистрацию.',retryAfter:2}});
      return route.fulfill({json:{user}});
    }
    throw new Error('Unexpected auth API route');
  });
  const cells=page.locator('.code-digit');
  const values=()=>cells.evaluateAll(inputs=>inputs.map(input=>input.value));
  const joined=async()=>(await values()).join('');
  const active=()=>page.evaluate(()=>[...document.querySelectorAll('.code-digit')].indexOf(document.activeElement));
  const editable=()=>page.waitForFunction(()=>!document.querySelector('#email').readOnly);
  const readyCode=async()=>{await page.locator('#code-form').waitFor();await editable();assert(await active()===0,'Code focus not restored after busy');};
  const paste=async(index,text)=>cells.nth(index).evaluate((input,value)=>{const data=new DataTransfer();data.setData('text',value);input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},text);
  const replacement=async(index,text)=>cells.nth(index).evaluate((input,value)=>{input.value=value;input.dispatchEvent(new InputEvent('input',{inputType:'insertReplacementText',data:value,bubbles:true}));},text);
  const sendEmail=async()=>{await editable();await page.locator('#email').fill('email@example.invalid');await page.locator('#email-form button').click();await readyCode();};
  const waitResend=async()=>{await page.waitForTimeout(2200);await page.waitForFunction(()=>!document.querySelector('#resend-code').disabled);};
  const assertEmpty=async(label)=>assert((await values()).every(value=>value===''),label);
  await page.goto(base+'/login.html#next=/club.html');await sendEmail();
  assert(await cells.count()===6,'Expected six real inputs');
  assert(await page.getByRole('group',{name:'Код из письма'}).count()===1,'Missing accessible code group');
  assert(await cells.first().getAttribute('autocomplete')==='one-time-code'&&(await cells.all()).length===6,'Autofill entry missing');
  for(let i=0;i<6;i++){
    assert(await cells.nth(i).getAttribute('aria-label')===`Цифра ${i+1} из 6`,'Cell accessible label');
    assert(await cells.nth(i).getAttribute('inputmode')==='numeric','Numeric keyboard missing');
    if(i)assert(await cells.nth(i).getAttribute('autocomplete')==='off','Extra autofill entry');
  }
  const layouts=[];
  for(const width of [320,390,475,500,1440]){
    await page.setViewportSize({width,height:844});
    const layout=await cells.evaluateAll(inputs=>{const boxes=inputs.map(input=>input.getBoundingClientRect());return{width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,count:boxes.length,cellWidths:boxes.map(box=>box.width),allOnRow:boxes.every(box=>Math.abs(box.top-boxes[0].top)<1),inside:boxes.every(box=>box.left>=0&&box.right<=innerWidth),columnWidth:document.querySelector('.auth-shell').getBoundingClientRect().width};});
    assert(!layout.overflow&&layout.inside&&layout.allOnRow&&layout.columnWidth<=500&&Math.max(...layout.cellWidths)-Math.min(...layout.cellWidths)<1,'Six-cell layout overflow/unequal at '+width);layouts.push(layout);
    await cells.first().scrollIntoViewIfNeeded();await page.screenshot({path:'output/playwright/login-code-'+width+'.png'});
  }
  await page.setViewportSize({width:390,height:844});
  await cells.first().click();await page.keyboard.type('012345');
  assert(await joined()==='012345'&&await active()===5&&(await values()).every(value=>value.length===1),'Typing/auto-next/leading zero');
  assert(verifyCount===0,'Final digit auto-submitted');
  await page.keyboard.type('6');assert(await joined()==='012346','Last filled digit did not overwrite');
  await replacement(0,'012345');
  await cells.nth(2).click();
  assert(await cells.nth(2).evaluate(input=>input.selectionStart===0&&input.selectionEnd===1),'Filled digit not selected');
  await page.keyboard.type('9');assert(await joined()==='019345'&&await active()===3,'Overwrite selected digit');
  await cells.nth(5).focus();await page.keyboard.press('Backspace');assert((await values())[5]===''&&await active()===5,'Backspace current digit');
  await page.keyboard.press('Backspace');assert((await values())[4]===''&&await active()===4,'Backspace previous empty');
  await page.keyboard.press('ArrowLeft');assert(await active()===3,'ArrowLeft');await page.keyboard.press('Home');assert(await active()===0,'Home');await page.keyboard.press('End');assert(await active()===5,'End');await page.keyboard.press('ArrowRight');assert(await active()===5,'Arrow boundary');
  await replacement(0,'012345');await cells.nth(5).focus();await page.keyboard.press('Backspace');
  await cells.nth(5).evaluate(input=>{input.dispatchEvent(new InputEvent('beforeinput',{inputType:'deleteContentBackward',bubbles:true,cancelable:true}));input.dispatchEvent(new InputEvent('input',{inputType:'deleteContentBackward',bubbles:true}));});
  assert(await active()===4&&(await values())[4]===''&&(await values())[3]==='3','Soft-keyboard empty Backspace fallback');
  await paste(4,'0 1-2x3 4/5');assert(await joined()==='012345','Whole paste in any cell/filter separators');
  await paste(2,'8-7');assert(await joined()==='018745','Partial paste starts at selected cell');
  await replacement(3,'012345');assert(await joined()==='012345','Autofill replacement distributes from first');
  await replacement(0,'a');await page.locator('#verify-button').click();
  await page.locator('#code-form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  assert(verifyCount===0,'Partial/native-invalid code called verify');
  await replacement(0,'012345');holdVerify=true;await page.locator('#verify-button').click();
  await page.waitForFunction(()=>document.querySelectorAll('.code-digit:read-only').length===6);
  assert(await cells.evaluateAll(inputs=>inputs.every(input=>input.readOnly)),'Busy did not lock all six cells');
  await replacement(0,'999999');assert(await joined()==='012345','Stale busy input changed pending code');
  await page.locator('#change-email').evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert(await page.locator('#email-form').isHidden(),'Busy change-email changed pending request');
  holdVerify=false;releaseVerify();await readyCode();await assertEmpty('Invalid code did not clear six cells');
  assert(verificationBodies[0].code==='012345','Leading zero lost in verify request');
  assert(await cells.evaluateAll(inputs=>inputs.every(input=>input.getAttribute('aria-invalid')==='true')),'Error state missing');
  await cells.first().fill('1');assert(await cells.first().getAttribute('aria-invalid')===null,'Editing did not clear error state');
  await waitResend();holdRequest=true;await page.locator('#resend-code').click();
  await page.waitForFunction(()=>document.querySelectorAll('.code-digit:read-only').length===6);
  holdRequest=false;releaseRequest();await readyCode();await assertEmpty('Resend did not reset six cells');
  await replacement(0,'123456');await page.locator('#change-email').click();await assertEmpty('Change-email did not clear six cells');
  assert(await page.locator('#email-form').isVisible()&&await page.locator('#email').evaluate(input=>document.activeElement===input),'Change-email focus');
  await sendEmail();verifyMode='challenge';await replacement(0,'123456');await page.locator('#verify-button').click();await readyCode();await assertEmpty('Invalid challenge did not reset code');
  await waitResend();await page.locator('#resend-code').click();await readyCode();verifyMode='expired';await replacement(0,'123456');await page.locator('#verify-button').click();await readyCode();await assertEmpty('Expired code did not reset code');
  assert((await page.locator('#login-status').innerText()).includes('Срок действия'),'Expired error missing');
  verifyMode='network';await replacement(0,'012345');await page.locator('#verify-button').click();await editable();
  await page.getByText('Не удалось связаться с сервером.',{exact:false}).waitFor();assert(await joined()==='012345','Network error discarded retry code');
  assert(await page.evaluate(()=>localStorage.length===0&&sessionStorage.length===0),'OTP challenge stored before navigation');
  const verifyBeforePending=verifyCount;verifyMode='pending';await page.locator('#verify-button').click();await editable();
  assert(await page.locator('#code-fields').isHidden()&&await cells.evaluateAll(inputs=>inputs.every(input=>!input.required)),'GetCourse pending kept required OTP');await assertEmpty('Confirmed pending OTP was retained');
  await page.waitForTimeout(2200);await page.locator('#verify-button').click();await editable();
  assert(verifyCount===verifyBeforePending+1&&completeCount===1&&await page.locator('#code-fields').isHidden(),'Complete network retry reopened OTP');
  completeMode='pending';await page.locator('#verify-button').click();await editable();assert(await page.locator('#verify-button').isDisabled(),'Pending complete cooldown ignored');
  await page.waitForTimeout(2200);completeMode='success';await page.locator('#verify-button').click();await page.waitForURL(base+'/club.html');
  assert(completionBodies.every(body=>!Object.hasOwn(body,'code')),'OTP repeated during complete');
  await page.goto(base+'/login.html#next=/club.html');await sendEmail();verifyMode='onboarding';await replacement(0,'012345');await cells.last().press('Enter');
  await page.waitForURL(url=>url.pathname==='/onboarding.html');assert(new URL(page.url()).searchParams.get('next')==='/club.html','Onboarding next lost');
  await page.goto(base+'/login.html?next=https://evil.example/');await sendEmail();verifyMode='success';await replacement(0,'012345');await page.locator('#verify-button').click();await page.waitForURL(base+'/index.html');
  assert(verificationBodies.every(body=>/^[0-9]{6}$/.test(body.code)&&Object.keys(body).sort().join(',')==='challenge,code'),'Verify payload changed');
  assert(await page.evaluate(()=>localStorage.length===0&&sessionStorage.length===0),'Code/challenge stored in browser storage');
  assert(!errors.length,'Browser JavaScript errors');
  assert(consoleErrors.every(message=>/Failed to load resource/.test(message)&&/(?:401|503|net::ERR_FAILED)/.test(message)),'Unexpected browser console error');
  return {result:'passed',errors,cellCount:6,widths:layouts.map(row=>row.width),equalCellWidths:true,noOverflow:true,numericKeyboardAndLabels:true,typingAutoNextLeadingZero:true,wholePartialPasteAndFiltering:true,autofillReplacement:true,overwriteAndNavigation:true,lastFilledOverwrite:true,softKeyboardDeleteWithoutKeydown:true,noAutoSubmitOrPartialVerify:true,busyReadonlyAndStaleInput:true,requestAndInvalidFocusAfterBusy:true,invalidExpiredChallengeNetwork:true,resendChangeEmailReset:true,pendingCompleteRetryWithoutOtp:true,successfulNextAndOnboarding:true,unsafeNextRejected:true,noBrowserStorage:true,apiCounts:{requests:requestCount,verify:verifyCount,complete:completeCount},expectedMockHttpOrNetworkErrors:consoleErrors.length,unexpectedConsoleErrors:[]};
}
