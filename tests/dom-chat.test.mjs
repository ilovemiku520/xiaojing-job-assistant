import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveDomConversation,importDomHistory} from '../server/dom-chat.mjs';
import {observeConversation,memoryContext} from '../server/memory.mjs';
const input=(ids=['m1','m2'])=>({name:'周女士',company:'测试游戏',header:'周女士 测试游戏 HR',uniquePeer:true,messages:ids.map(id=>({id,role:'hr',text:'测试消息'+id}))});
test('本地会话按重叠消息锚点关联，同名同公司但无重叠时不合并',()=>{
 const memories={},first=resolveDomConversation(memories,input());observeConversation(memories,{peerId:first.peerId,...input()});memories[first.peerId].domIdentity=first.identity;
 assert.equal(resolveDomConversation(memories,input(['m2','m3'])).peerId,first.peerId);
 assert.notEqual(resolveDomConversation(memories,input(['unrelated'])).peerId,first.peerId);
 assert.equal(first.identity.platformPeerIdKnown,false);
 assert.throws(()=>resolveDomConversation(memories,{...input(),uniquePeer:false}));
 assert.doesNotThrow(()=>resolveDomConversation({}, {...input(),company:'某某游戏科技...',header:'周女士 某某游戏科技有限公司 HR'}));
});
test('历史按重叠位置插入，导入旧对话不覆盖当前消息窗口或指纹',()=>{
 const memories={},c=observeConversation(memories,{peerId:'test',messages:input(['m3','m4']).messages}).conversation,fingerprint=c.fingerprint,window=c.window;
 assert.equal(importDomHistory(c,{messages:input(['m1','m2','m3']).messages,reachedStart:false}),2);
 assert.deepEqual(c.history.map(m=>m.id),['m1','m2','m3','m4']);assert.equal(c.window,window);assert.equal(c.fingerprint,fingerprint);assert.equal(c.historyCoverage.complete,false);
 assert.equal(importDomHistory(c,{messages:input(['m1','m2','m3']).messages}),0);
});
test('当前问题可检索同一HR较早的项目对话，不把历史当成新消息',()=>{
 const memories={},c=observeConversation(memories,{peerId:'test',messages:[{id:'project',role:'hr',text:'我们重点想看卡牌经济和双币结算设计'}]}).conversation;
 for(let i=0;i<70;i++)observeConversation(memories,{peerId:'test',messages:[{id:'later'+i,role:'self',text:'其他沟通记录'+i}]});
 const context=memoryContext(c,'上次提到的卡牌经济和双币结算，还想了解哪些细节？');assert(context.related_older_history.some(m=>m.id==='project'));assert(!context.observed_history.some(m=>m.id==='project'));
});
