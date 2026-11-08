/* Existing BOSS attachment UI only. No upload, private API or second sender. */
(()=>{
 if(globalThis.BossResumeUI)return;
 const S={resumeOpen:'.chat-op .btn-resume, .chat-toolbar [data-action="resume"]',hrMessage:'.message-item.item-friend, .message-item.friend, .message-item.received',selfMessage:'.message-item.item-myself, .message-item.myself, .message-item.sent',messageText:'.text, .text-content, .message-text',resumeDialog:'.resume-dialog, .dialog-resume, [role="dialog"]',resumeRow:'.resume-item, .resume-list li',resumeConfirm:'.btn-primary, .btn-sure',resumeName:'.resume-name, .file-name, .name',resumeSent:'.message-item.item-myself .resume-card, .message-item.sent .resume-card'};
 const text=e=>(e?.innerText||e?.textContent||'').trim();
 const visible=e=>!!e&&e.getClientRects().length>0&&e.ownerDocument.defaultView.getComputedStyle(e).visibility!=='hidden'&&e.ownerDocument.defaultView.getComputedStyle(e).display!=='none';
 const enabled=e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!e.closest('[disabled],[aria-disabled="true"],.disabled,.unable,.is-disabled');
 const selector=(config,key)=>config?.selectors?.[key]||S[key];
 const list=(root,config,key)=>[...root.querySelectorAll(selector(config,key))].filter(visible);
 const unique=items=>[...new Set(items)];
 const receiptPattern=/^您的附件简历\s*(.*?)\s*已发送给\s*Boss(?:\s*点击查看附件)?$/i;
 const normalizedText=value=>value.replace(/\s+/g,' ').trim();
 const isReceipt=value=>value.length<=1500&&receiptPattern.test(normalizedText(value));
 const attachmentCardSource='self_attachment_card';
 const stableMessageId=value=>/^[^\s\u0000-\u001f\u007f]{1,250}$/u.test(value);
 const messageId=row=>row?.getAttribute('data-mid')||row?.getAttribute('data-msg-id')||row?.getAttribute('data-message-id')||'';
 const messageSelector=config=>`${selector(config,'hrMessage')}, ${selector(config,'selfMessage')}`;
 const messageRows=(root,config)=>[...root.querySelectorAll(messageSelector(config))].filter(visible);
 const normalized=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,'').replace(/\.pdf$/i,'').toLowerCase();
 function nameMatches(actual,expected,aliases=[]){return !!actual&&!/(?:\.{3}|…)/.test(actual)&&[expected,...(Array.isArray(aliases)?aliases:[])].some(n=>n&&normalized(actual)===normalized(n));}
 function nodeNames(node,config){
  const explicit=[node,...node.querySelectorAll('[data-file-name],[data-resume-name]')].filter(visible).flatMap(e=>[e.getAttribute('data-file-name'),e.getAttribute('data-resume-name')]).filter(Boolean);
  const labels=list(node,config,'resumeName').map(e=>e.getAttribute('title')||text(e));
  return unique([...explicit,...labels].map(n=>String(n).trim()).filter(Boolean));
 }
 function attachmentCards(root,config){
  const expected=config.profile?.resumeName,cards=list(root,config,'resumeSent');
  if(!expected||!cards.length)return [];
  const counts=new Map();
  for(const row of messageRows(root,config)){const id=messageId(row);counts.set(id,(counts.get(id)||0)+1);}
  const result=new Map();
  for(const card of cards){
   const row=card.closest(messageSelector(config)),id=messageId(row);
   if(!row?.matches(selector(config,'selfMessage'))||row.matches(selector(config,'hrMessage'))||!stableMessageId(id)||counts.get(id)!==1)continue;
   const names=nodeNames(card,config).filter(name=>name.length<=250&&!/(?:\.{3}|…|[\u0000-\u001f\u007f])/.test(name));
   if(new Set(names.map(normalized)).size!==1)continue;
   const [filenameLabel]=names;
   if(nameMatches(filenameLabel,expected,config.profile?.resumeAliases))result.set(id,result.has(id)?null:{source:attachmentCardSource,messageId:id,filenameLabel});
  }
  return [...result.values()].filter(Boolean);
 }
 function controls({root,config={}}){
  const configured=list(root,config,'resumeOpen');
  const toolbar=unique([...configured,...root.querySelectorAll('.toolbar-btn,button,[role="button"]')]).filter(visible).filter(e=>text(e)==='发简历'||configured.includes(e));
  const requests=list(root,config,'hrMessage').filter(e=>/附件简历/.test(text(e))&&/同意/.test(text(e))&&(/想要|索要|请求|是否同意/.test(text(e))));
  const request=requests.at(-1)||null;
  const agrees=request?[...request.querySelectorAll('button,a,[role="button"],span,.btn')].filter(visible).filter(e=>/^同意(?:并发送)?$/.test(text(e))&&![...e.children].some(c=>/^同意(?:并发送)?$/.test(text(c)))):[];
  return {toolbar:toolbar.length===1?toolbar[0]:null,request,agree:agrees.length===1?agrees[0]:null};
 }
 function inspect({root,selectedPeer,config={}}){
  const c=controls({root,config}),doc=root.ownerDocument,receipts=[],preview=text(selectedPeer?.querySelector('.last-msg-text'));
  if(isReceipt(preview)){
   const label=normalizedText(preview),echo=messageRows(root,config).some(e=>[text(e),...list(e,config,'messageText').map(text)].some(body=>normalizedText(body).includes(label)));
   if(!echo)receipts.push({source:'sidebar',text:preview});
  }
  const messages=messageSelector(config),noticeNodes=[...root.querySelectorAll('*')].filter(visible).filter(e=>!e.closest(messages)&&isReceipt(text(e))&&!e.querySelector(messages)&&![...e.children].some(child=>isReceipt(text(child))));
  for(const e of noticeNodes.slice(0,20))receipts.push({source:'chat_notice',text:text(e).slice(0,1500)});
  const sentCards=attachmentCards(root,config).slice(-20);
  receipts.push(...sentCards);
  // These visible self rows can be older than the current reply window.
  const attachmentCardAnchors=sentCards.map(({messageId:id,filenameLabel})=>({id,role:'self',filenameLabel}));
  const requestNames=c.request?nodeNames(c.request,config):[];
  const dialogs=list(doc,config,'resumeDialog'),rows=unique(dialogs.flatMap(d=>list(d,config,'resumeRow'))),attachmentNames=unique(rows.flatMap(row=>nodeNames(row,config)));
  const defaultRows=rows.filter(row=>/默认/.test(text(row))),defaults=unique([...requestNames,...defaultRows.flatMap(row=>nodeNames(row,config))]);
  const requestHandled=!!c.request&&/已同意|已接受|已发送|已拒绝/.test(text(c.request));
  return {receipts,...(attachmentCardAnchors.length?{attachmentCardAnchors}:{}),toolbarPresent:!!c.toolbar,toolbarEnabled:enabled(c.toolbar),chooserSupported:dialogs.length>0||/^(?:dialog|menu|listbox|true)$/.test(c.toolbar?.getAttribute('aria-haspopup')||'')||c.toolbar?.getAttribute('data-resume-mode')==='chooser',requestPending:!!c.agree&&!requestHandled,requestHandled,agreeEnabled:enabled(c.agree)&&!requestHandled,requestMessageId:c.request?.getAttribute('data-mid')||c.request?.closest('[data-mid]')?.getAttribute('data-mid')||'',defaultResumeName:defaults.length===1?defaults[0]:'',defaultResumeEvidence:defaults.length===1?(requestNames.length?'request_card':'visible_default_row'):'',attachmentNames,requestText:text(c.request).slice(0,1500)};
 }
 function plan(ui,config){
  const expected=config.profile?.resumeName,aliases=config.profile?.resumeAliases||[],named=nameMatches(ui.defaultResumeName,expected,aliases),allowDefault=config.allowSiteDefaultResume===true;
  if(!expected)return {allowed:false,reason:'未指定站内附件简历'};
  if(ui.receipts.length)return {allowed:false,alreadySent:true,reason:'该会话已有附件发送提示，不重复发送'};
  if(ui.agreeEnabled){if(named||allowDefault)return {allowed:true,route:'accept_request',source:named?'visible_default_name':'site_default_owner_authorized'};if(ui.toolbarEnabled&&ui.chooserSupported)return {allowed:true,route:'toolbar',source:'named_chooser'};return {allowed:false,reason:'同意会发送站内默认附件，附件名称未识别且未开启站内默认附件持续授权'};}
  if(ui.toolbarEnabled&&(ui.chooserSupported||named||allowDefault))return {allowed:true,route:'toolbar',source:named?'visible_default_name':allowDefault?'site_default_owner_authorized':'named_chooser'};
  return {allowed:false,reason:ui.toolbarPresent?'站内发送入口尚未开放，或附件与选择器尚未识别':'站内尚未开放发简历或同意入口'};
 }
 function peerKey(c){
  if(!c?.selectedPeer)return '';
  const name=text(c.selectedPeer.querySelector('.name-text'));
  const company=[...c.selectedPeer.querySelectorAll('.title-box span')].find(e=>!e.matches('.name-box,.name-text')&&!e.querySelector('span')&&text(e)&&text(e)!==name);
  return name&&company?name+'\u001f'+text(company):'';
 }
 async function waitFor(check,doc,timeoutMs,pollMs=1000){
  const immediate=await check();if(immediate)return immediate;
  return await new Promise((resolve,reject)=>{
   let done=false,busy=false,pending=false;
   const finish=(value,error)=>{if(done)return;done=true;observer.disconnect();clearTimeout(timer);clearInterval(pulse);error?reject(error):resolve(value);};
   const run=async()=>{if(done)return;if(busy){pending=true;return;}busy=true;try{const value=await check();if(value)finish(value);}catch(e){finish(null,e);}finally{busy=false;if(pending&&!done){pending=false;void run();}}};
   const observer=new doc.defaultView.MutationObserver(()=>void run());observer.observe(doc.body,{childList:true,subtree:true,characterData:true,attributes:true});
   const timer=setTimeout(()=>finish(null),timeoutMs),pulse=setInterval(()=>void run(),pollMs);void run();
  });
 }
 async function execute({task,before,config,getCurrent,resolveCurrent,ensure,finish,timeoutMs=12000}){
  const expected=config.profile?.resumeName,aliases=config.profile?.resumeAliases||[],doc=before.root.ownerDocument,beforeKey=peerKey(before);let transmitting=false;
  const chooserInputEvents=['pointerdown','keydown','click'];let watchedChooser=null,chooserTouched=false;
  const trackChooserInput=event=>{if(event.isTrusted)chooserTouched=true;};
  const requireUntouchedChooser=()=>{if(chooserTouched)throw Error('附件选择窗口已有人工操作，已停止自动发送');};
  const samePeer=c=>!!c&&c.id===before.id&&(beforeKey?peerKey(c)===beforeKey:c.selectedPeer===before.selectedPeer&&c.header===before.header);
  const current=()=>{const c=getCurrent();if(!samePeer(c)||JSON.stringify(c.messages)!==JSON.stringify(before.messages))throw Error('发送简历前会话或消息已变化');return c;};
  const check=async()=>{await ensure();return current();};
  const readUI=c=>inspect({root:c.root,selectedPeer:c.selectedPeer,config});
  const choosers=()=>list(doc,config,'resumeDialog').filter(d=>list(d,config,'resumeRow').length);
  try{
   const c=await check(),ui=readUI(c),route=plan(ui,config);if(!route.allowed)throw Error(route.reason);
   const beforeIds=messageRows(c.root,config).map(messageId),priorTail=beforeIds.at(-1)||'',priorTailStable=stableMessageId(priorTail)&&beforeIds.indexOf(priorTail)===beforeIds.lastIndexOf(priorTail),knownIds=new Set(beforeIds);
   const beforeReceipts=new Set(ui.receipts.map(r=>r.text));
   let source=route.source,visibleFilename=ui.defaultResumeName;
   const observedReceipt=(conversation,observed=readUI(conversation))=>{
    const fresh=observed.receipts.filter(r=>r.source!==attachmentCardSource&&!beforeReceipts.has(r.text));
    if(fresh.length)return {text:fresh[0].text,filenames:fresh.map(r=>normalizedText(r.text).match(receiptPattern)?.[1]?.trim())};
    if(!priorTailStable||!observed.receipts.some(r=>r.source===attachmentCardSource))return null;
    const latestIds=messageRows(conversation.root,config).map(messageId),tailIndex=latestIds.indexOf(priorTail);
    if(tailIndex<0||tailIndex!==latestIds.lastIndexOf(priorTail))return null;
    const laterIds=new Set(latestIds.slice(tailIndex+1));
    const card=observed.receipts.find(r=>r.source===attachmentCardSource&&!knownIds.has(r.messageId)&&laterIds.has(r.messageId));
    return card?{text:'指定名称的站内附件简历卡片 '+card.filenameLabel,filenames:[card.filenameLabel]}:null;
   };
   const receiptBeforeClick='点击发送前已观察到附件发送回执，已停止后续操作';
   const requireNoReceipt=(conversation,observed=readUI(conversation))=>{if(observed.receipts.length)throw Error(receiptBeforeClick);};
   const receipt=async()=>{
    const after=await resolveCurrent();if(!samePeer(after))throw Error('发送后当前HR会话发生变化，停止继续操作');
    return observedReceipt(after);
   };
   const accept=async evidence=>{
    requireUntouchedChooser();
    const siteDefault=source==='site_default_owner_authorized';
    if(!siteDefault&&evidence.filenames.some(name=>name&&!/(?:\.{3}|…)/.test(name)&&!nameMatches(name,expected,aliases)))throw Error('站内附件回执的文件名与指定简历不一致，发送结果待核对');
    const defaultNote=siteDefault?'主人已授权发送当前站内默认附件；隐藏名称未作指定文件名核对':'已核对指定站内附件名称';
    const value='同一HR会话出现新的附件发送结果：'+evidence.text+'；'+defaultNote;
    await finish(true,value.slice(0,600));return {sent:true,attachmentSource:source,visibleFilename:visibleFilename||'',evidence:value};
   };
   if(route.route==='accept_request'){
    const requestId=ui.requestMessageId;if(!requestId)throw Error('简历索要卡片缺少稳定消息编号，尚未点击同意');
    const latest=await check(),latestUI=readUI(latest),control=controls({root:latest.root,config});
    requireNoReceipt(latest,latestUI);
    if(!latestUI.agreeEnabled||latestUI.requestMessageId!==requestId||!control.agree)throw Error('简历请求在同意前已变化');
    transmitting=true;control.agree.click();const proof=await waitFor(receipt,doc,timeoutMs);if(proof)return await accept(proof);throw Error('同意后没有确认到同一HR的新附件发送提示，不自动重发');
   }
   const latest=await check(),control=controls({root:latest.root,config});requireNoReceipt(latest);if(!enabled(control.toolbar))throw Error('发简历入口已变化或尚未开放');
   const priorChoosers=new Set(choosers());
   // A toolbar can send immediately on a changed site version. aria-haspopup is
   // chooser evidence, not proof that a click cannot transmit an attachment.
   transmitting=true;control.toolbar.click();
   const opened=await waitFor(async()=>{const proof=await receipt(),dialogs=choosers();const dialog=dialogs.length===1?dialogs[0]:null;return proof||dialog?{proof,dialog}:null;},doc,Math.min(timeoutMs,6500));
   if(opened?.dialog&&!priorChoosers.has(opened.dialog)){
    transmitting=false;
    if(opened.proof)throw Error(receiptBeforeClick);
   }
   if(opened?.proof)return await accept(opened.proof);if(!opened?.dialog)throw Error('打开入口后未识别附件选择窗口或发送回执，不重复点击');
   const dialog=opened.dialog;
   watchedChooser=dialog;
   for(const event of chooserInputEvents)dialog.addEventListener(event,trackChooserInput,true);
   const selectRow=(rows=list(dialog,config,'resumeRow'))=>{
    let matches=rows.filter(row=>nodeNames(row,config).some(n=>nameMatches(n,expected,aliases))),attachmentSource='named_chooser';
    if(!matches.length&&config.allowSiteDefaultResume===true){
     const defaults=rows.filter(row=>/默认/.test(text(row)));
     matches=defaults.length===1?defaults:rows.length===1?rows:[];
     attachmentSource='site_default_owner_authorized';
    }
    if(matches.length!==1)return null;
    const [row]=matches;
    return {row,attachmentSource,filename:nodeNames(row,config).join(' / ')};
   };
   const selected=selectRow();if(!selected)throw Error('附件列表未唯一匹配指定简历，不选择其他文件');
   const sameSelection=choice=>choice?.row===selected.row&&choice.attachmentSource===selected.attachmentSource&&choice.filename===selected.filename;
   const selectionMarker='[aria-selected="true"],[aria-checked="true"],input[type="radio"]:checked,input[type="checkbox"]:checked,.selected,.is-selected';
   const markedRows=rows=>rows.filter(row=>row.matches(selectionMarker)||row.querySelector(selectionMarker));
   requireNoReceipt(await check());
   requireUntouchedChooser();
   const latestChoosers=choosers();
   if(latestChoosers.length!==1||latestChoosers[0]!==dialog||!sameSelection(selectRow())||!enabled(selected.row))throw Error('待选附件或选择窗口已变化，已停止操作');
   source=selected.attachmentSource;visibleFilename=selected.filename;transmitting=true;selected.row.click();
   const immediate=await receipt();if(immediate)return await accept(immediate);
   const confirmButton=()=>{const buttons=list(dialog,config,'resumeConfirm').filter(enabled).filter(e=>/^(?:发送|确定|确认)(?:简历)?$/.test(text(e)));return buttons.length===1?buttons[0]:null;};
   const confirm=await waitFor(confirmButton,doc,Math.min(timeoutMs,3500));
   if(!confirm)throw Error('附件已选但未识别唯一发送确认按钮，停止继续操作');
   const markedBefore=markedRows(list(dialog,config,'resumeRow')).length>0;
   requireNoReceipt(await check());requireUntouchedChooser();
   if(!visible(dialog)||confirmButton()!==confirm)throw Error('发送简历确认窗口已变化');
   const rowsBeforeConfirm=list(dialog,config,'resumeRow'),marked=markedRows(rowsBeforeConfirm);
   const markedSelectionChanged=(markedBefore||marked.length>0)&&(marked.length!==1||marked[0]!==selected.row);
   if(rowsBeforeConfirm.length&&(!sameSelection(selectRow(rowsBeforeConfirm))||markedSelectionChanged))throw Error('确认前选中的附件已变化，已停止自动发送');
   confirm.click();
   const proof=await waitFor(receipt,doc,timeoutMs);if(proof)return await accept(proof);throw Error('发送后未确认同一HR的新附件回执，不自动重发');
  }catch(error){error.resumeTransmissionStarted=transmitting;throw error;}
  finally{if(watchedChooser)for(const event of chooserInputEvents)watchedChooser.removeEventListener(event,trackChooserInput,true);}
 }
 globalThis.BossResumeUI=Object.freeze({inspect,controls,execute,nameMatches,plan,waitForDOM:waitFor});
})();
