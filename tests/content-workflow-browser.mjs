// Isolated local public-DOM fixture. The production scripts are injected without
// opening BOSS, connecting an account, calling a model or contacting an HR.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
const resources=resolve(process.argv[2]||fileURLToPath(new URL('../',import.meta.url)));
const scripts=['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(join(resources,'extension',name),'utf8'));
const browser=await chromium.launch({headless:true,channel:'msedge'}),summary=[];
try{
 const replacedSendCases=['text-human-replaced-pointer-send','text-human-replaced-enter-send'];
 const alternateSend='text-human-ambiguous-pointer-send';
 const manualTextCases=['text-human-pointer-send','text-human-enter-send','text-human-focus','text-human-edit','text-human-ambiguous-focus','text-human-edit-replaced',alternateSend,...replacedSendCases];
 for(const scenario of ['new-message-fast-reply','text-delayed-dom','text-button-timeout','text-button-rerender','text-controls-rerender',...manualTextCases,'text-postclick-rerender','text-postclick-unknown','request-resume','resume-preclick-failure','resume-postclick-unknown','already-sent-resume','historical-baseline','reply-queue-draft','reply-queue-parked','reply-queue-disabled','reply-queue-revoked','reply-queue-idle']){
  const staleControls=['text-button-rerender','text-controls-rerender'].includes(scenario);
  const manualText=manualTextCases.includes(scenario);
  const queueCase=scenario.startsWith('reply-queue-');
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const requests=[];page.on('request',r=>requests.push(r.url()));
  await page.route('http://127.0.0.1:43720/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'}));
  await page.goto('http://127.0.0.1:43720/web/geek/chat');
  await page.evaluate(scenario=>{
   const resume=scenario.includes('resume'),historical=['historical-baseline','reply-queue-idle'].includes(scenario),queueCase=scenario.startsWith('reply-queue-');
   document.body.innerHTML=`<div class="friend-content selected" data-id="fixture-peer"><div class="title-box"><span class="name-text">测试女士</span><span>本地测试游戏</span></div><span class="last-msg-text">${resume?'想要附件简历':'主人做过哪些游戏项目？'}</span><span class="time">${historical?'10月01日':'09:15'}</span><span class="notice-badge">${historical?'0':'1'}</span></div><div class="chat-conversation"><div class="chat-title">测试女士 本地测试游戏</div><div class="chat-position-content"><span class="position-name">游戏策划实习生</span><span class="city">北京</span><button id="view-position">查看职位</button></div><div class="chat-record"><div class="message-item item-friend" data-mid="hr-1"><div class="text">${resume?'我想要一份您的附件简历，您是否同意':'主人做过哪些游戏项目？'}</div>${resume?'<button id="agree-resume">同意</button><button>拒绝</button>':''}</div></div><div class="chat-editor"><textarea class="chat-input"></textarea><button class="btn-send">发送</button></div><div class="toolbar-btn">发简历</div></div>`;
   const state=window.fixture={scenario,calls:[],runtime:[],agreeClicks:0,sendClicks:0,jobClicks:0,historyScrolls:0,stored:{},listeners:[],completed:false,checks:0,detachedClicks:0,replacementClicks:0,timing:{},monitorGranted:true,manualDraft:'主人留在新输入框的手动草稿'};
   const config={running:true,readingEnabled:true,mode:'auto',chatRead:true,chatInput:true,autoBrowse:false,historyRead:true,newMessagesOnly:true,autoResume:true,allowSiteDefaultResume:true,proactiveResume:true,browserCalibrated:true,watchEpoch:'fixture',profile:{resumeName:'游戏策划简历.pdf'}};
   const appendReceipt=()=>{const n=document.createElement('div');n.textContent='您的附件简历 游戏策划简历 已发送给Boss点击查看附件';document.querySelector('.chat-record').append(n);};
   if(scenario==='already-sent-resume')appendReceipt();
   document.querySelector('#view-position').onclick=()=>state.jobClicks++;
   document.querySelector('.chat-record').addEventListener('scroll',()=>state.historyScrolls++);
   document.querySelector('#agree-resume')?.addEventListener('click',()=>{state.agreeClicks++;if(scenario!=='resume-postclick-unknown')appendReceipt();});
   const editor=document.querySelector('textarea'),button=document.querySelector('.btn-send');
   const peer=document.querySelector('.friend-content'),anchor=document.querySelector('[data-mid="hr-1"]');
   const delayed=scenario==='text-delayed-dom';
   const manualText=scenario.startsWith('text-human-'),replacementSend=scenario.startsWith('text-human-replaced-'),pendingSends=[];
   if(replacementSend)document.body.append(editor.parentElement);
   state.clickTrust=[];
   function publish(id,value){
    const n=document.createElement('div');n.className='message-item item-myself';n.dataset.mid=id;
    const body=document.createElement('div');body.className='text';body.textContent=value;n.append(body);document.querySelector('.chat-record').append(n);
   }
   state.publishManualReceipts=()=>{for(const [index,value] of pendingSends.entries())publish(`manual-self-${index}`,value);};
   if(scenario==='text-human-enter-send')editor.addEventListener('keydown',event=>{
    if(event.key==='Enter'){state.trustedEnter=event.isTrusted;event.preventDefault();button.click();}
   });
   button.disabled=true;
   editor.addEventListener('input',()=>{
    state.timing.input=performance.now();
    if(scenario==='text-button-timeout')return;
    const enable=()=>{button.disabled=false;state.timing.buttonReady=performance.now();};
    if(delayed)setTimeout(enable,90);else enable();
   },{once:true});
   function replaceControls(replaceEditor){
    const replacement=button.cloneNode(true);
    replacement.onclick=event=>{
     state.replacementClicks++;
     if(replacementSend){state.clickTrust.push(event.isTrusted);pendingSends.push(document.querySelector('textarea').value);}
    };
    button.replaceWith(replacement);
    if(replaceEditor){
     const newEditor=editor.cloneNode(true);
     newEditor.value=replacementSend?editor.value:state.manualDraft;
     if(scenario==='text-human-replaced-enter-send')newEditor.addEventListener('keydown',event=>{
      if(event.key==='Enter'){state.trustedEnter=event.isTrusted;event.preventDefault();replacement.click();}
     });
     editor.replaceWith(newEditor);
    }
    state.peerAndAnchorUnchanged=peer===document.querySelector('.friend-content')&&anchor===document.querySelector('[data-mid="hr-1"]');
   }
   state.replaceControls=replaceControls;
   state.addAlternateSend=()=>{
    const alternate=button.cloneNode(true);
    alternate.id='alternate-send';
    alternate.onclick=event=>{state.replacementClicks++;state.clickTrust.push(event.isTrusted);pendingSends.push(editor.value);};
    button.parentElement.append(alternate);
   };
   button.onclick=event=>{
    state.sendClicks++;state.detachedClicks+=Number(!button.isConnected);
    state.timing.clicked=performance.now();
    if(manualText){state.clickTrust.push(event.isTrusted);pendingSends.push(editor.value);return;}
    if(scenario==='text-postclick-unknown')return;
    const sent=editor.value;
    editor.value='';
    if(scenario==='text-postclick-rerender')replaceControls(true);
    const receipt=()=>{publish('self-'+state.sendClicks,sent);state.timing.receipt=performance.now();};
    if(delayed){setTimeout(()=>publish('unrelated-self','其他正文'),40);setTimeout(receipt,120);}
    else receipt();
   };
   const task={id:'task-fixture',kind:'reply',action:resume?'send_resume':'send_text',status:'approved',fingerprint:'fingerprint-fixture',peerId:'boss:fixture-peer',text:'主人做过卡牌策略原型，可以结合岗位继续介绍。'};
   state.taskText=task.text;
   const nativeSetTimeout=window.setTimeout;
   window.setTimeout=(callback,ms,...args)=>{
    if(ms===1800&&callback.name==='tick')return 0;
    if(scenario==='text-button-timeout'&&ms===6000||scenario==='text-postclick-unknown'&&ms===10000){
     state.timeoutBudget=ms;
     return nativeSetTimeout(callback,300,...args);
    }
    return nativeSetTimeout(callback,ms,...args);
   };
   const nativeSetInterval=window.setInterval;
   window.setInterval=(callback,ms,...args)=>queueCase&&[250,1000].includes(ms)?nativeSetInterval(callback,ms,...args):0;
   window.chrome={storage:{local:{get:async key=>({[key]:state.stored[key]}),set:async patch=>Object.assign(state.stored,patch)}},runtime:{id:'fixture-extension',onMessage:{addListener:listener=>state.listeners.push(listener)},sendMessage:async message=>{
    state.runtime.push({type:message.type});
    if(message.type==='chatMonitor'){
     if(!state.monitorGranted)state.monitorDenied=true;
     return {ok:true,result:{monitor:state.monitorGranted}};
    }
    if(message.type!=='api')return {ok:true,result:null};
    const {path,data}=message;state.calls.push({path,data});
    if(path==='/api/heartbeat')return {ok:true,result:{config:structuredClone(config)}};
    if(path==='/api/tasks')return {ok:true,result:{tasks:state.prepared&&!state.completed?[task]:[]}};
    if(path==='/api/replies/state'){
     if(['auth_blocked','stale'].includes(state.reply?.status))state.terminalObserved=true;
     return {ok:true,result:{items:state.reply?[structuredClone(state.reply)]:[]}};
    }
    if(path==='/api/replies/enqueue'){
     state.reply={id:'reply-fixture',peerId:task.peerId,...data.label,status:'generating'};
     const ready=()=>{
      state.timing.generated=performance.now();state.prepared=true;
      state.reply={...state.reply,status:'ready',taskId:task.id};
     };
     if(!queueCase)ready();
     else if(scenario==='reply-queue-draft')setTimeout(ready,100);
     else if(scenario==='reply-queue-parked')setTimeout(()=>{state.reply.status='auth_blocked';},520);
     else if(scenario==='reply-queue-disabled')setTimeout(()=>{config.hrInboxRunning=false;state.reply.status='stale';},520);
     else if(scenario==='reply-queue-revoked')setTimeout(()=>{state.monitorGranted=false;},80);
     return {ok:true,result:{reply:structuredClone(state.reply)}};
    }
    if(path==='/api/claim'){state.timing.claim=performance.now();return {ok:true,result:{task:resume?task:{...task,autoReplyClaim:{peerId:task.peerId,tailId:'hr-1',messageIds:['hr-1']}},lease:'lease-fixture'}};}
    if(path==='/api/check'){
     state.checks++;
     if(state.checks===2&&(manualText||['text-button-rerender','text-controls-rerender'].includes(scenario))){
      return new Promise(resolve=>{
       state.releaseCheck=()=>{
        if(!manualText)replaceControls(scenario==='text-controls-rerender');
        else state.peerAndAnchorUnchanged=peer===document.querySelector('.friend-content')&&anchor===document.querySelector('[data-mid="hr-1"]');
        resolve({ok:true,result:{allowed:true}});
       };
      });
     }
     return {ok:true,result:{allowed:scenario!=='resume-preclick-failure'}};
    }
    if(path==='/api/complete'){
     state.timing.complete=performance.now();state.completed=true;
     if(queueCase)state.reply.status='done';
     return {ok:true,result:{ok:true}};
    }
    return {ok:true,result:{}};
   }}};
   window.fixtureTick=()=>new Promise(resolve=>state.listeners[0]({type:'assistant-read',command:'tick'},{id:'fixture-extension'},resolve));
  },scenario);
  for(const [index,source] of scripts.entries()){
   await page.addScriptTag({content:source});
   if(index===1)await page.evaluate(()=>{const execute=BossResumeUI.execute;window.BossResumeUI={...BossResumeUI,execute:options=>execute({...options,timeoutMs:150})};});
  }
  const tick=page.evaluate(()=>fixtureTick());
  if(staleControls||manualText){
   await page.waitForFunction(()=>typeof fixture.releaseCheck==='function');
   if(manualText){
    if(replacedSendCases.includes(scenario))await page.evaluate(()=>fixture.replaceControls(true));
    if(scenario===alternateSend){
     await page.evaluate(()=>fixture.addAlternateSend());
     await page.locator('#alternate-send').click();
     await page.evaluate(()=>document.querySelector('#alternate-send').remove());
    }
    else if(scenario.endsWith('pointer-send'))await page.locator('.btn-send').click();
    else if(scenario.endsWith('enter-send'))await page.locator('textarea').press('Enter');
    else if(scenario==='text-human-ambiguous-focus'){
     await page.evaluate(()=>{const duplicate=document.querySelector('.btn-send').cloneNode(true);duplicate.id='duplicate-send';document.querySelector('.chat-editor').append(duplicate);});
     await page.locator('textarea').click();
     await page.evaluate(()=>document.querySelector('#duplicate-send').remove());
    }
    else if(scenario==='text-human-focus')await page.locator('textarea').click();
    else{await page.locator('textarea').press('End');await page.keyboard.type('x');}
    if(scenario==='text-human-edit-replaced')await page.evaluate(()=>fixture.replaceControls(true));
    assert.deepEqual(await page.evaluate(()=>({clicks:fixture.sendClicks,buttonEnabled:!document.querySelector('.btn-send').disabled,oldRows:document.querySelectorAll('.message-item').length})),{
     clicks:Number(scenario.endsWith('-send')&&scenario!==alternateSend&&!replacedSendCases.includes(scenario)),buttonEnabled:true,oldRows:1
    });
   }
   await page.evaluate(()=>fixture.releaseCheck());
   if(manualText){
    await page.waitForFunction(count=>fixture.completed||fixture.sendClicks+fixture.replacementClicks>count,Number(scenario.endsWith('-send')),{timeout:2000});
    await page.evaluate(()=>fixture.publishManualReceipts());
   }
  }
  await tick;
  if(scenario==='reply-queue-draft')await page.waitForFunction(()=>fixture.completed);
  else if(queueCase){
   if(scenario!=='reply-queue-idle')await page.waitForFunction(()=>fixture.terminalObserved||fixture.monitorDenied,null,{timeout:2500}).catch(error=>{throw Error(scenario+' did not stop short polling',{cause:error});});
   const calls=()=>page.evaluate(()=>[fixture.calls.length,fixture.runtime.length]);
   const settled=await calls();await page.waitForTimeout(560);
   assert.deepEqual(await calls(),settled,'idle, disabled, parked or revoked inbox must stop short polling');
  }
  const result=await page.evaluate(()=>({
   calls:fixture.calls,runtime:fixture.runtime,agreeClicks:fixture.agreeClicks,sendClicks:fixture.sendClicks,
   jobClicks:fixture.jobClicks,historyScrolls:fixture.historyScrolls,completed:fixture.completed,checks:fixture.checks,
   detachedClicks:fixture.detachedClicks,replacementClicks:fixture.replacementClicks,
   peerAndAnchorUnchanged:fixture.peerAndAnchorUnchanged,draft:document.querySelector('textarea').value,timing:fixture.timing,timeoutBudget:fixture.timeoutBudget,
   manualDraft:fixture.manualDraft,taskText:fixture.taskText,receipt:document.querySelector('[data-mid="self-1"] .text')?.textContent,
   clickTrust:fixture.clickTrust,trustedEnter:fixture.trustedEnter===true,manualReceipts:document.querySelectorAll('[data-mid^="manual-self-"]').length,
  }));
  assert.deepEqual(errors,[]);assert.equal(requests.filter(url=>!url.startsWith('http://127.0.0.1:43720/')).length,0);
  const prepare=result.calls.filter(c=>c.path==='/api/replies/enqueue'),complete=result.calls.filter(c=>c.path==='/api/complete');
  assert.equal(result.jobClicks,0);assert.equal(result.historyScrolls,0);assert.equal(result.calls.some(c=>c.path==='/api/chat/job/start'),false);
  const statusReads=result.calls.filter(call=>call.path==='/api/replies/state').length;
  const heartbeats=result.calls.filter(call=>call.path==='/api/heartbeat').length;
  if(scenario==='reply-queue-draft'){
   assert.equal(prepare.length,1);assert.equal(complete.length,1);assert.equal(complete[0].data.success,true);
   assert.equal(result.sendClicks,1);assert.equal(result.checks,2);
   const beforeClaim=result.calls.slice(0,result.calls.findIndex(call=>call.path==='/api/claim'));
   assert.equal(beforeClaim.filter(call=>call.path==='/api/heartbeat').length,4,'only initial and ready business ticks may send heartbeats');
   const draftReads=beforeClaim.filter(call=>call.path==='/api/replies/state').length;
   assert(draftReads>=3&&draftReads<=5,'a status-only wake must read readiness before the business tick claims');
  }else if(queueCase){
   assert.equal(complete.length,0);assert.equal(result.sendClicks,0);
   assert.equal(heartbeats,2,'short status polls must not scan or refresh the page');
   if(scenario==='reply-queue-parked'||scenario==='reply-queue-disabled')assert(statusReads>=2&&statusReads<=5);
   else assert.equal(statusReads,1);
  }
  const measured=scenario==='new-message-fast-reply'||scenario==='text-delayed-dom';
  if(measured){
   assert.equal(prepare.length,1);assert.equal(prepare[0].data.trigger,'new_hr_message');assert.equal(result.sendClicks,1);assert.equal(complete[0].data.success,true);
   assert.match(complete[0].data.evidence,/self-1/);assert.equal(result.receipt,result.taskText);
   assert.equal(result.checks,2);
   assert(result.timing.clicked-result.timing.buttonReady<350,'available button must not wait for a 500ms tick');
   assert(result.timing.complete-result.timing.receipt<350,'exact DOM receipt must not wait for a 500ms tick');
   if(scenario==='text-delayed-dom'){
    assert(result.timing.buttonReady-result.timing.input>=60);assert(result.timing.receipt-result.timing.clicked>=90);
   }
   assert.equal(result.calls.some(c=>c.path==='/api/chat/history'),false);
  }
  if(scenario==='text-button-timeout'){
   assert.equal(result.timeoutBudget,6000);assert.equal(result.checks,2);assert.equal(result.sendClicks,0);
   assert.equal(result.draft,result.taskText);assert.equal(complete[0].data.success,false);
   assert.match(complete[0].data.evidence,/输入框未接受消息/);
  }
  if(staleControls){
   assert.equal(result.checks,2);assert.equal(result.peerAndAnchorUnchanged,true);
   assert.equal(result.sendClicks,0);assert.equal(result.detachedClicks,0);assert.equal(result.replacementClicks,0);
   assert.equal(result.draft,scenario==='text-controls-rerender'?result.manualDraft:result.taskText);
   assert.equal(complete.length,1);assert.equal(complete[0].data.success,false);assert.equal(complete[0].data.notStarted,false);
   assert.equal(complete[0].data.outcome,undefined);
   assert.match(complete[0].data.evidence,/本轮未点击发送/);
  }
  if(manualText){
   const possibleSend=scenario.endsWith('-send'),replacementSend=scenario===alternateSend||replacedSendCases.includes(scenario),controlsChanged=scenario==='text-human-edit-replaced';
   const provenTakeover=['text-human-focus','text-human-edit'].includes(scenario);
   assert.equal(result.checks,2);assert.equal(result.peerAndAnchorUnchanged,true);
   assert.equal(result.sendClicks,Number(possibleSend&&!replacementSend));assert.equal(result.replacementClicks,Number(replacementSend));assert.equal(result.manualReceipts,Number(possibleSend));
   assert.deepEqual(result.clickTrust,possibleSend?[scenario.endsWith('pointer-send')]:[]);
   assert.equal(result.trustedEnter,scenario.endsWith('enter-send'));
   assert.equal(result.draft,controlsChanged?result.manualDraft:result.taskText+(scenario==='text-human-edit'?'x':''));
   assert.equal(complete.length,1);assert.equal(complete[0].data.success,false);assert.equal(complete[0].data.notStarted,false);
   assert.equal(complete[0].data.outcome,provenTakeover?'manual_editor_takeover':undefined);
   assert.match(complete[0].data.evidence,possibleSend?/人工发送可能已经开始/:controlsChanged?/输入框或发送按钮已变化/:/人工接手聊天输入/);
  }
  if(scenario==='text-postclick-rerender'){
   assert.equal(result.peerAndAnchorUnchanged,true);assert.equal(result.sendClicks,1);assert.equal(result.detachedClicks,0);assert.equal(result.replacementClicks,0);
   assert.equal(result.draft,result.manualDraft);assert.equal(result.receipt,result.taskText);
   assert.equal(complete[0].data.success,true);assert.match(complete[0].data.evidence,/self-1/);
  }
  if(scenario==='text-postclick-unknown'){
   assert.equal(result.timeoutBudget,10000);assert.equal(result.sendClicks,1);assert.equal(result.detachedClicks,0);assert.equal(result.receipt,undefined);
   assert.equal(complete[0].data.success,false);assert.equal(complete[0].data.notStarted,false);
   assert.match(complete[0].data.evidence,/点击后未在同一会话发现发送结果/);
  }
  if(scenario==='request-resume'){
   assert.equal(prepare.length,1);assert.equal(prepare[0].data.resumeUI.agreeEnabled,true);assert.equal(result.agreeClicks,1);assert.equal(result.sendClicks,0);assert.equal(complete[0].data.success,true);
   assert.equal(result.calls.some(c=>c.path==='/api/chat/history'),false);
  }
  if(scenario==='resume-preclick-failure'){
   assert.equal(result.agreeClicks,0);assert.equal(result.sendClicks,0);assert.equal(complete[0].data.success,false);assert.equal(complete[0].data.notStarted,true);
  }
  if(scenario==='resume-postclick-unknown'){
   assert.equal(result.agreeClicks,1);assert.equal(result.sendClicks,0);assert.equal(complete[0].data.success,false);assert.equal(complete[0].data.notStarted,false);
  }
  if(scenario==='already-sent-resume'){
   assert.equal(result.calls.find(c=>c.path==='/api/observe').data.resumeUI.receipts.length,1);
   assert.equal(prepare.length,0);assert.equal(result.agreeClicks,0);assert.equal(result.sendClicks,0);assert.equal(complete.length,0);
  }
  if(scenario==='historical-baseline'){
   assert.equal(prepare.length,0);assert.equal(result.agreeClicks,0);assert.equal(result.sendClicks,0);
  }
  summary.push({scenario,prepares:prepare.length,agrees:result.agreeClicks,textSends:result.sendClicks,completes:complete.length,...(measured?{timing:result.timing}:{}),...(queueCase?{statusReads,heartbeats}:{})});await page.close();
 }
 console.log(JSON.stringify({cases:summary,realHRsContacted:0,modelCalls:0}));
}finally{await browser.close();}
