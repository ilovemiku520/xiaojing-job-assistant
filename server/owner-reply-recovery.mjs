import {createHash} from 'node:crypto';

const stableId=id=>typeof id==='string'&&/^[^\s\u0000-\u001f\u007f]{1,250}$/u.test(id);
const messageHash=row=>createHash('sha256').update(JSON.stringify([row.id,row.role,row.text])).digest('hex');
const closureReason='主人结束本次待核对，原发送结果仍未确认';
const needStableWindow='需要先读取此会话的稳定消息，再结束待核对';

function ordinaryReply(task){
 return task?.kind==='reply'&&task.action==='send_text'&&task.sourceChannel==='hrInbox'&&!task.ownerChatPlanId&&!task.greetingPlanId&&!task.singleTestPlanId&&!task.resumeReplyAnchor&&Number.isFinite(task.reservedAt)&&task.reservedAt>0;
}

function stableWindow(conversation,raw){
 if(!conversation?.stableMessageIds||!Array.isArray(raw))return null;
 const rows=raw.slice(-80),window=conversation.window;
 if(!rows.length||rows.length!==window?.length||new Set(rows.map(row=>row?.id)).size!==rows.length||rows.some((row,index)=>{
  const observed=window[index];
  return !stableId(row?.id)||!['hr','self'].includes(row.role)||typeof row.text!=='string'||row.id!==observed.id||row.role!==observed.role||row.text!==observed.text;
 }))return null;
 return rows;
}

function historyById(conversation){
 const items=new Map();
 for(const row of conversation.history||[])if(stableId(row?.id))items.set(row.id,items.has(row.id)?null:row);
 return items;
}

function matchesDirectObservation(observed,row){
 return observed?.source==='boss_dom'&&!observed.previousVersions?.length&&observed.role===row.role&&observed.text===row.text&&Number.isFinite(observed.observedAt);
}

function knownMids(conversation){
 return new Set([...(conversation.history||[]),...(conversation.window||[])].map(row=>row?.id).filter(stableId));
}

function closureBaseline(task,conversation){
 if(!conversation||conversation.peerId!==task.peerId)return null;
 const original=task.autoReplyClaim?.tailId||task.replyAnchor;
 if(!stableId(original))return null;
 const window=stableWindow(conversation,conversation.window);if(!window)return null;
 const tail=window.at(-1),history=historyById(conversation),originalObservation=history.get(original);
 if(!matchesDirectObservation(history.get(tail.id),tail)||history.has(original)&&originalObservation?.role!=='hr')return null;
 const known=knownMids(conversation);
 for(const id of [original,task.replyAnchor,conversation.pendingReplyAfterResume?.messageId,...(conversation.ownerReplyRecovery?.knownAtClose||[])])if(stableId(id))known.add(id);
 if(known.size>2500)return null;
 return {boundary:{id:tail.id,hash:messageHash(tail)},knownAtClose:[...known]};
}

export function replyRecoveryDetail(task,conversation){
 if(!ordinaryReply(task))return undefined;
 if(task.ownerClosure?.source==='authenticated_owner')return {eligible:false,closedAt:task.ownerClosure.at};
 if(task.status!=='uncertain')return undefined;
 return closureBaseline(task,conversation)?{eligible:true}:{eligible:false,reason:needStableWindow};
}

export function closeUncertainReply(task,conversation,now=Date.now()){
 if(!ordinaryReply(task))throw Error('只有普通自动文字回复可以在这里结束待核对');
 if(task.ownerClosure?.source==='authenticated_owner')return {ok:true,status:'skip',closedAt:task.ownerClosure.at};
 if(task.status!=='uncertain')throw Error('此回复已结束或没有待核对记录');
 const baseline=closureBaseline(task,conversation);if(!baseline)throw Error(needStableWindow);
 conversation.ownerReplyRecovery={...baseline,closedAt:now,admitted:[]};
 Object.assign(task,{previousStatus:'uncertain',status:'skip',reason:closureReason,updatedAt:now,ownerClosure:{source:'authenticated_owner',at:now,outcome:'unknown'}});
 return {ok:true,status:'skip',closedAt:now};
}

export function snapshotOwnerRecoveryMids(conversation){
 return conversation?.ownerReplyRecovery?knownMids(conversation):null;
}

export function advanceOwnerReplyRecovery(conversation,raw,previous){
 const recovery=conversation.ownerReplyRecovery;if(!recovery||!previous)return false;
 const window=stableWindow(conversation,raw);if(!window)return false;
 const at=window.findIndex(row=>row.id===recovery.boundary.id);
 if(at<0||messageHash(window[at])!==recovery.boundary.hash)return false;
 const after=window.slice(at+1),history=historyById(conversation),blocked=new Set(recovery.knownAtClose);
 if(!matchesDirectObservation(history.get(window[at].id),window[at]))return false;
 if(after.some(row=>{
  const observed=history.get(row.id);
  return blocked.has(row.id)||!matchesDirectObservation(observed,row)||observed.observedAt<recovery.closedAt;
 }))return false;
 const visible=new Set(window.map(row=>row.id)),admitted=new Set(recovery.admitted.filter(id=>visible.has(id)));
 for(const row of after)if(row.role==='hr'&&!previous.has(row.id))admitted.add(row.id);
 if(!after.length&&admitted.size===recovery.admitted.length)return false;
 const tail=window.at(-1);
 recovery.boundary={id:tail.id,hash:messageHash(tail)};recovery.admitted=[...admitted];return true;
}

export function ownerRecoveryInbound(conversation,raw,{trigger,requestMessageId,continuationId}={}){
 const recovery=conversation.ownerReplyRecovery;if(!recovery)return undefined;
 if(continuationId)return recovery.knownAtClose.includes(continuationId)?null:undefined;
 if(trigger!=='new_hr_message')return null;
 const window=stableWindow(conversation,raw);if(!window)return null;
 const boundary=window.at(-1);
 if(boundary.id!==recovery.boundary.id||messageHash(boundary)!==recovery.boundary.hash)return null;
 const inbound=requestMessageId===undefined?window.at(-1):window.find(row=>row.id===requestMessageId);
 if(inbound?.role!=='hr'||recovery.knownAtClose.includes(inbound.id)||!recovery.admitted.includes(inbound.id))return null;
 return matchesDirectObservation(historyById(conversation).get(inbound.id),inbound)?inbound.id:null;
}

export function consumeOwnerRecoveryInbound(conversation,messageId){
 if(messageId&&conversation.ownerReplyRecovery)conversation.ownerReplyRecovery.admitted=conversation.ownerReplyRecovery.admitted.filter(id=>id!==messageId);
}
