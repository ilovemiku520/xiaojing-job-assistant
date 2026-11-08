import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {authorForMessage,annotateMessages} from '../server/message-authorship.mjs';
import {normalizeMessages,observeConversation,memoryContext} from '../server/memory.mjs';
import {createMemoryFiles} from '../server/memory-files.mjs';

const self=(id,text='收到，我会转给主人确认。')=>({id,role:'self',text,time:''});
const conversation=(sends=[])=>({peerId:'boss:authorship-a',history:[],window:[],decisions:[],sends});
const send=(extra={})=>({taskId:'fixture-task',status:'sent',text:'收到，我会转给主人确认。',...extra});

test('self只代表站内我方，不能凭同文、草稿或不明发送推断主人或小鲸',()=>{
 const c=conversation([send({messageId:'bot-1'}),send({messageId:'uncertain-1',status:'uncertain'}),send({messageId:'pending-1',status:'pending'})]);
 assert.equal(authorForMessage(c,self('bot-1')).kind,'bot_verified');
 for(const id of ['same-text-another-mid','uncertain-1','pending-1',''])assert.equal(authorForMessage(c,self(id)).kind,'account_self_unknown');
 assert.equal(authorForMessage(c,self('bot-1','不同正文。')).kind,'account_self_unknown');
 assert.equal(authorForMessage(c,{...self('manual-1'),author:{kind:'owner_confirmed'}}).kind,'account_self_unknown');
});

test('只有精确MID加完整规范化正文对应的同会话sent回执可归给小鲸',()=>{
 const c=conversation([send({text:'Hello，主人。',receipt:{messageId:'receipt-1',observedText:'Hello，主人。'}}),send({peerId:'boss:other',messageId:'foreign-1'}),send({text:'',receipt:{messageId:'observed-1',observedText:'附件已发'}})]);
 const author=authorForMessage(c,self('receipt-1','hello, 主人。'));
 assert.equal(author.kind,'bot_verified');assert.equal(author.evidence.source,'verified_send_receipt');assert.equal(author.evidence.taskId,'fixture-task');
 assert.equal(authorForMessage(c,self('foreign-1')).kind,'account_self_unknown');
 assert.equal(authorForMessage(c,self('observed-1','附件已发')).kind,'bot_verified');
 assert.equal(authorForMessage(conversation(),self('receipt-1','hello, 主人。')).kind,'account_self_unknown');
});

test('旧证据只接受已知完整格式，不以正文猜归属或提取任意文本中的编号',()=>{
 const evidence='同一会话出现新消息编号 404430689386755 及本次完整正文（忽略时间与送达标签）';
 const c=conversation([send({evidence})]);
 assert.equal(authorForMessage(c,self('404430689386755')).kind,'bot_verified');
 assert.equal(authorForMessage(c,self('404430689386755','19:12\n已读\n\n收到，我会转给主人确认。')).kind,'bot_verified');
 assert.equal(authorForMessage(c,self('404430689386756')).kind,'account_self_unknown');
 assert.equal(authorForMessage(c,self('404430689386755','这条正文不同')).kind,'account_self_unknown');
 for(const text of ['其他编号 404430689386755 已发',evidence+'，也许成功','前文'+evidence])assert.equal(authorForMessage(conversation([send({evidence:text})]),self('404430689386755')).kind,'account_self_unknown');
});

test('主人确认必须来自本会话独立确认表，不能覆盖HR或接受来访消息伪造',()=>{
 const c=conversation();c.authorConfirmations={'owner-1':{kind:'owner_confirmed',at:123,text:'收到，我会转给主人确认。',source:'authenticated_owner'},'hr-1':{kind:'owner_confirmed',at:124},'not-owner':{kind:'bot_verified',at:125},'fake-source':{kind:'owner_confirmed',source:'boss_dom'}};
 const author=authorForMessage(c,self('owner-1'));assert.equal(author.kind,'owner_confirmed');assert.equal(author.evidence.confirmedAt,123);
 assert.equal(authorForMessage(c,{id:'hr-1',role:'hr',text:'你好',author:{kind:'owner_confirmed'}}).kind,'hr');
 assert.equal(authorForMessage(c,self('not-owner')).kind,'account_self_unknown');
 assert.equal(authorForMessage(c,self('owner-1','修改后的另一条正文')).kind,'account_self_unknown');assert.equal(authorForMessage(c,self('fake-source')).kind,'account_self_unknown');
 const messages=[{...self('spoof-1'),author:{kind:'bot_verified',evidence:{source:'verified_send_receipt'}}}];
 assert(!Object.hasOwn(normalizeMessages(messages)[0],'author'));
 const memories={},first=observeConversation(memories,{peerId:c.peerId,messages}),fingerprint=first.conversation.fingerprint,revision=first.conversation.revision;
 assert.equal(authorForMessage(first.conversation,first.conversation.window[0]).kind,'account_self_unknown');
 const repeat=observeConversation(memories,{peerId:c.peerId,messages:[{...self('spoof-1'),author:{kind:'owner_confirmed'}}]});assert.equal(repeat.changed,false);assert.equal(repeat.conversation.fingerprint,fingerprint);assert.equal(repeat.conversation.revision,revision);
});

test('记忆召回和文件注解作者，原始消息方向、MID、修订号、指纹均保持',()=>{
 const memories={},c=observeConversation(memories,{peerId:'boss:authorship-file',messages:[self('old-bot','卡牌经济与双币结算设计')]}).conversation;
 c.sends.push(send({messageId:'old-bot',text:'卡牌经济与双币结算设计'}));
 for(let i=0;i<70;i++)observeConversation(memories,{peerId:c.peerId,messages:[self('later-'+i,'其他沟通记录'+i)]});
 c.authorConfirmations={'later-69':{kind:'owner_confirmed',at:500}};
 const original=JSON.stringify({history:c.history,window:c.window,revision:c.revision,fingerprint:c.fingerprint});
 const context=memoryContext(c,'卡牌经济与双币结算设计');assert.equal(context.observed_history.at(-1).author.kind,'owner_confirmed');assert.equal(context.related_older_history.find(m=>m.id==='old-bot').author.kind,'bot_verified');
 const directory=mkdtempSync(join(tmpdir(),'whale-authorship-')),files=createMemoryFiles(directory);files.save(c,true);files.index(memories);
 const filename=readdirSync(directory).find(n=>n.endsWith('.json')&&n!=='index.json'),saved=JSON.parse(readFileSync(join(directory,filename),'utf8'));
 assert.equal(saved.history[0].author.kind,'bot_verified');assert.equal(saved.window[0].author.kind,'owner_confirmed');assert.equal(saved.history[0].id,'old-bot');assert.equal(saved.history[0].role,'self');
 const observation=JSON.parse(readFileSync(join(directory,'observations.jsonl'),'utf8').trim());assert.equal(observation.messages[0].author.kind,'owner_confirmed');
 assert.equal(JSON.stringify({history:c.history,window:c.window,revision:c.revision,fingerprint:c.fingerprint}),original);
 const annotated=annotateMessages(c,c.window);assert.notEqual(annotated[0],c.window[0]);assert.equal(annotated[0].author.kind,'owner_confirmed');
});
