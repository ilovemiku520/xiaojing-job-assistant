import {channelRunning} from './channels.mjs';
import {randomUUID} from 'node:crypto';

const pendingReplyStates=['queued','generating','auth_blocked'];

// Only bounded scheduling metadata is persisted here. Message bodies remain in
// the conversation store, and draft execution still belongs to the normal lease.
export function createReplyQueue({state,prepare,persist,capacity,canResumeAuth=()=>false,now=Date.now}={}){
 state.replyQueue=Array.isArray(state.replyQueue)?state.replyQueue.slice(-120):[];
 const inputs=new Map();let closed=false,pumping=false;
 const taskFor=row=>row.taskId?state.tasks.find(t=>t.id===row.taskId):null;
 for(const row of state.replyQueue)if(pendingReplyStates.includes(row.status)||row.status==='failed'&&!taskFor(row)){
  row.status='stale';row.reason='服务已重启，等待重新观察最新消息';row.finishedAt=now();
  delete row.retryAt;
 }
 const current=row=>channelRunning(state.config,'hrInbox')&&state.config.chatRead&&state.memories[row.peerId]?.revision===row.revision&&state.memories[row.peerId]?.fingerprint===row.fingerprint;
 function sync(row,task=taskFor(row)){
  if(!task)return row;
  const next=['pending','approved','executing'].includes(task.status)?'ready':task.status==='hold'?'hold':task.status==='skip'?'skip':task.status==='stale'?'stale':task.status==='failed'?'failed':'done';
  if(row.status!==next){row.status=next;row.reason=task.reason||'';if(!['ready','hold'].includes(next))row.finishedAt=task.updatedAt||now();}
  if(task.status==='uncertain')row.reason='发送结果待核对，不自动重发';
  return row;
 }
 function publicRow(row,sendEligibility){
  const task=taskFor(row);
  sync(row,task);
  const {id,peerId,name,company,key,status,taskId,reason,queuedAt,startedAt,finishedAt,retryAt,timing}=row;
  const retryScheduled=status==='failed'&&retryAt&&inputs.has(id)&&current(row);
  return {id,peerId,name,company,key,status,...(taskId?{taskId}:{}),reason,queuedAt,startedAt,finishedAt,
   ...(retryAt?{retryAt}:{}),...(retryScheduled?{retryScheduled:true}:{}),...(timing?{timing}:{}),
   ...(sendEligibility&&status==='ready'?{sendEligible:sendEligibility(task)}:{})};
 }
 function rows(sendEligibility){return state.replyQueue.map(row=>publicRow(row,sendEligibility));}
 function invalidate(reason,peerId,{preserveAuthBlocked=false}={}){
  let changed=false;for(const row of state.replyQueue){sync(row);if((!peerId||row.peerId===peerId)&&(pendingReplyStates.includes(row.status)||row.status==='failed')){
   if(preserveAuthBlocked&&row.status==='auth_blocked'&&inputs.has(row.id)&&current(row))continue;
   row.status='stale';row.reason=reason;row.finishedAt=now();inputs.delete(row.id);changed=true;
  }}return changed;
 }
 function enqueue(input,c,sendEligibility){
  if(closed)throw Error('回复队列已关闭');
  const trigger=input.trigger==='resume_sent_reply'?'resume_sent_reply':'new_hr_message';
  const continuation=trigger==='resume_sent_reply'?c.pendingReplyAfterResume?.messageId||'':'';
  const signature=JSON.stringify([c.peerId,c.revision,c.fingerprint,trigger,continuation]);
  const existing=state.replyQueue.findLast(row=>row.signature===signature&&sync(row).status!=='stale'&&!(row.status==='failed'&&!inputs.has(row.id)&&taskFor(row)?.status==='failed'));
  if(existing){void pump();return publicRow(existing,sendEligibility);}
  if(state.replyQueue.filter(row=>pendingReplyStates.includes(row.status)).length>=50)throw Error('待处理回复较多，请等待当前消息处理');
  for(const row of state.replyQueue)if(row.peerId===c.peerId&&(pendingReplyStates.includes(sync(row).status)||row.status==='failed')){row.status='stale';row.reason='有更新的会话观察';row.finishedAt=now();inputs.delete(row.id);}
  const label=input.label||{},clean=v=>String(v||'').trim().slice(0,180),name=clean(label.name),company=clean(label.company);
  const row={id:randomUUID(),peerId:c.peerId,name,company,key:name&&company?name+'\u001f'+company:'',status:'queued',queuedAt:now(),revision:c.revision,fingerprint:c.fingerprint,signature,attempts:0};
  state.replyQueue.push(row);inputs.set(row.id,{...structuredClone(input),kind:'reply',trigger});
  // Never evict a pending request or a draft the browser still has to execute.
  while(state.replyQueue.length>120){const index=state.replyQueue.findIndex(r=>!pendingReplyStates.includes(sync(r).status)&&r.status!=='ready');if(index<0)break;inputs.delete(state.replyQueue[index].id);state.replyQueue.splice(index,1);}
  persist();queueMicrotask(()=>void pump());return publicRow(row,sendEligibility);
 }
 async function run(row,input){
  row.status='generating';row.startedAt=now();delete row.retryAt;persist();
  try{
   const result=await prepare(input);
   if(closed||row.status==='stale')return;
   if(result.task){
    row.taskId=result.task.id;sync(row);row.finishedAt=now();
    row.timing={queuedMs:row.startedAt-row.queuedAt,generationMs:row.finishedAt-row.startedAt,...(result.task.timing||{})};
    inputs.delete(row.id);
   }else if(!current(row)){
    row.status='stale';row.reason='消息或运行设置已变化，等待新的观察';row.finishedAt=now();inputs.delete(row.id);
   }else{
    const task=state.tasks.find(t=>t.peerId===row.peerId&&t.fingerprint===row.fingerprint&&t.memoryRevision===row.revision&&!['stale','rejected'].includes(t.status));
    if(task){row.taskId=task.id;sync(row);row.finishedAt=now();inputs.delete(row.id);}
    else if(result.authBlocked){row.status='auth_blocked';row.reason=result.reason;}
    else if(result.retryAt||/生成中/.test(result.reason||'')){row.status='failed';row.reason=result.reason||'稍后重试';row.retryAt=result.retryAt||now()+1000;}
    else{row.status=/待核对/.test(result.reason||'')?'done':'skip';row.reason=result.reason||'当前消息不需要回复';row.finishedAt=now();inputs.delete(row.id);}
   }
  }catch{
   if(closed||row.status==='stale')return;
   row.status='failed';row.reason='本次生成未完成，将稍后重试';row.attempts++;row.retryAt=now()+Math.min(300000,15000*2**Math.min(row.attempts-1,4));
  }finally{persist();queueMicrotask(()=>void pump());}
 }
 async function pump(){
  if(closed||pumping||!channelRunning(state.config,'hrInbox')||!state.config.chatRead)return;
  pumping=true;let resumeAuth;
  try{
   for(const row of state.replyQueue){
    sync(row);if(!['queued','failed','auth_blocked'].includes(row.status)||!inputs.has(row.id)||row.retryAt>now())continue;
    if(!current(row)){row.status='stale';row.reason='消息或运行设置已变化';row.finishedAt=now();inputs.delete(row.id);persist();continue;}
    if(row.status==='auth_blocked'&&!(resumeAuth??=canResumeAuth()))continue;
    if(!capacity(row.peerId))continue;
    // run starts prepare synchronously, reserving its inference slot before the
    // next row is examined; the promise never blocks the HTTP response.
    void run(row,inputs.get(row.id));
   }
  }finally{pumping=false;}
 }
 function close(){closed=true;invalidate('服务已停止，等待重新观察最新消息');}
 return {enqueue,rows,pump,invalidate,close};
}
