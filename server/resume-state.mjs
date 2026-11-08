import {createHash} from 'node:crypto';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,24);
const attachmentCardSource='self_attachment_card';
export function resumeNameMatches(actual,expected,aliases=[]){
 const norm=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,'').replace(/\.pdf$/i,'').toLowerCase();
 if(!actual||/(?:\.{3}|…)/.test(actual))return false;
 return [expected,...(Array.isArray(aliases)?aliases:[])].some(value=>value&&norm(actual)===norm(value));
}
// The owner may explicitly authorize BOSS's current default attachment. This is
// a separate source from a visible, verified filename and never invents that name.
export function resumeDispatchPlan(ui={},options={}){
 const expected=options.resumeName||options.profile?.resumeName,aliases=options.resumeAliases||options.profile?.resumeAliases||[],allowDefault=options.allowSiteDefaultResume===true;
 if(!expected)return {allowed:false,reason:'未指定站内附件简历'};
 if(ui.status==='sent'||ui.receipts?.length)return {allowed:false,alreadySent:true,reason:'该会话已有附件发送记录，不重复发送'};
 const named=resumeNameMatches(ui.defaultResumeName,expected,aliases);
 if(ui.agreeEnabled&&!ui.requestHandled){
  if(named||allowDefault)return {allowed:true,route:'accept_request',attachmentSource:named?'visible_default_name':'site_default_owner_authorized',visibleFilename:named?ui.defaultResumeName:''};
  if(ui.toolbarEnabled&&ui.chooserSupported)return {allowed:true,route:'choose_attachment',attachmentSource:'named_chooser',inspectRequired:true};
  return {allowed:false,reason:'HR索要卡片可同意，但附件名称未展示；等待可核对的附件列表或主人对站内默认附件的持续授权'};
 }
 if(ui.toolbarEnabled&&(ui.chooserSupported||named||allowDefault))return {allowed:true,route:'toolbar',attachmentSource:named?'visible_default_name':allowDefault?'site_default_owner_authorized':'named_chooser',inspectRequired:!named};
 if(ui.toolbarEnabled)return {allowed:false,reason:'发送入口可见，但默认附件及选择窗口尚未识别'};
 return {allowed:false,reason:'网站当前未开放发简历或同意入口，尚未尝试发送'};
}
export function parseResumeReceipt(text,source='chat_notice'){
 const raw=String(text||'').trim();if(raw.length>1500)return null;
 const match=raw.replace(/\s+/g,' ').match(/^您的附件简历\s*(.*?)\s*已发送给\s*Boss(?:\s*点击查看附件)?$/i);
 if(!match)return null;const filenameLabel=match[1].trim();
 return {id:digest({raw,source}),raw,source,filenameLabel,filenameComplete:!!filenameLabel&&!/(?:\.{3}|…)/.test(filenameLabel),status:'sent'};
}
export function parseSelfAttachmentReceipt(input){
 const {source,messageId,filenameLabel}=input||{};
 if(source!==attachmentCardSource||typeof messageId!=='string'||!/^[^\s\u0000-\u001f\u007f]{1,250}$/u.test(messageId)||typeof filenameLabel!=='string'||!filenameLabel.trim()||filenameLabel.length>250||/(?:\.{3}|…|[\u0000-\u001f\u007f])/.test(filenameLabel))return null;
 return {id:digest({source,messageId}),source,messageId,raw:`站内我方附件简历卡片 ${filenameLabel}（消息编号 ${messageId}）`,filenameLabel,filenameComplete:true,status:'sent'};
}
function corroboratesSelfCard(c,card,anchors){
 if(!Array.isArray(anchors)||anchors.length>20)return false;
 const visible=anchors.filter(anchor=>anchor?.id===card.messageId);
 if(visible.length>1||visible.some(anchor=>anchor.role!=='self'||anchor.filenameLabel!==card.filenameLabel))return false;
 const current=(c.window||[]).filter(message=>message.id===card.messageId);
 if(current.length)return current.length===1&&current[0].role==='self';
 const historical=(c.history||[]).filter(message=>message.id===card.messageId);
 if(historical.length)return historical.length===1&&historical[0].role==='self'&&['boss_dom','boss_dom_history'].includes(historical[0].source);
 return visible.length===1;
}
export function observeResumeUI(c,input,now=Date.now(),profile={}){
 if(!input||typeof input!=='object')return false;
 const receipts=[];
 for(const row of (Array.isArray(input.receipts)?input.receipts:[]).slice(0,41)){
  if(!row||typeof row!=='object')continue;
  if(row.source!==attachmentCardSource){
   const receipt=parseResumeReceipt(row.text,['chat_notice','sidebar'].includes(row.source)?row.source:'chat_notice');
   if(receipt)receipts.push(receipt);
   continue;
  }
  const card=parseSelfAttachmentReceipt(row);
  if(!card||!resumeNameMatches(card.filenameLabel,profile.resumeName,profile.resumeAliases))continue;
  if(corroboratesSelfCard(c,card,input.attachmentCardAnchors===undefined?[]:input.attachmentCardAnchors))receipts.push(card);
 }
 const capabilities={toolbarPresent:input.toolbarPresent===true,toolbarEnabled:input.toolbarEnabled===true,chooserSupported:input.chooserSupported===true,requestPending:input.requestPending===true&&input.requestHandled!==true,requestHandled:input.requestHandled===true,agreeEnabled:input.agreeEnabled===true,requestMessageId:String(input.requestMessageId||'').slice(0,250),defaultResumeName:String(input.defaultResumeName||'').slice(0,250),defaultResumeEvidence:String(input.defaultResumeEvidence||'').slice(0,100),attachmentNames:(Array.isArray(input.attachmentNames)?input.attachmentNames:[]).filter(n=>typeof n==='string').slice(0,20).map(n=>n.slice(0,250))};
 const prior=c.resume||{status:'unknown',receipts:[]},all=[...(prior.receipts||[])];
 for(const r of receipts){const old=all.find(x=>x.id===r.id);if(old)old.lastSeenAt=now;else all.push({...r,observedAt:now,lastSeenAt:now});}
 const status=all.length?'sent':'unknown',workflow=status==='sent'?(prior.followup?.status==='sent'?'followed_up_waiting_hr':'resume_sent_followup'):capabilities.requestPending?'resume_requested':capabilities.toolbarEnabled?'resume_available':'waiting_hr_reply_or_site_permission';
 const signature=digest({status,workflow,capabilities,receipts:all.map(r=>r.id)}),changed=signature!==prior.signature;
 c.resume={...prior,status,workflow,receipts:all.slice(-50),capabilities,signature,lastObservedAt:now};return changed;
}
export function confirmResumeSent(c,input,now=Date.now()){
 const raw=String(input.evidence||'主人确认：此HR的附件简历已经发送').slice(0,1500),filenameLabel=String(input.filenameLabel||'').slice(0,250),receipt={id:digest({source:'owner_confirmation',raw,filenameLabel}),source:'owner_confirmation',raw,filenameLabel,filenameComplete:!!filenameLabel&&!/(?:\.{3}|…)/.test(filenameLabel),status:'sent',observedAt:now,lastSeenAt:now};
 c.resume??={status:'unknown',receipts:[]};if(!c.resume.receipts.some(r=>r.id===receipt.id))c.resume.receipts.push(receipt);c.resume.status='sent';c.resume.workflow='resume_sent_followup';delete c.resume.signature;return receipt;
}
export function resumeContext(c){
 if(!c?.resume)return {status:'unknown',note:'未观察到附件状态，不代表未发送。'};
 const r=c.resume;return {status:r.status,workflow:r.workflow,capabilities:r.capabilities,followup:r.followup,receipts:r.receipts.map(({source,raw,filenameLabel,filenameComplete,observedAt})=>({source,raw,filenameLabel,filenameComplete,observedAt})),note:'附件发送提示独立于普通消息保存；同意后网站自动发送也算已发。文件名被截断时不推断完整名称。已发简历后跟进筛选进度，不再执行历史索要卡片。工具栏缺失或禁用表示网站当前不允许主动发附件，不是发送失败。若主人明确开启站内默认附件持续授权，可接受该站内现有默认附件；名称未显示时只报告默认附件，不声称已核对指定文件名。'};
}
