import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceOwnerReplyRecovery,closeUncertainReply,consumeOwnerRecoveryInbound,ownerRecoveryInbound,replyRecoveryDetail,snapshotOwnerRecoveryMids} from '../server/owner-reply-recovery.mjs';

const peerId='boss:legacy-recovery',trigger='new_hr_message';
const hr=(id,text=id)=>({id,role:'hr',text});
const self=(id,text=id)=>({id,role:'self',text});
const dom=(row,observedAt,source='boss_dom')=>({...row,observedAt,source});
const original=hr('original'),known=hr('already-seen'),boundary=self('known-tail');

function fixture(){
 const task={id:'legacy-uncertain',kind:'reply',action:'send_text',sourceChannel:'hrInbox',status:'uncertain',reservedAt:80,replyAnchor:original.id,peerId,evidence:'原发送结果未知'};
 const conversation={peerId,window:[known,boundary],stableMessageIds:true,history:[dom(original,50),dom(known,90),dom(boundary,90)],
  sends:[{taskId:task.id,status:'uncertain',text:'原回复'}],authorConfirmations:{[boundary.id]:{kind:'owner_confirmed',source:'authenticated_owner'}}};
 return {task,conversation};
}

function observe(conversation,rows,at,{authenticated=true,source='boss_dom'}={}){
 const previous=authenticated?snapshotOwnerRecoveryMids(conversation):null;
 for(const row of rows)if(!conversation.history.some(item=>item.id===row.id))conversation.history.push(dom(row,at,source));
 conversation.window=rows;
 return advanceOwnerReplyRecovery(conversation,rows,previous);
}

test('仅普通自动待核对文字回复可由主人结束，保留送达结果和作者记录',()=>{
 const {task,conversation}=fixture(),sends=structuredClone(conversation.sends),authors=structuredClone(conversation.authorConfirmations);
 assert.deepEqual(replyRecoveryDetail(task,conversation),{eligible:true});
 assert.deepEqual(replyRecoveryDetail(task,null),{eligible:false,reason:'需要先读取此会话的稳定消息，再结束待核对'});
 for(const patch of [{kind:'followup'},{action:'send_resume'},{sourceChannel:'owner'},{singleTestPlanId:'test'},{resumeReplyAnchor:'resume-anchor'}]){
  assert.equal(replyRecoveryDetail({...task,...patch},conversation),undefined);assert.throws(()=>closeUncertainReply({...task,...patch},conversation,100));
 }
 assert.throws(()=>closeUncertainReply({...task,status:'skip'},conversation,100));
 assert.deepEqual(closeUncertainReply(task,conversation,100),{ok:true,status:'skip',closedAt:100});
 assert.deepEqual(replyRecoveryDetail(task,conversation),{eligible:false,closedAt:100});
 assert.deepEqual(closeUncertainReply(task,conversation,160),{ok:true,status:'skip',closedAt:100});
 assert.equal(task.evidence,'原发送结果未知');assert.equal(task.ownerClosure.outcome,'unknown');assert.equal(task.receipt,undefined);
 assert.deepEqual(conversation.sends,sends);assert.deepEqual(conversation.authorConfirmations,authors);
});

test('只允许重叠的认证窗口推进，同一新来信只保留一次处理机会',()=>{
 const {task,conversation}=fixture();closeUncertainReply(task,conversation,100);
 const alreadyObserved=hr('disconnected-first'),fresh=hr('fresh');
 assert.equal(observe(conversation,[alreadyObserved],110),false);
 assert.equal(ownerRecoveryInbound(conversation,[alreadyObserved],{trigger}),null);
 assert.equal(observe(conversation,[boundary,alreadyObserved],120),true);
 assert.equal(ownerRecoveryInbound(conversation,[boundary,alreadyObserved],{trigger}),null);
 const overlap=[alreadyObserved,fresh];
 assert.equal(observe(conversation,overlap,130),true);
 assert.equal(ownerRecoveryInbound(conversation,overlap,{trigger}),fresh.id);
 assert.equal(ownerRecoveryInbound(conversation,overlap,{trigger:'history'}),null);
 consumeOwnerRecoveryInbound(conversation,fresh.id);
 assert.equal(ownerRecoveryInbound(conversation,overlap,{trigger}),null);
 assert.equal(observe(conversation,[original],140),false);
 assert.equal(ownerRecoveryInbound(conversation,[original],{trigger}),null);
 assert.equal(observe(conversation,[fresh,known],150),false);
 assert.equal(ownerRecoveryInbound(conversation,[fresh,known],{trigger}),null);
});

test('仅新附件索要可越过我方尾部确认，旧索要或已知续答不重放',()=>{
 const {task,conversation}=fixture();conversation.pendingReplyAfterResume={messageId:'old-continuation'};
 closeUncertainReply(task,conversation,100);
 const request=hr('new-request','想要一份附件简历'),ack=self('new-ack','好的');
 const update=[boundary,request,ack];assert.equal(observe(conversation,update,120),true);
 assert.equal(ownerRecoveryInbound(conversation,update,{trigger}),null);
 assert.equal(ownerRecoveryInbound(conversation,update,{trigger,requestMessageId:request.id}),request.id);
 assert.equal(ownerRecoveryInbound(conversation,update,{trigger,requestMessageId:known.id}),null);
 assert.equal(ownerRecoveryInbound(conversation,update,{continuationId:'old-continuation'}),null);
 assert.equal(ownerRecoveryInbound(conversation,update,{continuationId:request.id}),undefined);
});

test('主人直传、历史导入、重复编号、改写边界不能恢复',()=>{
 const suspicious=hr('suspicious');
 for(const [rows,options] of [
  [[boundary,suspicious],{authenticated:false}],[[boundary,suspicious],{source:'boss_dom_history'}],
  [[boundary,suspicious,suspicious],{}],[[{...boundary,text:'另一个正文'},suspicious],{}]
 ]){
  const {task,conversation}=fixture();closeUncertainReply(task,conversation,100);
  assert.equal(observe(conversation,rows,120,options),false);
  assert.equal(ownerRecoveryInbound(conversation,rows,{trigger}),null);
  assert.equal(conversation.ownerReplyRecovery.boundary.id,boundary.id);
 }
});
