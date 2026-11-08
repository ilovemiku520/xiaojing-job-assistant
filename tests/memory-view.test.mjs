import assert from 'node:assert/strict';
import test from 'node:test';
import {memoryConversation,memorySummaries} from '../server/memory-view.mjs';
import {importDomHistory} from '../server/dom-chat.mjs';
import {observeConversation} from '../server/memory.mjs';

test('桌面摘要排除正文，按会话分页保留作者证据，普通浏览不改变内容版本',()=>{
  const peerId='fixture-peer';
  const history=Array.from({length:61},(_,index)=>({id:String(index),role:'self',text:`测试消息 ${index}`,previousVersions:[{text:'旧版本'}]}));
  const c={peerId,header:'测试 HR',lastSeenAt:1,revision:1,history,job:{title:'示例岗位',description:'私有测试正文'},sends:[]};
  const summary=()=>memorySummaries({[peerId]:c})[peerId];
  const start=summary();
  assert.equal(start.historyCount,61);
  assert.equal(Object.hasOwn(start,'history'),false);
  assert.equal(Object.hasOwn(start.job,'description'),false);
  c.lastSeenAt=2;
  assert.equal(summary().version,start.version);
  const latest=memoryConversation(c);
  assert.equal(latest.offset,31);
  assert.equal(latest.total,61);
  assert.equal(latest.history[0].id,'31');
  assert.equal(latest.history[0].author.kind,'account_self_unknown');
  assert.equal(Object.hasOwn(latest.history[0],'previousVersions'),false);
  const earlier=memoryConversation(c,'31');
  assert.equal(earlier.history.at(-1).id,'30');
  assert.equal(earlier.offset,1);
  assert.throws(()=>memoryConversation(c,'-1'),/历史位置无效/);
  c.authorConfirmations={31:{kind:'owner_confirmed',source:'authenticated_owner',text:'测试消息 31'}};
  c.revision++;
  assert.notEqual(summary().version,start.version);
  assert.equal(memoryConversation(c).history[0].author.kind,'owner_confirmed');
});

test('补录原子地更新完整或精确锚定的已展开范围，正常追加只返回最近一页',()=>{
  const row=index=>({id:String(index),eventId:`event-${index}`,role:'hr',text:`模拟消息 ${index}`});
  const c={peerId:'fixture-range',history:Array.from({length:70},(_,i)=>row(i)),revision:1,sends:[]};
  const initial=memoryConversation(c),through='event:event-69';
  const partial={from:'event:event-10',through,rangeRevision:initial.rangeRevision};
  c.history.push(row(70));c.revision++;
  const appended=memoryConversation(c,null,partial);
  assert.equal(appended.history.length,30);
  assert.equal(appended.rangeReplaced,undefined);

  importDomHistory(c,{messages:[row(-1),{...row(0),text:'修正后的内容'},row(10),row(101),row(11)]});
  const full=memoryConversation(c,null,{...partial,from:'~all'});
  assert.equal(full.offset,0);
  assert.equal(full.rangeReplaced,true);
  assert.equal(full.history[0].id,'-1');
  assert.equal(full.history[1].text,'修正后的内容');
  const anchored=memoryConversation(c,null,partial);
  assert.equal(anchored.offset,11);
  assert.equal(anchored.latestOffset,43);
  assert.deepEqual(anchored.history.slice(0,3).map(m=>m.id),['10','101','11']);

  const refreshedRevision=anchored.rangeRevision;
  observeConversation({[c.peerId]:c},{peerId:c.peerId,messages:[{...row(10),text:'重新观察到的内容'}]});
  const observed=memoryConversation(c,null,{...partial,rangeRevision:refreshedRevision});
  assert.equal(observed.rangeReplaced,true);
  assert.equal(observed.history[0].text,'重新观察到的内容');
});

test('历史锚点淘汰或重复时安全回退，展开范围最多一千条',()=>{
  const history=Array.from({length:1005},(_,i)=>({id:`m-${i}`,role:'hr',text:String(i)}));
  const c={peerId:'fixture-retention',history,revision:1,sends:[]};
  const expanded=memoryConversation(c,null,{from:'~all'});
  assert.equal(expanded.history.length,1000);
  assert.equal(expanded.offset,5);
  assert.equal(expanded.history[0].id,'m-5');
  for(const from of ['message:m-2','message:evicted','event:m-7']){
    const fallback=memoryConversation(c,null,{from,through:'message:m-1004',rangeRevision:expanded.rangeRevision});
    assert.equal(fallback.rangeReplaced,true);
    assert.equal(fallback.offset,975);
    assert.equal(fallback.history.length,30);
  }
  const gapped=memoryConversation(c,null,{from:'message:m-12',through:'message:m-60',rangeRevision:expanded.rangeRevision});
  assert.equal(gapped.rangeReplaced,true);
  assert.equal(gapped.offset,12);
  c.history[13].id='m-12';
  assert.equal(memoryConversation(c,null,{from:'message:m-12'}).offset,975);
  assert.throws(()=>memoryConversation(c,'20',{from:'~all'}),/历史消息锚点无效/);
});
