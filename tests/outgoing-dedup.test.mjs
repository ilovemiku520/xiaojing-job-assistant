import test from 'node:test';
import assert from 'node:assert/strict';
import {outgoingText,duplicateOutgoing,applyOutgoingDedup} from '../server/outgoing-dedup.mjs';
const ack='收到，我会把具体安排转给主人确认，确认后再回复你。';
const base=()=>({memories:{peer:{history:[{id:'h1',role:'hr',text:'通过后会邀请来公司面试',observedAt:100}]}},tasks:[]});
const candidate=(patch={})=>({id:'new',peerId:'peer',kind:'followup',action:'send_text',status:'approved',text:ack,replyAnchor:'h1',...patch});
test('去重忽略网页时间、已读装饰及无意义标点差异，保留实际正文',()=>{
 assert.equal(outgoingText('19:12\n已读\n\n'+ack),outgoingText(ack));
 assert.equal(outgoingText('收到, 我会把具体安排转给主人确认，确认后再回复你!'),outgoingText(ack));
 assert.notEqual(outgoingText('主人想问筛选进度怎么样了？'),outgoingText(ack));
});
test('同HR同来信跨计划/指纹变化也不重复；另一HR与后续新来信可正常回复',()=>{
 const s=base();s.tasks.push(candidate({id:'old',status:'sent',ownerChatPlanId:'plan-a',fingerprint:'old'}));
 assert(duplicateOutgoing(s,candidate({ownerChatPlanId:'plan-b',fingerprint:'changed-by-self'})));
 assert.equal(duplicateOutgoing(s,candidate({peerId:'another'})),null);
 s.memories.peer.history.push({id:'h2',role:'hr',text:'收到，请确认一下',observedAt:200});
 assert.equal(duplicateOutgoing(s,candidate({replyAnchor:'h2'})),null);
});
test('旧版无锚点任务从实际发送前MID找锚点；结果不明不能用新来信洗掉',()=>{
 const s=base();s.tasks.push(candidate({id:'old',replyAnchor:undefined,messageIdsBefore:['h1','self-1'],status:'sent'}));
 assert(duplicateOutgoing(s,candidate()));s.tasks[0].status='uncertain';
 s.memories.peer.history.push({id:'h2',role:'hr',text:'补充问题'});assert(duplicateOutgoing(s,candidate({replyAnchor:'h2'})));
});
test('网页已有相同我方正文时拦截，较早的相同话与其他动作不影响新消息',()=>{
 const s=base();s.memories.peer.history.push({id:'self1',role:'self',text:'已读\n'+ack});
 const blocked=applyOutgoingDedup(s,candidate());assert.equal(blocked.status,'skip');assert.equal(blocked.text,'');assert.equal(blocked.duplicateOf,'self1');
 assert.equal(duplicateOutgoing(s,candidate({action:'send_resume'})),null);
 s.memories.peer.history.push({id:'h2',role:'hr',text:'请确认一下'});assert.equal(duplicateOutgoing(s,candidate({replyAnchor:'h2'})),null);
});
test('自己不与自己重复，已经废弃的草稿不妨碍有效新稿',()=>{
 const s=base(),t=candidate();s.tasks.push(t);assert.equal(duplicateOutgoing(s,t),null);
 s.tasks.push(candidate({id:'old',status:'stale'}));assert.equal(duplicateOutgoing(s,t),null);
});
