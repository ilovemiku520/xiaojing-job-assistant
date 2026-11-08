import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const savedURL='https://www.zhipin.com/web/geek/fixture-saved-jobs';
async function fixture({favorites={},search,task=null,initialSession={},existing=[],probe}={}){
 let now=2000000;const session={...initialSession},local={},tabs=[...existing],calls=[],pokes=[],updates=[],removed=[];
 const state={running:true,search,config:{autoBrowse:true,chatRead:true,crawlEnabled:true}},fav={enabled:true,due:true,status:'queued',lastScanAt:0,nextScanAt:0,navigation:{url:savedURL,label:'我的收藏',sourcePage:'https://www.zhipin.com/web/geek/job'},...favorites};
 class Clock extends Date{static now(){return now;}}
 const chrome={runtime:{id:'fixture',getManifest:()=>({version:'0.10.0'}),onMessage:{addListener(){}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},storage:{local:{get:async()=>({token:'fixture'}),set:async values=>Object.assign(local,values)},session:{get:async key=>({[key]:session[key]}),set:async values=>Object.assign(session,values),remove:async key=>delete session[key]}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{query:async()=>tabs,create:async values=>{const tab={id:Math.max(0,...tabs.map(t=>t.id))+1,...values};tabs.push(tab);return tab;},get:async id=>tabs.find(t=>t.id===id),update:async(id,values)=>{updates.push({id,values});return Object.assign(tabs.find(t=>t.id===id),values);},remove:async id=>{removed.push(id);const index=tabs.findIndex(t=>t.id===id);if(index>=0)tabs.splice(index,1);},sendMessage:async(id,message)=>{pokes.push({id,message});return probe?await probe(id,message,fav):{ok:true};},onRemoved:{addListener(){}}}};
 const fetch=async(url,options)=>{const path=new URL(url).pathname,data=options.body?JSON.parse(options.body):undefined;calls.push({path,data});let result={};if(path==='/api/browser-state')result={...state,favorites:fav};else if(path==='/api/favorites/state')result=fav;else if(path==='/api/work')result={task};else if(path==='/api/crawl/next')result={job:null};else if(path==='/api/check')result={allowed:true};else if(path==='/api/favorites/fail'){fav.due=false;fav.status='unavailable';fav.nextScanAt=data.retryAt;}return {ok:true,json:async()=>result};};
 const context={chrome,fetch,URL,AbortSignal,Date:Clock,console,setTimeout:(fn,delay)=>delay===2500?0:setTimeout(fn,delay),clearTimeout,setInterval:()=>0};vm.runInNewContext(readFileSync(new URL('../extension/background.js',import.meta.url),'utf8'),context);
 return {run:()=>context.work(),session,local,tabs,calls,pokes,updates,removed,state,fav,advance:ms=>now+=ms};
}
const basicTabs=()=>[{id:1,url:'https://www.zhipin.com/web/geek/chat',active:false},{id:2,url:'https://www.zhipin.com/web/geek/job',active:true}];
test('已确认收藏页保持原样，自动搜索使用独立列表页',async()=>{
 const source='https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=1&tag=4',search={id:'separate-search',url:'https://www.zhipin.com/web/geek/job?query=intern'};
 const f=await fixture({existing:[{id:1,url:'https://www.zhipin.com/web/geek/chat'},{id:2,url:source,active:true}],search,favorites:{due:false,status:'observed'}});
 f.state.config.selectors={favoriteCollectionURL:source};await f.run();assert.equal(f.tabs.find(t=>t.id===2).url,source);assert(!f.updates.some(u=>u.id===2));assert(f.tabs.some(t=>t.url===search.url));
});
test('收藏由实际入口先于新搜索打开一次；observed/empty时间回执结束自有扫描页，不等45秒',async()=>{
 for(const status of ['observed','empty']){
  const search={id:'new-search',url:'https://www.zhipin.com/web/geek/job?query=new'},f=await fixture({existing:basicTabs(),search});
  await f.run();const worker=f.session.favoritesWorker;assert(worker);assert.equal(f.tabs.filter(t=>t.url===savedURL).length,1);assert.equal(f.updates.length,0);assert.equal(worker.owned,true);assert.equal(f.tabs.at(-1).active,false);
  await f.run();assert.equal(f.tabs.filter(t=>t.url===savedURL).length,1);assert.equal(f.updates.length,0);assert(f.pokes.some(p=>p.id===worker.tabId&&p.message.command==='favorites-scan'));
  f.fav.due=false;f.fav.status=status;f.fav.lastScanAt=worker.at+1;await f.run();assert.equal(f.session.favoritesWorker,undefined);assert(f.removed.includes(worker.tabId));assert.equal(f.local.favoriteScan.status,status);assert.equal(f.updates.length,0);assert.equal(f.tabs.find(t=>t.id===2).url,basicTabs()[1].url);assert(f.tabs.some(t=>t.url===search.url&&t.active===false));
 }
});
test('已就绪招呼先发，近期HR新消息让收藏延后，均不抢聊天焦点',async()=>{
 const task={id:'greet-first',job:{url:'https://www.zhipin.com/job_detail/fixture-first.html'}},first=await fixture({existing:basicTabs(),task});await first.run();assert.equal(first.session.worker.taskId,task.id);assert(!first.calls.some(c=>c.path==='/api/favorites/state'));assert(first.pokes.some(p=>p.id===1));assert.equal(first.updates.length,0);
 const incoming=await fixture({existing:basicTabs(),initialSession:{lastIncomingHint:{at:2000000,pending:1}}});await incoming.run();assert.equal(incoming.session.favoritesWorker,undefined);assert(!incoming.pokes.some(p=>p.message.command==='favorites-scan'));assert(incoming.pokes.some(p=>p.id===1));assert.equal(incoming.updates.length,0);
});
test('已claim招呼等待时仍可只读发现收藏，保留原发送凭据且绝不扫描发送源页或聊天页',async()=>{
 const job={url:'https://www.zhipin.com/job_detail/fixture-wait.html',company:'测试游戏'},task={id:'waiting-send',kind:'greeting',job},worker={tabId:3,sourceTabId:4,taskId:task.id,job,at:1990000,claimed:{id:task.id,lease:'original-lease',task}};
 const f=await fixture({initialSession:{worker},existing:[...basicTabs(),{id:3,url:job.url},{id:4,url:'https://www.zhipin.com/web/geek/job?source=protected'}],favorites:{navigation:null},probe:async(id,message,fav)=>{if(message.command==='favorites-scan'){assert.equal(id,2);assert.equal(message.allowNavigate,false);fav.navigation={url:savedURL,label:'我的收藏',sourcePage:'https://www.zhipin.com/web/geek/job'};}return {ok:true};}});
 await f.run();assert.equal(f.session.worker.claimed.lease,'original-lease');assert.equal(f.session.worker.tabId,3);assert(f.session.favoritesWorker);assert(f.pokes.some(p=>p.id===2&&p.message.command==='favorites-scan'));assert(!f.pokes.some(p=>[1,3,4].includes(p.id)&&p.message.command==='favorites-scan'));assert(!f.calls.some(c=>['/api/claim','/api/work','/api/crawl/next'].includes(c.path)));assert.equal(f.updates.length,0);
});
test('没有入口明确归档失败并继续搜索，五分钟内不重复检查导航',async()=>{
 const search={id:'fallback',url:'https://www.zhipin.com/web/geek/job?query=fallback'},f=await fixture({existing:basicTabs(),search,favorites:{navigation:null}});await f.run();const probes=f.pokes.filter(p=>p.message.command==='favorites-scan');assert.equal(probes.length,1);assert.equal(probes[0].message.allowNavigate,false);assert.equal(f.fav.status,'unavailable');assert.match(f.local.favoriteScan.reason,/不会猜测/);assert.equal(f.tabs.find(t=>t.id===2).url,basicTabs()[1].url);assert(f.tabs.some(t=>t.url===search.url&&t.active===false));await f.run();assert.equal(f.pokes.filter(p=>p.message.command==='favorites-scan').length,1);assert.equal(f.calls.filter(c=>c.path==='/api/favorites/fail').length,1);assert.equal(f.updates.length,0);
});
test('收藏扫描超时归档且不刷新；完成时用户已激活的自有收藏页保持打开',async()=>{
 const f=await fixture({existing:basicTabs()});await f.run();const worker=f.session.favoritesWorker;f.advance(46000);await f.run();assert.equal(f.session.favoritesWorker,undefined);assert.equal(f.calls.find(c=>c.path==='/api/favorites/fail').data.phase,'scan');assert.equal(f.updates.length,0);assert(f.removed.includes(worker.tabId));
 const active=await fixture({existing:basicTabs()});await active.run();const owned=active.session.favoritesWorker;active.tabs.find(t=>t.id===owned.tabId).active=true;active.fav.due=false;active.fav.status='observed';active.fav.lastScanAt=owned.at+1;await active.run();assert.equal(active.session.favoritesWorker,undefined);assert(!active.removed.includes(owned.tabId));
});
test('入口探测遇真人操作只延后15秒，不误报无入口或占用五分钟重试，其他任务先走',async()=>{
 let scanCount=0;const search={id:'human-fallback',url:'https://www.zhipin.com/web/geek/job?query=next'};
 const f=await fixture({existing:basicTabs(),search,favorites:{navigation:null},probe:async(id,message,fav)=>{
  if(message.command!=='favorites-scan')return {ok:true};scanCount++;
  if(scanCount===1)return {deferred:'human_active',reason:'主人15秒内正在操作，收藏导航暂不点击'};
  fav.navigation={url:savedURL,label:'我的收藏',sourcePage:'https://www.zhipin.com/web/geek/job'};return {reason:'发现主人确认的收藏导航'};
 }});
 await f.run();assert.equal(f.local.favoriteScan.status,'deferred');assert.match(f.session.favoriteDiscovery.lastReason,/主人15秒/);assert.equal(f.session.favoriteDiscovery.retryAt,2015000);assert.equal(f.fav.status,'queued');assert(!f.calls.some(c=>c.path==='/api/favorites/fail'));assert.equal(f.tabs.find(t=>t.id===2).url,basicTabs()[1].url);assert(f.tabs.some(t=>t.url===search.url&&t.active===false),'deferred scan does not prevent an inactive search');
 f.advance(14999);await f.run();assert.equal(scanCount,1);assert(!f.calls.some(c=>c.path==='/api/favorites/fail'));
 f.advance(1);await f.run();assert(f.session.favoritesWorker);assert(scanCount>=2);assert(!f.calls.some(c=>c.path==='/api/favorites/fail'));assert.equal(f.updates.length,0);
});

test('实际页面扫描原因保存进favoritesWorker，45秒超时在原句后附具体结构原因',async()=>{
 const reason='收藏页面来源已确认，但同源iframe中未找到职位卡片：frames=2，cards=0';
 const f=await fixture({existing:basicTabs(),probe:async(id,message)=>message.command==='favorites-scan'?{reason}:{ok:true}});await f.run();await new Promise(r=>setImmediate(r));
 assert.equal(f.session.favoritesWorker.lastReason,reason);assert.equal(f.session.favoritesWorker.lastProbeAt,2000000);assert.equal(f.local.favoriteScan.reason,reason);
 f.advance(46000);await f.run();const failure=f.calls.find(c=>c.path==='/api/favorites/fail');assert.match(failure.data.reason,/收藏页面45秒内未确认列表，不刷新重开/);assert(failure.data.reason.includes(reason));assert.equal(f.local.favoriteScan.status,'unavailable');assert(f.local.favoriteScan.reason.includes(reason));
});

test('已打开收藏遇真人操作期间释放调度，延后时间不算进45秒扫描超时',async()=>{
 let scans=0;const worker={tabId:3,url:savedURL,at:1956000,owned:false};
 const f=await fixture({initialSession:{favoritesWorker:worker},existing:[...basicTabs(),{id:3,url:savedURL,active:true}],probe:async(id,message)=>{
  if(message.command!=='favorites-scan')return {ok:true};scans++;return scans===1?{deferred:'human_active',reason:'主人正在当前收藏页操作，15秒后再试'}:{reason:'同源页面已遍历，仍未识别收藏卡片容器'};
 }});
 await f.run();assert.equal(scans,1);assert.equal(f.session.favoritesWorker.retryAt,2015000);assert.equal(f.local.favoriteScan.status,'deferred');assert(f.calls.some(c=>c.path==='/api/crawl/next'));assert(!f.calls.some(c=>c.path==='/api/favorites/fail'));
 f.advance(14999);await f.run();assert.equal(scans,1);assert(!f.calls.some(c=>c.path==='/api/favorites/fail'));
 f.advance(1);await f.run();assert.equal(scans,2);assert.equal(f.session.favoritesWorker.deferredMs,15000);assert.equal(f.session.favoritesWorker.deferredAt,undefined);assert.match(f.session.favoritesWorker.lastReason,/同源页面已遍历/);assert(!f.calls.some(c=>c.path==='/api/favorites/fail'));
 f.advance(2000);await f.run();assert.match(f.calls.find(c=>c.path==='/api/favorites/fail').data.reason,/同源页面已遍历/);assert.equal(f.session.favoritesWorker,undefined);assert(!f.removed.includes(3),'human-active collection tab stays open');
});

test('扫描异常保留具体error，旧worker没有probe结果时仍使用原超时fallback',async()=>{
 const errored=await fixture({existing:basicTabs(),probe:async(id,message)=>{if(message.command==='favorites-scan')throw Error('内容脚本未连接：frame fixture');return {ok:true};}});await errored.run();await new Promise(r=>setImmediate(r));assert.match(errored.session.favoritesWorker.lastReason,/内容脚本未连接/);errored.advance(46000);await errored.run();assert.match(errored.calls.find(c=>c.path==='/api/favorites/fail').data.reason,/内容脚本未连接/);
 const old=await fixture({initialSession:{favoritesWorker:{tabId:3,url:savedURL,at:1950000,owned:false}},existing:[...basicTabs(),{id:3,url:savedURL}]});await old.run();assert.equal(old.calls.find(c=>c.path==='/api/favorites/fail').data.reason,'收藏页面45秒内未确认列表，不刷新重开');
});
