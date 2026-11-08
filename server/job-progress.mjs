import {jobURL} from './job-match.mjs';
import {matchesReceiptBody,outgoingText} from './outgoing-dedup.mjs';
import {parseResumeReceipt,parseSelfAttachmentReceipt} from './resume-state.mjs';

export const emptyJobProgress=Object.freeze({status:'unobserved',at:null,contact:'unknown',resume:'unknown',pending:null,uncertain:false});
const sendActions=new Set(['send_text','send_resume']);
const messageSources=new Set(['boss_dom','boss_dom_history']);
const pendingTargets=new Set(['reading','generating','ready']);
const timestamp=value=>Number.isSafeInteger(value)&&value>0&&value<=253402271999999?value:null;
const later=(a,b)=>Math.max(a||0,b||0)||null;
const text=value=>typeof value==='string'?value.trim():'';
const messageId=value=>Number.isSafeInteger(value)||typeof value==='string'&&!!text(value)&&value.length<=250&&!/[\u0000-\u001f]/u.test(value);
const items=value=>Array.isArray(value)?value:[];
const legacyNewText=/^同一会话出现新消息编号 [a-zA-Z0-9_.:-]{1,250} 及本次完整正文（忽略时间与送达标签）$/u;
const attachmentPrefix='同一HR会话出现新的附件发送结果：';
const attachmentNote=/；(?:已核对指定站内附件名称|主人已授权发送当前站内默认附件；隐藏名称未作指定文件名核对)$/u;
const existingGreeting=/^(?:聊天记录已存在完全相同的招呼语，未重复发送|站内已有相同招呼正文，未计为本轮新发送)$/u;
const platformPrompt=/^(?:快来与|向.{0,20}打招呼|对方还没有|开始沟通)/u;

function canonical(value){
  try{const url=new URL(value);return !url.username&&!url.password?jobURL(url):'';}catch{return '';}
}

function verifiedText(record,peerId,history){
  if(!text(record.text))return false;
  const receipt=record.receipt;
  if(receipt?.peerId&&receipt.peerId!==peerId)return false;
  if(receipt?.messageId!==undefined)return messageId(receipt.messageId)&&!!text(receipt.observedText)&&matchesReceiptBody(receipt.observedText,record.text);
  if(record.messageId&&items(history).some(message=>message.role==='self'&&message.id===record.messageId&&observedMessage(message)&&matchesReceiptBody(message.text,record.text)))return true;
  return legacyNewText.test(text(record.evidence));
}

function observedMessage(message){
  return messageSources.has(message?.source)&&['self','hr'].includes(message.role)&&!!text(message.id)&&
    !!outgoingText(message.text||'')&&!platformPrompt.test(text(message.text));
}

function latestObservedContact(history){
  const messages=items(history);
  let latest;
  for(let index=messages.length-1;index>=0;index--){
    const message=messages[index],at=timestamp(message?.observedAt);
    if((latest===undefined||at>latest)&&observedMessage(message))latest=at;
  }
  return latest;
}

function verifiedAttachment(value){
  const evidence=text(value);
  if(!evidence.startsWith(attachmentPrefix))return false;
  const proof=evidence.slice(attachmentPrefix.length).replace(attachmentNote,'');
  return /^指定名称的站内附件简历卡片 \S/u.test(proof)||!!parseResumeReceipt(proof);
}

function confirmedResume(receipt){
  if(receipt?.status!=='sent'||!text(receipt.id)||!text(receipt.raw))return false;
  if(receipt.source==='owner_confirmation')return true;
  if(receipt.source==='execution_receipt')return verifiedAttachment(receipt.raw);
  if(receipt.source==='self_attachment_card')return parseSelfAttachmentReceipt(receipt)?.id===receipt.id;
  return ['chat_notice','sidebar'].includes(receipt.source)&&!!parseResumeReceipt(receipt.raw,receipt.source);
}

export function projectJobProgress({jobs,tasks,memories,greetingPlans}={}){
  const jobLinks=new Map(),knownLinks=new Set(),progress=new Map();
  for(const job of Object.values(jobs||{})){
    const id=text(job?.id),url=canonical(job?.url);
    if(!id||!url)continue;
    if(jobLinks.has(id)&&jobLinks.get(id)!==url)jobLinks.set(id,null);
    else jobLinks.set(id,url);
    knownLinks.add(url);
  }
  function resolve(job,...ids){
    const url=canonical(job?.url);
    if(job?.url&&!url)return '';
    const links=new Set([url,...[job?.id,...ids].filter(id=>jobLinks.has(id)).map(id=>jobLinks.get(id))].filter(value=>value!==''));
    return links.size===1?[...links][0]:'';
  }
  function record(url,status,at){
    if(!knownLinks.has(url))return;
    const data=progress.get(url)||new Map();
    data.set(status,later(data.get(status),timestamp(at)));
    progress.set(url,data);
  }
  function recordSend(url,send,peerId,at,history){
    if(send.kind==='greeting'&&(send.alreadyPresent===true||existingGreeting.test(text(send.evidence)))&&['skip','sent'].includes(send.status)){
      record(url,'contacted',at);
      return;
    }
    if(!sendActions.has(send.action))return;
    if(send.status==='sent'){
      if(send.action==='send_text'&&verifiedText(send,peerId,history))record(url,'message_sent',at);
      if(send.action==='send_resume'&&verifiedAttachment(send.evidence))record(url,'resume_execution',at);
    }else if(send.status==='uncertain')record(url,'receipt_uncertain',at);
    else if(send.status==='executing')record(url,'sending',at);
    else if(['pending','approved'].includes(send.status))record(url,'pending',at);
  }

  const linkedTargets=new Map(),taskIds=new Set(),peerLinks=new Map();
  for(const plan of items(greetingPlans))for(const target of items(plan?.targets)){
    if(!target)continue;
    if(target.taskId)linkedTargets.set(target.taskId,{plan,target});
    // Queued candidates can exceed the number of requested greetings.
    if(plan.status==='queued'&&!target.taskId&&pendingTargets.has(target.status))record(resolve(null,target.jobId),'pending',target.updatedAt||plan.createdAt);
  }
  for(const task of items(tasks)){
    if(!task)continue;
    if(task.id)taskIds.add(task.id);
    const binding=linkedTargets.get(task.id);
    const target=task.kind==='greeting'&&binding&&binding.plan.id===task.greetingPlanId&&binding.target.id===task.greetingTargetId?binding.target:null;
    const url=resolve(task.job,task.jobId,target?.jobId);
    if(task.peerId&&url){
      const links=peerLinks.get(task.peerId)||new Set();links.add(url);peerLinks.set(task.peerId,links);
    }
    recordSend(url,task,task.peerId,task.receipt?.observedAt||task.receipt?.inspectedAt||task.updatedAt||task.reservedAt||task.createdAt);
  }
  for(const conversation of Object.values(memories||{})){
    const url=resolve(conversation?.job);
    if(!knownLinks.has(url))continue;
    // Conversation-wide messages and attachments have no per-message job URL.
    // A role change makes old and newly re-observed history ambiguous.
    const roleChanged=items(conversation.jobHistory).some(entry=>canonical(entry?.job?.url)!==url)||
      [...(peerLinks.get(conversation.peerId)||[])].some(link=>link!==url);
    if(roleChanged)continue;
    const contactAt=latestObservedContact(conversation.history);
    if(contactAt!==undefined)record(url,'contacted',contactAt);
    for(const receipt of items(conversation.resume?.receipts))if(confirmedResume(receipt)){
      record(url,receipt.source==='execution_receipt'?'resume_execution':'resume_sent',receipt.observedAt);
    }
    for(const send of items(conversation.sends))if(send&&['sent','uncertain'].includes(send.status)&&!taskIds.has(send.taskId)&&(!send.peerId||send.peerId===conversation.peerId)){
      recordSend(url,send,conversation.peerId,send.receipt?.observedAt||send.receipt?.inspectedAt||send.at,conversation.history);
    }
  }

  const entries=[];
  for(const [id,url] of jobLinks){
    const data=progress.get(url);
    if(!data)continue;
    const uncertain=data.has('receipt_uncertain');
    const pending=data.has('sending')?'sending':data.has('pending')?'pending':null;
    const resume=data.has('resume_sent')||data.has('resume_execution')?'confirmed':'unknown';
    const contact=data.has('message_sent')||data.has('resume_execution')?'verified_send':data.has('contacted')||resume==='confirmed'?'history':'unknown';
    const status=uncertain?'receipt_uncertain':pending||(resume==='confirmed'?'resume_sent':contact==='verified_send'?'message_sent':'contacted');
    const at=status==='resume_sent'?later(data.get('resume_sent'),data.get('resume_execution')):data.get(status);
    entries.push([id,{status,at,contact,resume,pending,uncertain}]);
  }
  return Object.fromEntries(entries);
}
