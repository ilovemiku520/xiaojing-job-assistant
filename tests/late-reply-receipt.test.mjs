import test from 'node:test';
import assert from 'node:assert/strict';
import {blocksReplyAfterSettlement,captureAutoReplyClaim,settleLateAutoReplies,stableInboundAnchor} from '../server/late-reply-receipt.mjs';
import {authorForMessage} from '../server/message-authorship.mjs';

const peerId='boss:fixture',body='您好，主人还在了解策划实习机会。';
const row=(id,role,text)=>({id,role,text});
const prior=row('prior-self','self','之前的站内消息');
const anchor=row('hr-anchor','hr','您好，还在了解实习吗？');
const late=row('late-self','self',body);
const next=row('hr-next','hr','谢谢，能介绍一下作品集吗？');
const dom=(message,observedAt=150)=>({...message,source:'boss_dom',observedAt});

function fixture({window=[prior,anchor,late],history=window.map(message=>dom(message)),overrides={}}={}){
 const conversation={peerId,window,history,stableMessageIds:true,sends:[],decisions:[],...overrides};
 const task={id:'auto-reply',kind:'reply',action:'send_text',sourceChannel:'hrInbox',status:'pending',peerId,text:body,autoReplyAnchor:anchor.id};
 const before={...conversation,peerId,window:[prior,anchor]};
 task.autoReplyClaim=captureAutoReplyClaim(task,before);
 assert.equal(task.autoReplyClaim?.tailId,anchor.id);
 Object.assign(task,{status:'uncertain',reservedAt:100,evidence:'测试中未及时看到回执'});
 conversation.sends.push({taskId:task.id,status:'uncertain',text:body});
 conversation.decisions.push({taskId:task.id,status:'uncertain'});
 return {task,conversation,window};
}

test('只有普通自动文字回复且末条为唯一稳定HR编号才记录核对锚点',()=>{
 const window=[prior,anchor],conversation={peerId,window,stableMessageIds:true};
 const task={kind:'reply',action:'send_text',status:'pending',sourceChannel:'hrInbox',peerId,autoReplyAnchor:anchor.id};
 assert.equal(stableInboundAnchor(conversation,window),anchor.id);
 assert.equal(stableInboundAnchor(conversation,[prior,{...anchor,role:'other'}]),'');
 assert.deepEqual(captureAutoReplyClaim(task,conversation).messageIds,[prior.id,anchor.id]);
 for(const patch of [{kind:'followup'},{action:'send_resume'},{status:'approved'},{autoReplyAnchor:'old'},{peerId:'boss:other'}])assert.equal(captureAutoReplyClaim({...task,...patch},conversation),null);
 assert.equal(captureAutoReplyClaim(task,{...conversation,window:[anchor,anchor]}),null);
});

test('迟到的同会话完整我方回执关闭原任务并保持作者归属',()=>{
 const {task,conversation,window}=fixture();
 assert.equal(settleLateAutoReplies([task],conversation,window,200),true);
 assert.equal(task.status,'skip');assert.equal(task.previousStatus,'uncertain');
 assert.deepEqual(task.receipt,{source:'account_message_observed',peerId,messageId:late.id,observedAt:150,observedText:body});
 assert.equal(conversation.sends[0].status,'skip');assert.equal(conversation.decisions[0].status,'skip');
 assert.equal(authorForMessage(conversation,late).kind,'account_self_unknown');
 conversation.authorConfirmations={[late.id]:{kind:'owner_confirmed',source:'authenticated_owner',text:body}};
 assert.equal(authorForMessage(conversation,late).kind,'owner_confirmed');
 assert.equal(settleLateAutoReplies([task],conversation,window,210),false);
});

test('错会话、旧记录、编辑、未知角色和重复正文不能解除待核对',()=>{
 const checks=[
  {window:[anchor,{...late,role:'hr'}]},
  {window:[anchor,{...late,text:body+'其他正文'}]},
  {window:[anchor,late,row('duplicate','self',body)]},
  {window:[anchor,late,late]},
  {window:[late,anchor]},
  {window:[prior,late]},
  {window:[{...anchor,text:'原消息正文被替换'},late]},
  {window:[anchor,{...late,id:prior.id}]},
  {history:[dom(anchor),dom(late,90)]},
  {history:[dom(anchor),{...dom(late),source:'boss_dom_history'}]},
  {history:[dom(anchor),{...dom(late),previousVersions:[{role:'self',text:'其他正文',at:140}]}]},
  {history:[dom(anchor),dom(late),dom(late)]},
  {history:[dom(anchor),dom(late),dom(row('other-window-duplicate','self',body))]},
  {overrides:{peerId:'boss:other'}}
 ];
 for(const options of checks){const {task,conversation,window}=fixture(options);assert.equal(settleLateAutoReplies([task],conversation,window,200),false);assert.equal(task.status,'uncertain');}
 for(const falseProof of [{...late,role:'system'},{...late,text:body+' '.repeat(4100)+'未显示后缀'}]){
  const {task,conversation}=fixture();assert.equal(settleLateAutoReplies([task],conversation,[prior,anchor,falseProof],200),false);
 }
 const {task,conversation,window}=fixture();delete task.autoReplyClaim;
 assert.equal(settleLateAutoReplies([task],conversation,window,200),false);
});

test('恢复后只允许回执后真正的新HR来信，原触发消息改变快照也不会重放',()=>{
 const {task,conversation,window}=fixture();settleLateAutoReplies([task],conversation,window,200);
 function blocked(window,history){return blocksReplyAfterSettlement([task],{...conversation,window,history},window);}
 const history=[dom(prior,60),dom(anchor,80),dom(late),dom(next,230)];
 assert.equal(blocked([prior,{...anchor,time:'12:02'}],history),true);
 assert.equal(blocked([anchor,late,next],history),false);
 assert.equal(blocked([next],history),false);
 assert.equal(blocked([next],[...history.slice(0,-1),dom(next,180)]),true);
 assert.equal(blocked([late,next],[...history.slice(0,-1),{...dom(next,230),source:'boss_dom_history'}]),true);
 assert.equal(blocked([late,{...next,id:'old-history'}],[...history,dom({...next,id:'old-history'},70)]),true);
});

test('回执后的新附件索要可以在我方确认后触发，旧卡片不重放',()=>{
 const {task,conversation,window}=fixture();settleLateAutoReplies([task],conversation,window,200);
 const request=row('new-resume-request','hr','可以发送附件简历吗？'),ack=row('self-ack','self','好的');
 const history=[dom(anchor,80),dom(late),dom(request,230),dom(ack,240)];
 const updated=[anchor,late,request,ack],current={...conversation,window:updated,history};
 assert.equal(blocksReplyAfterSettlement([task],current,updated,request.id),false);
 assert.equal(blocksReplyAfterSettlement([task],current,updated,anchor.id),true);
 assert.equal(blocksReplyAfterSettlement([task],current,updated,ack.id),true);
 const requestBeforeReceipt=[anchor,request,late,ack];
 assert.equal(blocksReplyAfterSettlement([task],{...current,window:requestBeforeReceipt},requestBeforeReceipt,request.id),true);
});
