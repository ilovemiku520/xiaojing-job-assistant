// Isolated public-DOM UI fixtures. Never opens an actual BOSS account.
import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const source=readFileSync(new URL('../extension/resume-ui.js',import.meta.url),'utf8');
const summary=[];
try{
 const echoScenarios=['quoted-sidebar','pasted-hr-sidebar','pasted-self-sidebar'];
 const lateReceipts=['late-consent-receipt','late-toolbar-receipt','chooser-receipt-on-open','chooser-receipt-before-row','chooser-receipt-before-confirm'];
 const changedRows=['chooser-row-replaced','chooser-row-renamed','chooser-row-duplicated','chooser-row-disabled'];
 const changedConfirms=['chooser-confirm-replaced','chooser-confirm-relabelled'];
 const unprovenNewCards=['history-prepended-card','receipt-card-tail-missing','receipt-card-known-id'];
 for(const scenario of ['consent-authorized-default','consent-unverified-default','chooser-no-aria','chooser-duplicates','proactive-direct-default','switched-peer','changed-request-id','lease-revoked','already-sent','already-sent-sidebar','already-sent-card','unverified-prior-card','duplicate-prior-card-anchor','hr-attachment-card',...echoScenarios,...lateReceipts,...changedRows,...changedConfirms,'missing-request-id','new-receipt-card',...unprovenNewCards,'finish-failed','chooser-marker-no-receipt']){
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent(`<!doctype html><meta charset="utf-8"><div class="friend-content selected"><div class="title-box"><span class="name-text">甲女士</span><span>测试游戏</span></div><span class="last-msg-text"></span></div><div class="chat-conversation"><div class="chat-record"><div class="message-item item-friend" data-mid="request-1">我想要一份您的附件简历，您是否同意<button id="agree">同意</button><button>拒绝</button></div></div><div class="toolbar-btn" id="resume-open">发简历</div></div>`);
  await page.addScriptTag({content:source});
  const result=await page.evaluate(async scenario=>{
   const root=document.querySelector('.chat-conversation'),selectedPeer=document.querySelector('.selected');let agrees=0,opens=0,selections=0,sends=0,finishes=[],checks=0;
   const config={profile:{resumeName:'游戏策划简历.pdf'},allowSiteDefaultResume:!['consent-unverified-default','chooser-duplicates'].includes(scenario)};
   const appendReceipt=label=>{const receipt=document.createElement('div');receipt.className='resume-system-notice';receipt.textContent='您的附件简历 '+label+' 已发送给Boss点击查看附件';root.querySelector('.chat-record').append(receipt);};
   const record=root.querySelector('.chat-record');
   const card=(id,{role='item-myself',filename='游戏策划简历'}={})=>`<div class="message-item ${role}" data-mid="${id}"><div class="resume-card"><span class="resume-name">${filename}</span></div></div>`;
   document.querySelector('#agree').onclick=()=>{
    agrees++;
    if(scenario==='new-receipt-card'||scenario==='receipt-card-tail-missing'){
     if(scenario==='receipt-card-tail-missing')record.querySelector('[data-mid="request-1"]').remove();
     record.insertAdjacentHTML('beforeend',card('sent-new'));return;
    }
    if(scenario==='history-prepended-card'){record.insertAdjacentHTML('afterbegin',card('loaded-old'));return;}
    if(scenario==='receipt-card-known-id'){record.querySelector('[data-mid="known-self"]').outerHTML=card('known-self');return;}
    appendReceipt('站内默认_游...');
   };
   if(scenario.startsWith('chooser')||scenario==='late-toolbar-receipt')document.querySelector('#agree').disabled=true;
   if(scenario==='proactive-direct-default')document.querySelector('.message-item').textContent='你好，欢迎了解岗位';
   document.querySelector('#resume-open').onclick=()=>{opens++;if(scenario==='proactive-direct-default'){sends++;appendReceipt('游戏策划简历');return;}const dialog=document.createElement('div');dialog.className='resume-dialog';dialog.innerHTML='<div class="resume-item"><span class="resume-name">游戏策划简历</span></div>'+(scenario==='chooser-duplicates'?'<div class="resume-item"><span class="resume-name">游戏策划简历.pdf</span></div>':'')+'<button class="btn-primary">发送</button>';dialog.querySelectorAll('.resume-item').forEach(row=>row.onclick=()=>{selections++;row.setAttribute('aria-selected','true');});dialog.querySelector('button').onclick=()=>{sends++;dialog.remove();appendReceipt('游戏策划简历');};document.body.append(dialog);if(scenario==='chooser-receipt-on-open')appendReceipt('此前已发送的附件');};
   if(scenario==='chooser-duplicates'){config.allowSiteDefaultResume=false;document.querySelector('#resume-open').setAttribute('aria-haspopup','dialog');}
   if(scenario==='already-sent')appendReceipt('游戏策划简历');
   const echoCase=['quoted-sidebar','pasted-hr-sidebar','pasted-self-sidebar'].includes(scenario);
   if(echoCase||scenario==='already-sent-sidebar'){
    const notice='您的附件简历 游戏策划简历 已发送给Boss点击查看附件';
    const quoted=`你这边是不是显示“${notice}”？我这里没有收到，麻烦再发一下。`;
    const preview=scenario==='quoted-sidebar'?quoted:notice;
    selectedPeer.querySelector('.last-msg-text').textContent=preview;
    if(echoCase){
     const message=document.createElement('div');message.className=`message-item ${scenario==='pasted-self-sidebar'?'item-myself':'item-friend'}`;
     message.innerHTML='<span class="text"></span><span>19:12</span>';
     message.querySelector('.text').textContent=preview;
     root.querySelector('.chat-record').prepend(message);
    }
   }
   if(scenario==='chooser-marker-no-receipt'){document.querySelector('#agree').disabled=true;document.querySelector('#resume-open').setAttribute('aria-haspopup','dialog');document.querySelector('#resume-open').onclick=()=>opens++;}
   if(scenario==='missing-request-id')document.querySelector('.message-item').removeAttribute('data-mid');
   if(scenario==='already-sent-card')record.insertAdjacentHTML('afterbegin',card('sent-old'));
   if(scenario==='unverified-prior-card')record.insertAdjacentHTML('afterbegin',card('sent-old',{filename:'游戏策划...'}));
   if(scenario==='duplicate-prior-card-anchor'){
    record.insertAdjacentHTML('afterbegin',card('sent-old'));
    const prior=record.querySelector('.resume-card');prior.after(prior.cloneNode(true));
   }
   if(scenario==='hr-attachment-card'){config.selectors={resumeSent:'.resume-card'};record.insertAdjacentHTML('afterbegin',card('incoming-file',{role:'item-friend'}));}
   if(scenario==='receipt-card-known-id')record.insertAdjacentHTML('beforeend','<div class="message-item item-myself" data-mid="known-self">此前已沟通</div>');
   const before={id:'boss:test',root,selectedPeer,header:'甲女士 测试游戏',messages:[{id:'request-1',role:'hr',text:'请发简历'}]};let reads=0;
   const getCurrent=()=>{reads++;return scenario==='switched-peer'&&reads>1?{...before,id:'boss:other'}:before;};
   const receiptCountBefore=BossResumeUI.inspect({root,selectedPeer,config}).receipts.length;
   const receiptCheck={'late-consent-receipt':2,'late-toolbar-receipt':2,'chooser-receipt-before-row':3,'chooser-receipt-before-confirm':4}[scenario];
   const ensure=async()=>{
    checks++;
    if(checks===receiptCheck)appendReceipt('此前已发送的附件');
    if(checks===2&&scenario==='changed-request-id')document.querySelector('.message-item').dataset.mid='request-2';
    if(checks===2&&scenario==='lease-revoked')throw Error('执行凭据失效');
    if(checks===3){
     const row=document.querySelector('.resume-dialog .resume-item');
     if(scenario==='chooser-row-replaced'||scenario==='chooser-row-duplicated'){
      const replacement=row.cloneNode(true);replacement.onclick=()=>{selections++;};
      if(scenario==='chooser-row-replaced')row.replaceWith(replacement);else row.after(replacement);
     }
     if(scenario==='chooser-row-renamed')row.querySelector('.resume-name').textContent='另一个附件.pdf';
     if(scenario==='chooser-row-disabled')row.setAttribute('aria-disabled','true');
    }
    if(checks===4&&(scenario==='chooser-confirm-replaced'||scenario==='chooser-confirm-relabelled')){
     const old=document.querySelector('.resume-dialog .btn-primary'),replacement=old.cloneNode(true);
     replacement.onclick=()=>{sends++;appendReceipt('游戏策划简历');};
     if(scenario==='chooser-confirm-replaced')old.replaceWith(replacement);
     else{old.after(replacement);old.className='btn-secondary';old.textContent='取消';}
    }
   };
   const execute=()=>BossResumeUI.execute({before,config,getCurrent,resolveCurrent:async()=>before,ensure,finish:async(success,evidence)=>{if(scenario==='finish-failed')throw Error('completion store unavailable');finishes.push({success,evidence});},timeoutMs:1000});
   let outcome,retryError;
   try{outcome=await execute();}
   catch(e){outcome={error:e.message,transmissionStarted:e.resumeTransmissionStarted};}
   if(echoCase)try{await execute();}catch(e){retryError=e.message;}
   return {scenario,agrees,opens,selections,sends,finishes,checks,outcome,retryError,receiptCountBefore,ui:BossResumeUI.inspect({root,selectedPeer,config})};
  },scenario);
  if(scenario==='consent-authorized-default'){assert.equal(result.agrees,1);assert.equal(result.finishes[0].success,true);assert.equal(result.outcome.attachmentSource,'site_default_owner_authorized');assert.match(result.finishes[0].evidence,/隐藏名称未作指定文件名核对/);}
  if(scenario==='consent-unverified-default'){assert.equal(result.agrees,0);assert.equal(result.opens,0);assert.match(result.outcome.error,/默认附件/);}
  if(scenario==='chooser-no-aria'){assert.equal(result.agrees,0);assert.equal(result.opens,1);assert.equal(result.sends,1);assert.equal(result.finishes[0].success,true);assert.equal(result.outcome.visibleFilename,'游戏策划简历');assert.equal(result.outcome.attachmentSource,'named_chooser');}
  if(scenario==='chooser-duplicates'){assert.equal(result.sends,0);assert.equal(result.finishes.length,0);assert.match(result.outcome.error,/未唯一匹配/);assert.equal(result.outcome.transmissionStarted,false);}
  if(scenario==='proactive-direct-default'){assert.equal(result.opens,1);assert.equal(result.sends,1);assert.equal(result.finishes[0].success,true);}
  if(scenario==='switched-peer'){assert.equal(result.agrees,0);assert.equal(result.sends,0);assert.match(result.outcome.error,/会话或消息已变化/);}
  if(scenario==='changed-request-id'||scenario==='lease-revoked'){assert.equal(result.agrees,0);assert.equal(result.opens,0);assert.match(result.outcome.error,scenario==='changed-request-id'?/简历请求在同意前已变化/:/执行凭据失效/);assert.equal(result.outcome.transmissionStarted,false);}
  if(['already-sent','already-sent-sidebar','already-sent-card'].includes(scenario)){assert.equal(result.agrees,0);assert.equal(result.opens,0);assert.match(result.outcome.error,/已有附件发送提示/);}
  if(scenario==='already-sent-card'){
   assert.deepEqual(result.ui.receipts,[{source:'self_attachment_card',messageId:'sent-old',filenameLabel:'游戏策划简历'}]);
   assert.deepEqual(result.ui.attachmentCardAnchors,[{id:'sent-old',role:'self',filenameLabel:'游戏策划简历'}]);
  }
  if(['unverified-prior-card','duplicate-prior-card-anchor','hr-attachment-card'].includes(scenario)){assert.equal(result.receiptCountBefore,0);assert.equal(result.agrees,1);assert.equal(result.finishes[0].success,true);}
  if(echoScenarios.includes(scenario)){assert.equal(result.receiptCountBefore,0);assert.equal(result.agrees,1);assert.equal(result.finishes[0].success,true);assert.deepEqual(result.ui.receipts.map(r=>r.source),['chat_notice']);assert.match(result.retryError,/已有附件发送提示/);}
  if(lateReceipts.includes(scenario)){
   assert.equal(result.receiptCountBefore,0);assert.equal(result.ui.receipts.length,1);assert.equal(result.agrees,0);assert.equal(result.sends,0);assert.equal(result.finishes.length,0);
   assert.equal(result.opens,Number(scenario.startsWith('chooser')));assert.equal(result.selections,Number(scenario==='chooser-receipt-before-confirm'));
   assert.match(result.outcome.error,/已观察到附件发送回执/);assert.equal(result.outcome.transmissionStarted,scenario==='chooser-receipt-before-confirm');
  }
  if(changedRows.includes(scenario)||changedConfirms.includes(scenario)){
   const rowChanged=changedRows.includes(scenario);
   assert.equal(result.opens,1);assert.equal(result.selections,Number(!rowChanged));assert.equal(result.sends,0);assert.equal(result.finishes.length,0);
   assert.match(result.outcome.error,rowChanged?/待选附件或选择窗口已变化/:/发送简历确认窗口已变化/);assert.equal(result.outcome.transmissionStarted,!rowChanged);
  }
  if(scenario==='missing-request-id'){assert.equal(result.agrees,0);assert.equal(result.opens,0);assert.match(result.outcome.error,/稳定消息编号/);assert.equal(result.outcome.transmissionStarted,false);}
  if(unprovenNewCards.includes(scenario)){assert.equal(result.agrees,1);assert.equal(result.finishes.length,0);assert.match(result.outcome.error,/没有确认到/);assert.equal(result.outcome.transmissionStarted,true);assert.equal(result.ui.receipts[0].source,'self_attachment_card');}
  if(scenario==='new-receipt-card'){assert.equal(result.agrees,1);assert.equal(result.finishes[0].success,true);assert.match(result.finishes[0].evidence,/指定名称的站内附件简历卡片/);}
  if(scenario==='finish-failed'){assert.equal(result.agrees,1);assert.equal(result.outcome.error,'completion store unavailable');assert.equal(result.outcome.transmissionStarted,true);}
  if(scenario==='chooser-marker-no-receipt'){assert.equal(result.opens,1);assert.equal(result.finishes.length,0);assert.match(result.outcome.error,/未识别附件选择窗口/);assert.equal(result.outcome.transmissionStarted,true);}
  assert.deepEqual(errors,[]);summary.push({scenario,agrees:result.agrees,opens:result.opens,sends:result.sends,finished:result.finishes.length});await page.close();
 }
 console.log(JSON.stringify({cases:summary,realHRsContacted:0,paidModelCalls:0}));
}finally{await browser.close();}
