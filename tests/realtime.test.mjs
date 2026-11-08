import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../extension/realtime.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({maxBytes=Infinity}={}){
 const values={},writes=[];
 const storage={get:async key=>({[key]:structuredClone(values[key])}),set:async patch=>{
  if(Buffer.byteLength(JSON.stringify(patch['boss-realtime-v1']))>maxBytes)throw Error('fixture storage size exceeded');
  Object.assign(values,structuredClone(patch));writes.push(patch);
 }};
 const context={setTimeout,clearTimeout};vm.runInNewContext(source,context);
 const create=()=>context.BossRealtime.create({storage,now:()=>12345});
 return {create,values,writes,api:context.BossRealtime};
}
const hr=(id,text='新的问题')=>({id,role:'hr',text});
const self=(id,text='已发送')=>({id,role:'self',text});
const row=(key,preview='新消息',patch={})=>({key,preview,time:'10月01日',unread:0,...patch});

test('首次历史列表与正文只建立基线；只读历史重扫不生成待回复事件',async()=>{
 const f=fixture(),inbox=f.create();await inbox.ready;
 inbox.observeSidebar([row('甲','能发简历吗'),row('乙','旧消息',{unread:1})]);
 inbox.observeWindow({key:'甲',peerId:'boss:1',messages:[hr('a','能发简历吗')]});
 inbox.observeWindow({key:'乙',peerId:'boss:2',messages:[hr('b')]});
 for(let i=0;i<10;i++)inbox.observeWindow({key:'甲',messages:[hr('a','能发简历吗')]});
 assert.equal(inbox.events.size,0);await flush();assert(f.writes.length>0);
});

test('首次观察当天有未读标记的会话可以接入，历史日期未读会话不批量补发',async()=>{
 const f=fixture(),inbox=f.create();await inbox.ready;
 inbox.observeSidebar([row('甲','在吗',{time:'09:31',unread:1}),row('乙','旧消息',{time:'10月28日',unread:3}),row('丙','已读',{time:'09:31',outgoing:true})]);
 assert.deepEqual([...inbox.events.keys()],['甲']);
 assert.equal(inbox.matchesPreview('甲',[hr('a','你好，在吗')]),true);
 assert.equal(inbox.matchesPreview('甲',[self('a','我在')]),false);
});

test('没有新内容的周期检查不反复重写持久记忆',async()=>{
 const f=fixture(),inbox=f.create();await inbox.ready;
 const view={key:'甲',peerId:'boss:1',messages:[hr('a')]};
 inbox.observeSidebar([row('甲','旧消息')]);inbox.observeWindow(view);await flush();const count=f.writes.length;
 for(let i=0;i<100;i++){inbox.observeSidebar([row('甲','旧消息')]);inbox.observeWindow(view);}
 await flush();assert.equal(f.writes.length,count);
});

test('侧栏新消息保留至处理结果，清掉未读角标和 busy/hold 不会丢失事件',async()=>{
 const f=fixture(),inbox=f.create();await inbox.ready;
 inbox.observeSidebar([row('甲','昨天的话')]);
 inbox.observeSidebar([row('甲','今天能面试吗？',{time:'15:20',unread:1})]);
 inbox.observeSidebar([row('甲','今天能面试吗？',{time:'15:20',unread:0})]);
 inbox.observeWindow({key:'甲',messages:[hr('a','今天能面试吗？')]});
 assert(inbox.events.has('甲'));
 inbox.acknowledge('甲',{status:'hold'});assert(inbox.events.has('甲'));
 inbox.acknowledge('甲',{status:'sent',messageId:'a'});assert.equal(inbox.events.size,0);
 inbox.observeSidebar([row('甲','今天能面试吗？',{time:'15:20',unread:0})]);
 inbox.observeWindow({key:'甲',messages:[hr('a','今天能面试吗？')]});assert.equal(inbox.events.size,0);
});

test('固定消息编号增量识别相同文本的新消息；我方尾消息不触发补回旧 HR',async()=>{
 const f=fixture(),inbox=f.create();await inbox.ready;
 inbox.observeWindow({key:'甲',messages:[hr('a','好的')]});
 inbox.observeWindow({key:'甲',messages:[hr('a','好的'),hr('b','好的')]});
 assert.equal(inbox.events.get('甲').messageId,'b');
 inbox.acknowledge('甲',{status:'sent'});
 inbox.observeWindow({key:'甲',messages:[hr('a','好的'),hr('b','好的'),self('c')]});
 assert.equal(inbox.events.size,0);
 inbox.observeWindow({key:'甲',messages:[hr('b','好的'),self('c'),hr('d','好的')]});
 assert.equal(inbox.events.get('甲').messageId,'d');
});

test('扩展重载、服务运行代际变更与新模块实例保持游标，待处理消息不会消失或重复派发',async()=>{
 const f=fixture(),first=f.create();await first.ready;
 first.observeWindow({key:'甲',messages:[hr('a')]});
 first.observeWindow({key:'甲',messages:[hr('a'),hr('b')]});
 first.reset('running-1');assert.equal(first.events.size,1);await flush();
 const reloaded=f.create();await reloaded.ready;reloaded.reset('running-2');
 assert.equal(reloaded.events.get('甲').messageId,'b');
 reloaded.acknowledge('甲',{status:'skip'});await flush();
 const again=f.create();await again.ready;again.observeWindow({key:'甲',messages:[hr('a'),hr('b')]});
 assert.equal(again.events.size,0);
 again.observeWindow({key:'甲',messages:[hr('b'),hr('c')]});assert.equal(again.events.get('甲').messageId,'c');
});

test('400 个长会话的旧游标可升级；超过百条待处理事件仍能跨重启恢复',async()=>{
 const f=fixture({maxBytes:700000}),key='boss-realtime-v1';
 const peer=index=>`boss:fixture-${index}`;
 const mid=(index,offset)=>`00000000-0000-4000-8000-${String(index*100+offset).padStart(12,'0')}`;
 const threads=Array.from({length:400},(_,i)=>[peer(i),{peerId:peer(i),tailId:mid(i,79),tailRole:'hr',
  ids:Array.from({length:80},(_,j)=>mid(i,j)),handled:[mid(i,79)],resumeHandled:[],seenAt:i}]);
 f.values[key]={version:1,threads,events:[]};
 assert(Buffer.byteLength(JSON.stringify(f.values[key]))>700000);
 const inbox=f.create();await inbox.ready;
 for(let i=0;i<150;i++)inbox.observeWindow({key:peer(i),peerId:peer(i),messages:[hr(mid(i,79)),hr(mid(i,80))]});
 await flush();
 assert.equal(inbox.error,'');
 assert.equal(f.values[key].threads.length,400);
 assert(!f.values[key].threads.some(([,thread])=>Object.hasOwn(thread,'ids')));
 assert.equal(f.values[key].events.length,150);
 const loaded=f.create();await loaded.ready;
 assert.equal(loaded.events.get(peer(0)).messageId,mid(0,80));
 assert.equal(loaded.events.get(peer(149)).messageId,mid(149,80));
 loaded.acknowledge(peer(0),{status:'sent'});await flush();
 loaded.observeWindow({key:peer(0),peerId:peer(0),messages:[hr(mid(0,79)),hr(mid(0,80))]});
 assert.equal(loaded.events.has(peer(0)),false);
});

test('旧姓名游标只有已绑定的会话编号或唯一预览证据才迁移到新编号',async()=>{
 const f=fixture(),inbox=f.create();await inbox.ready;
 const legacy='同名\u001f同公司',previewAlias='另一位\u001f同公司';
 inbox.observeWindow({key:legacy,peerId:'boss:one',messages:[hr('old'),hr('new')]});
 inbox.observeWindow({key:legacy,peerId:'boss:one',messages:[hr('old'),hr('new'),hr('pending')]});
 inbox.observeSidebar([row(previewAlias,'请问时间',{time:'12:10',unread:1})]);
 inbox.observeSidebar([row('boss:one','新的问题',{legacyKey:legacy,uniqueLabel:true}),row('boss:two','请问时间',{legacyKey:previewAlias,uniqueLabel:true,time:'12:10'})]);
 assert.equal(inbox.events.has(legacy),false);
 assert.equal(inbox.events.get('boss:one').messageId,'pending');
 assert.equal(inbox.matchesPreview('boss:one',[hr('different')]),false);
 assert.equal(inbox.matchesPreview('boss:one',[hr('pending')]),true);
 assert.equal(inbox.events.has(previewAlias),false);
 assert.equal(inbox.events.get('boss:two').peerId,'boss:two');
 inbox.acknowledge('boss:one',{status:'sent'});
 await flush();const loaded=f.create();await loaded.ready;
 assert.equal(loaded.events.has('boss:one'),false);
 loaded.observeWindow({key:'boss:one',peerId:'boss:one',messages:[hr('pending'),hr('fresh')]});
 assert.equal(loaded.events.get('boss:one').messageId,'fresh');
});

test('同名旧预览不分配给任何编号，新的未读分别入队，编号不明的旧标签仍保留',async()=>{
 const f=fixture(),inbox=f.create();await inbox.ready;
 const legacy='同名\u001f同公司';
 inbox.observeWindow({key:legacy,peerId:'boss:one',messages:[hr('bound-mid')]});
 inbox.observeSidebar([row(legacy,'旧来信',{time:'09:32',unread:1})]);
 const contact=(key,preview,options={})=>row(key,preview,{legacyKey:legacy,duplicateLabel:true,...options});
 inbox.observeSidebar([contact('boss:one','旧正文 A'),contact('boss:two','旧来信',{time:'09:32'})]);
 assert.equal(inbox.ambiguous(legacy),true);
 assert.deepEqual([...inbox.events.keys()],[legacy]);
 assert.equal(inbox.snapshot().threads.find(([key])=>key==='boss:one')[1].tailId,'bound-mid','旧游标有会话编号时只继承该会话的正文锚点');
 inbox.observeSidebar([contact('boss:one','现在的正文 A',{time:'12:01',unread:1}),contact('boss:two','现在的正文 B',{time:'12:02',unread:1})]);
 assert.equal(inbox.events.get('boss:one').preview,'现在的正文 A');
 assert.equal(inbox.events.get('boss:two').preview,'现在的正文 B');
 inbox.acknowledge('boss:one',{status:'sent'});
 assert.equal(inbox.events.has('boss:two'),true);
 await flush();const loaded=f.create();await loaded.ready;
 assert.equal(loaded.ambiguous(legacy),true);
});

test('正文历史加载没有尾编号交集时保守建立基线，不把整页旧 HR 当新消息',async()=>{
 const f=fixture(),inbox=f.create();await inbox.ready;
 inbox.observeWindow({key:'甲',messages:[hr('recent')]});
 inbox.observeWindow({key:'甲',messages:Array.from({length:100},(_,i)=>hr('old-'+i))});
 assert.equal(inbox.events.size,0);
});

test('简历请求卡可在我方尾消息后排队，接受成功后同一请求卡不会反复执行',async()=>{
 const f=fixture(),inbox=f.create();await inbox.ready;
 const view={key:'甲',peerId:'boss:1',messages:[hr('a'),self('b')],resumeUI:{requestPending:true,agreeEnabled:true,requestMessageId:'request-1'}};
 inbox.observeWindow(view);assert.equal(inbox.events.get('甲').kind,'resume_request');
 assert.equal(inbox.matchesPreview('甲',view.messages),true);
 inbox.observeSidebar([row('甲','其他消息',{time:'15:30',unread:1})]);
 assert.equal(inbox.events.get('甲').kind,'resume_request');
 inbox.acknowledge('甲',{status:'hold'});assert.equal(inbox.events.size,1);
 inbox.acknowledge('甲',{status:'sent'});inbox.observeWindow(view);assert.equal(inbox.events.size,0);
 inbox.observeWindow({...view,resumeUI:{...view.resumeUI,requestMessageId:'request-2'}});assert.equal(inbox.events.size,1);
});

test('已有附件回执时旧索要卡不触发回复，之后的普通 HR 新消息仍触发',async()=>{
 const f=fixture(),inbox=f.create();await inbox.ready;
 const request=hr('old-request','请发送附件简历');
 const view={key:'甲',peerId:'boss:1',messages:[request],resumeUI:{requestPending:true,agreeEnabled:true,requestMessageId:request.id,receipts:[{source:'chat_notice'}]}};
 inbox.observeWindow(view);assert.equal(inbox.events.size,0);
 inbox.observeWindow({...view,messages:[request,hr('new-question','您什么时候可以面试？')]});
 assert.equal(inbox.events.get('甲').kind,'message');assert.equal(inbox.events.get('甲').messageId,'new-question');
});

test('平台竞争 PK 提示不作为 HR 提问；真实 HR 新消息仍能进入事件队列',async()=>{
 const f=fixture(),inbox=f.create();await inbox.ready;
 inbox.observeSidebar([row('甲','竞争者 PK 情况，点击查看详细分析',{time:'15:20',unread:1})]);assert.equal(inbox.events.size,0);
 inbox.observeWindow({key:'乙',messages:[hr('a')]});
 inbox.observeWindow({key:'乙',messages:[hr('a'),hr('b','您已超过竞争者，查看详细分析')]});assert.equal(inbox.events.size,0);
 inbox.observeWindow({key:'乙',messages:[hr('b','您已超过竞争者，查看详细分析'),hr('c','你会用 Unity 吗？')]});
 assert.equal(inbox.events.get('乙').messageId,'c');
 assert.equal(inbox.isSystemNotice('你觉得这个竞争者的 PK 情况该如何分析？'),false);
 assert.equal(inbox.isSystemNotice('请你查看详细分析，比较下我们的竞争者'),false);
});

test('持久化写入失败保留内存队列并给出诊断；重新观察后可恢复写入',async()=>{
 const f=fixture();let fail=true;const inbox=f.api.create({storage:{get:async()=>({}),set:async()=>{if(fail)throw Error('磁盘繁忙');}}});await inbox.ready;
 inbox.observeSidebar([row('甲','新消息',{time:'16:00',unread:1})]);await flush();assert.equal(inbox.events.size,1);assert.match(inbox.error,/磁盘繁忙/);
 fail=false;inbox.reset('next');inbox.observeSidebar([row('甲','新消息',{time:'16:00',unread:0})]);await flush();assert.equal(inbox.error,'');
});

test('持续 DOM 变动只按首个变动设一次唤醒，执行期间最多追加一轮',async()=>{
 const f=fixture(),timers=new Map();let next=0,calls=0,release;
 const scheduler=f.api.createWakeScheduler(()=>{calls++;return new Promise(resolve=>release=resolve);},{delayMs:350,setTimer:(fn,ms)=>{timers.set(++next,{fn,ms});return next;},clearTimer:id=>timers.delete(id)});
 for(let i=0;i<200;i++)scheduler.wake();assert.equal(timers.size,1);assert.equal(timers.get(1).ms,350);
 const first=timers.get(1).fn();timers.delete(1);for(let i=0;i<200;i++)scheduler.wake();assert.equal(calls,1);assert.equal(timers.size,0);
 release();await first;assert.equal(timers.size,1);const second=timers.get(2).fn();timers.delete(2);release();await second;
 assert.equal(calls,2);assert.equal(scheduler.pending,false);
 scheduler.wake();scheduler.dispose();assert.equal(timers.size,0);scheduler.wake();assert.equal(timers.size,0);
});

test('一次唤醒异常后可继续接收后续消息，不留下运行锁或未处理拒绝',async()=>{
 const f=fixture(),timers=[];let calls=0;const errors=[];
 const scheduler=f.api.createWakeScheduler(async()=>{if(++calls===1)throw Error('暂时离线');},{setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer(){},onError:e=>errors.push(e.message)});
 scheduler.wake();await timers.shift()();assert.deepEqual(errors,['暂时离线']);assert.equal(scheduler.pending,false);
 scheduler.wake();await timers.shift()();assert.equal(calls,2);
});
