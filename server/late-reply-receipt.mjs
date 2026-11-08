import {createHash} from 'node:crypto';
import {matchesReceiptBody} from './outgoing-dedup.mjs';

const stableMid=id=>typeof id==='string'&&/^[^\s\u0000-\u001f\u007f]{1,250}$/u.test(id);
const tailHash=message=>createHash('sha256').update(JSON.stringify([message.id,message.role,message.text])).digest('hex');
const recoveredSource='account_message_observed';
const recoveryEvidence='已在同一会话观察到带新消息编号的完整我方正文，原回复已关闭';
export const manualEditorTakeover='manual_editor_takeover';
export const manualEditorEvidence='人工接手聊天输入，本轮未自动点击发送';

function observedWindow(conversation,raw){
 if(!conversation?.stableMessageIds||!Array.isArray(raw))return null;
 const rows=raw.slice(-80),window=conversation.window;
 if(rows.length!==window?.length||new Set(rows.map(row=>row?.id)).size!==rows.length||rows.some((row,index)=>{
  const observed=window[index];
  return !stableMid(row?.id)||row.id!==observed.id||!['hr','self'].includes(row.role)||row.role!==observed.role||typeof row.text!=='string'||row.text!==observed.text;
 }))return null;
 return rows;
}

export function stableInboundAnchor(conversation,raw){
 const tail=observedWindow(conversation,raw)?.at(-1);
 return tail?.role==='hr'?tail.id:'';
}

export function captureAutoReplyClaim(task,conversation){
 if(task.kind!=='reply'||task.action!=='send_text'||task.status!=='pending'||task.sourceChannel!=='hrInbox'||!conversation?.stableMessageIds||task.peerId!==conversation.peerId)return null;
 const window=conversation.window,tail=window.at(-1),messageIds=window.map(row=>row.id);
 if(tail?.role!=='hr'||tail.id!==task.autoReplyAnchor||!messageIds.every(stableMid)||new Set(messageIds).size!==messageIds.length)return null;
 return {peerId:conversation.peerId,tailId:tail.id,tailHash:tailHash(tail),messageIds};
}

function lateProof(task,conversation,window){
 const claim=task.autoReplyClaim;
 if(claim?.peerId!==conversation.peerId||!Number.isFinite(task.reservedAt)||task.reservedAt<=0)return null;
 const tailIndex=window.findIndex(row=>row.id===claim.tailId);
 if(tailIndex<0||tailHash(window[tailIndex])!==claim.tailHash)return null;
 const visible=window.slice(tailIndex+1).filter(row=>row.role==='self'&&matchesReceiptBody(row.text,task.text));
 if(visible.length!==1)return null;
 const before=new Set(claim.messageIds),message=visible[0];
 if(before.has(message.id)||conversation.sends.some(send=>send.taskId!==task.id&&(send.receipt?.messageId===message.id||send.messageId===message.id)))return null;
 const sameId=conversation.history.filter(row=>row.id===message.id);
 if(sameId.length!==1)return null;
 const [observed]=sameId;
 if(observed.source!=='boss_dom'||observed.role!=='self'||!Number.isFinite(observed.observedAt)||observed.observedAt<=task.reservedAt||observed.previousVersions?.length||!matchesReceiptBody(observed.text,task.text))return null;
 // A second matching account message may have left the current window.
 if(conversation.history.some(row=>row.id!==message.id&&!before.has(row.id)&&row.role==='self'&&row.observedAt>=task.reservedAt&&matchesReceiptBody(row.text,task.text)))return null;
 return {source:recoveredSource,peerId:conversation.peerId,messageId:message.id,observedAt:observed.observedAt,observedText:message.text};
}

export function settleLateAutoReplies(tasks,conversation,raw,now=Date.now()){
 const eligible=tasks.filter(task=>task.status==='uncertain'&&task.kind==='reply'&&task.action==='send_text'&&task.peerId===conversation.peerId&&task.autoReplyClaim);
 if(!eligible.length)return false;
 const window=observedWindow(conversation,raw);if(!window)return false;
 let changed=false;
 for(const task of eligible){
  const receipt=lateProof(task,conversation,window);if(!receipt)continue;
  Object.assign(task,{previousStatus:task.status,previousEvidence:task.evidence,status:'skip',reason:recoveryEvidence,evidence:recoveryEvidence,receipt,updatedAt:now});
  const recorded=conversation.sends.find(send=>send.taskId===task.id);
  const send={taskId:task.id,at:recorded?.at||task.reservedAt,action:'send_text',text:task.text,status:'skip',evidence:recoveryEvidence,receipt};
  if(recorded)Object.assign(recorded,send);else conversation.sends.push(send);
  conversation.sends=conversation.sends.slice(-100);
  const decision=conversation.decisions.find(row=>row.taskId===task.id);if(decision)decision.status='skip';
  changed=true;
 }
 return changed;
}

export function blocksReplyAfterSettlement(tasks,conversation,raw,requestMessageId){
 const settled=tasks.filter(task=>task.peerId===conversation.peerId&&task.autoReplyClaim&&
  (task.receipt?.source===recoveredSource||task.replyOutcome===manualEditorTakeover));
 if(!settled.length)return false;
 const window=observedWindow(conversation,raw);if(!window)return true;
 const inboundIndex=requestMessageId===undefined?window.length-1:window.findIndex(row=>row.id===requestMessageId),inbound=window[inboundIndex];
 if(inbound?.role!=='hr')return true;
 const candidates=conversation.history.filter(row=>row.id===inbound.id);
 if(candidates.length!==1||candidates[0].source!=='boss_dom'||candidates[0].role!=='hr'||candidates[0].previousVersions?.length)return true;
 const [observed]=candidates;
 return settled.some(task=>{
  if(task.autoReplyClaim.messageIds.includes(inbound.id)||!(observed.observedAt>=task.reservedAt))return true;
  if(task.replyOutcome===manualEditorTakeover){
   const anchorIndex=window.findIndex(row=>row.id===task.autoReplyClaim.tailId);
   return anchorIndex>=0?anchorIndex>=inboundIndex||tailHash(window[anchorIndex])!==task.autoReplyClaim.tailHash:!(observed.observedAt>task.updatedAt);
  }
  const receiptIndex=window.findIndex(row=>row.id===task.receipt.messageId),receipt=window[receiptIndex];
  if(receipt)return receiptIndex>=inboundIndex||receipt.role!=='self'||!matchesReceiptBody(receipt.text,task.text);
  return !(observed.observedAt>task.updatedAt);
 });
}
