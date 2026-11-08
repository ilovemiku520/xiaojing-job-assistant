import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
async function backgroundFixture({existing=[],initialSession={},response=()=>({}),fault}={}){
 const session={...initialSession},tabs=[...existing],calls=[],pokes=[],updates=[],removed=[];let startup,listener,onRemoved;
 const chrome={runtime:{id:'fixture',getManifest:()=>({version:'0.9.0'}),onMessage:{addListener(fn){listener=fn;}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},storage:{local:{get:async()=>({token:'fixture'}),set:async()=>{}},session:{get:async key=>({[key]:session[key]}),set:async v=>Object.assign(session,v),remove:async key=>delete session[key]}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{query:async()=>tabs,create:async v=>{if(fault)throw Error(fault);const tab={id:Math.max(0,...tabs.map(t=>t.id))+1,...v};tabs.push(tab);return tab;},get:async id=>tabs.find(t=>t.id===id),update:async(id,patch)=>{updates.push({id,patch});return Object.assign(tabs.find(t=>t.id===id),patch);},remove:async id=>removed.push(id),sendMessage:async(id,m)=>{pokes.push({id,m});return {ok:true};},onRemoved:{addListener(fn){onRemoved=fn;}}}};
 const fetch=async(url,opts)=>{const path=new URL(url).pathname,data=opts.body&&JSON.parse(opts.body);calls.push({path,data});const value=await response(path,data)||{};return {ok:!value.__http||value.__http<400,json:async()=>value};};vm.runInNewContext(readFileSync(new URL('../extension/background.js',import.meta.url),'utf8'),{chrome,fetch,URL,AbortSignal,setTimeout:fn=>startup=fn,Date,console});
 const message=(m,tabId,url)=>new Promise(resolve=>{if(listener(m,{id:'fixture',tab:{id:tabId},url},resolve)!==true)resolve({ok:false});});
 return {run:()=>startup(),session,tabs,calls,pokes,updates,removed,message,close:id=>onRemoved(id)};
}
test('推荐页被复用，不反复创建岗位标签；调度异常回传具体阶段',async()=>{
 const response=p=>p==='/api/browser-state'?{running:true,config:{autoBrowse:true,chatRead:false,crawlEnabled:true}}:{job:null,task:null};const f=await backgroundFixture({existing:[{id:1,url:'https://www.zhipin.com/web/geek/recommend'}],response});await f.run();await f.run();assert.equal(f.tabs.length,1);assert(f.calls.some(c=>c.path==='/api/worker-health'&&!c.data.error));
 const broken=await backgroundFixture({response,fault:'模拟浏览器拒绝打开'});await broken.run();assert.match(broken.calls.find(c=>c.path==='/api/worker-health').data.error,/拒绝打开/);
});
test('账号证据由后台绑定当前顶层标签；查询参数和伪造活动状态不进入服务',async()=>{
 const url='https://www.zhipin.com/web/geek/chat?peer=private-fixture';
 const f=await backgroundFixture({existing:[{id:3,url,active:false}]});
 const data={page:'https://www.zhipin.com/web/user/',accountSignal:'chat-workspace',accountForeground:true};
 assert.equal((await f.message({type:'api',path:'/api/heartbeat',data},3,url)).ok,true);
 const first=f.calls.at(-1);
 assert.equal(first.data.page,'https://www.zhipin.com/web/geek/chat');
 assert.equal(first.data.accountForeground,false);
 assert.equal(first.data.accountSignal,'chat-workspace');
 f.tabs[0].url='https://www.zhipin.com/web/geek/job';
 assert.equal((await f.message({type:'api',path:'/api/heartbeat',data},3,url)).ok,false);
 assert.equal(f.calls.length,1);
});
test('等待账号核对时清理旧浏览器工作绑定，不领取任务、不自动打开站内标签',async()=>{
 const f=await backgroundFixture({
  initialSession:{worker:{tabId:1},crawler:{tabId:2},chatJob:{peerId:'prior-peer'}},
  response:path=>path==='/api/browser-state'?{accountRecheck:{required:true},running:true,config:{running:true,chatRead:true}}:{}
 });
 await f.run();
 assert.equal(f.session.worker,undefined);
 assert.equal(f.session.crawler,undefined);
 assert.equal(f.session.chatJob,undefined);
 assert.equal(f.tabs.length,0);
 assert.deepEqual(f.calls.map(call=>call.path),['/api/browser-state','/api/worker-health']);
 assert.match(f.calls.at(-1).data.phase,/核对原 BOSS 账号/);
});
test('同一个自主搜索只导航一次，重复唤醒保留页面，不创建刷新循环',async()=>{
 const search={id:'search-1',url:'https://www.zhipin.com/web/geek/job?query=game&city=101010100'};const f=await backgroundFixture({existing:[{id:1,url:'https://www.zhipin.com/web/geek/recommend'}],response:p=>p==='/api/browser-state'?{search,running:true,config:{autoBrowse:true,chatRead:false,crawlEnabled:true}}:{job:null,task:null}});await f.run();await f.run();assert.equal(f.tabs.length,1);assert.equal(f.tabs[0].url,search.url);assert.equal(f.session.lastSearch.id,search.id);assert(!f.calls.some(c=>c.path==='/api/search/observed'));
});
test('相同已导航搜索不会饿死库存详情，第二次唤醒领取详情且不重复导航搜索页',async()=>{
 const search={id:'stock-search',url:'https://www.zhipin.com/web/geek/job?query=intern&city=101010100'},job={id:'stock-detail',url:'https://www.zhipin.com/job_detail/stock-detail.html',lease:'stock-lease'};
 const f=await backgroundFixture({existing:[{id:1,url:'https://www.zhipin.com/web/geek/recommend'}],response:p=>p==='/api/browser-state'?{search,running:true,config:{autoBrowse:true,chatRead:false,crawlEnabled:true}}:p==='/api/crawl/next'?{job}:{task:null}});
 await f.run();assert.equal(f.updates.length,1);assert.equal(f.tabs[0].url,search.url);assert(!f.calls.some(c=>c.path==='/api/crawl/next'));
 await f.run();assert.equal(f.session.crawler.jobId,job.id);assert.equal(f.tabs.length,2);assert.equal(f.tabs[1].url,job.url);assert.equal(f.updates.length,1);assert.equal(f.calls.filter(c=>c.path==='/api/crawl/next').length,1);
 await f.run();assert.equal(f.updates.length,1);assert.equal(f.tabs.length,2);assert.equal(f.calls.filter(c=>c.path==='/api/crawl/next').length,1);assert(f.pokes.some(p=>p.id===1));
});
test('服务持续返回相同搜索时已在库候选立即采集，既有搜索标签不重建',async()=>{
 const search={id:'ongoing-search',url:'https://www.zhipin.com/web/geek/job?query=game'},job={id:'already-listed',url:'https://www.zhipin.com/job_detail/already-listed.html',lease:'detail-lease'};
 const f=await backgroundFixture({initialSession:{lastSearch:{id:search.id,tabId:5}},existing:[{id:5,url:search.url}],response:p=>p==='/api/browser-state'?{search,running:true,config:{autoBrowse:true,chatRead:false,crawlEnabled:true}}:p==='/api/crawl/next'?{job}:{task:null}});
 await f.run();assert.equal(f.session.crawler.jobId,job.id);assert.equal(f.tabs.filter(t=>t.url===search.url).length,1);assert.equal(f.updates.length,0);assert.equal(f.tabs.length,2);assert.equal(f.calls.filter(c=>c.path==='/api/crawl/next').length,1);
});

test('停用自主求职后，迟到的招呼、详情和收藏响应不能打开或改动浏览器标签',async()=>{
 const job={id:'fixture-detail',url:'https://www.zhipin.com/job_detail/fixture-detail.html',lease:'fixture'};
 const search={id:'fixture-search',url:'https://www.zhipin.com/web/geek/job?query=旧搜索'};
 const favorites={enabled:true,due:true,navigation:{url:'https://www.zhipin.com/web/geek/recommend?tab=4'}};
 const ownerPage='https://www.zhipin.com/web/geek/job?query=owner';
 for(const [held,result] of [
  ['/api/work',{task:null}],['/api/work',{task:{id:'fixture-greet',job}}],['/api/crawl/next',{job}],['/api/favorites/state',favorites]
 ]){
  const reached=Promise.withResolvers(),response=Promise.withResolvers();let running=true;
  const state=()=>({config:{jobSearchRunning:running,hrInboxRunning:true,autoBrowse:true,crawlEnabled:true,chatRead:true},
   ...(held==='/api/work'&&running?{search}:{}),...(held==='/api/favorites/state'?{favorites}: {})});
  const f=await backgroundFixture({existing:[{id:1,url:'https://www.zhipin.com/web/geek/chat',active:false},{id:2,url:ownerPage,active:true}],
   response:path=>{if(path===held){reached.resolve();return response.promise;}return path==='/api/browser-state'?state():{};}});
  const work=f.run();await reached.promise;running=false;response.resolve(result);await work;
  assert.deepEqual(f.tabs.map(t=>t.url),['https://www.zhipin.com/web/geek/chat',ownerPage],held);
  assert.equal(f.tabs[1].active,true);assert.equal(f.updates.length,0);assert(f.pokes.some(item=>item.id===1));
  assert.equal(f.session.worker,undefined);assert.equal(f.session.crawler,undefined);assert.equal(f.session.favoritesWorker,undefined);
 }
});

test('替换后的搜索计划不执行旧导航，活动岗位页始终留在原地址',async()=>{
 const previous={id:'previous',url:'https://www.zhipin.com/web/geek/job?query=previous'};
 const current={id:'current',url:'https://www.zhipin.com/web/geek/job?query=current'};
 const ownerPage='https://www.zhipin.com/web/geek/job?query=owner';
 const held=Promise.withResolvers(),reached=Promise.withResolvers();let search=previous,first=true;
 const f=await backgroundFixture({existing:[{id:1,url:ownerPage,active:true}],response:path=>{
  if(path==='/api/browser-state')return {search,config:{jobSearchRunning:true,hrInboxRunning:false,chatRead:false,autoBrowse:true,crawlEnabled:true}};
  if(path==='/api/work'&&first){first=false;reached.resolve();return held.promise;}
  return {};
 }});
 const work=f.run();await reached.promise;search=current;held.resolve({task:null});await work;
 assert.equal(f.tabs.length,1);assert.equal(f.session.lastSearch,undefined);
 await f.run();
 assert.equal(f.updates.length,0);
 assert.deepEqual(f.tabs.map(tab=>[tab.url,tab.active]),[[ownerPage,true],[current.url,false]]);
 assert.equal(f.session.lastSearch.id,current.id);
 const count=f.calls.filter(call=>call.path==='/api/browser-state').length;
 await f.run();
 assert.equal(f.calls.filter(call=>call.path==='/api/browser-state').length,count+1,'已打开的相同搜索页仅唤醒，无额外授权查询');
});

test('查找可复用标签期间用户切到该页时改用新的后台搜索标签',async()=>{
 const search={id:'next',url:'https://www.zhipin.com/web/geek/job?query=next'};
 const prior='https://www.zhipin.com/web/geek/job?query=owner';let snapshots=0;
 const f=await backgroundFixture({existing:[{id:1,url:prior,active:false}],response:path=>{
  if(path!=='/api/browser-state')return {};
  if(++snapshots===2)f.tabs[0].active=true;
  return {search,config:{jobSearchRunning:true,hrInboxRunning:false,chatRead:false,autoBrowse:true,crawlEnabled:true}};
 }});
 await f.run();
 assert.equal(f.updates.length,0);
 assert.deepEqual(f.tabs.map(tab=>[tab.url,tab.active]),[[prior,true],[search.url,false]]);
});

test('自主求职关闭后只打开仍由同一条主人委托授权的招呼',async()=>{
 const ownerGreeting={id:'owner-greeting',automatic:false},job={url:'https://www.zhipin.com/job_detail/owner-fixture.html'};
 for(const greetingPlanId of [ownerGreeting.id,'outdated-plan',undefined]){
  const f=await backgroundFixture({response:path=>path==='/api/browser-state'?{config:{jobSearchRunning:false,hrInboxRunning:false,chatRead:false,ownerGreeting}}
   :path==='/api/work'?{task:{id:'owner-task',greetingPlanId,job}}:{}});
  await f.run();
  const allowed=greetingPlanId===ownerGreeting.id;
  assert.equal(f.tabs.some(tab=>tab.url===job.url&&tab.active===false),allowed);
  assert.equal(f.session.worker?.greetingPlanId,allowed?ownerGreeting.id:undefined);
 }
});

test('复用前台收藏或搜索页只读取，后台收藏仍可按已验证入口打开',async()=>{
 const favoriteURL='https://www.zhipin.com/web/geek/recommend?tab=4';
 const ownerPage='https://www.zhipin.com/web/geek/job?query=owner';
 const favorites={enabled:true,due:true,navigation:{url:favoriteURL}};
 const state={config:{jobSearchRunning:true,hrInboxRunning:false,chatRead:false,autoBrowse:true,crawlEnabled:true},favorites};
 const response=path=>path==='/api/browser-state'?state:path==='/api/favorites/state'?favorites:{};
 const f=await backgroundFixture({existing:[{id:1,url:ownerPage,active:true}],response});await f.run();
 assert.deepEqual(f.tabs.map(tab=>[tab.url,tab.active]),[[ownerPage,true],[favoriteURL,false]]);
 assert.equal(f.updates.length,0);
 const active=await backgroundFixture({existing:[{id:1,url:favoriteURL,active:true}],response});await active.run();await active.run();
 assert.equal(active.tabs.length,1);assert.equal(active.updates.length,0);
 const probes=active.pokes.filter(item=>item.m.command==='favorites-scan');
 assert(probes.length>0);assert(probes.every(item=>item.m.allowNavigate===false));
});
test('自动浏览会打开岗位和聊天，采集详情与招呼执行分别管理',async()=>{
 const session={},tabs=[],requests=[],calls=[];let startup;
 const chrome={runtime:{id:'fixture',onMessage:{addListener(){}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},storage:{local:{get:async()=>({token:'fixture'})},session:{get:async key=>({[key]:session[key]}),set:async v=>Object.assign(session,v),remove:async key=>delete session[key]}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{query:async()=>tabs,create:async v=>{const t={id:tabs.length+1,...v};tabs.push(t);return t;},get:async id=>tabs.find(t=>t.id===id),sendMessage:async()=>({ok:true}),onRemoved:{addListener(){}}}};
 const fetch=async(url,options)=>{const path=new URL(url).pathname;requests.push(path);calls.push({path,method:options?.method||'GET'});const values={'/api/browser-state':{running:true,config:{autoBrowse:true,chatRead:true,crawlEnabled:true}},'/api/crawl/next':{job:{id:'job1',url:'https://www.zhipin.com/job_detail/fixture.html',lease:'lease1'}},'/api/work':{task:null}};return {ok:true,json:async()=>values[path]||{ok:true}};};
 vm.runInNewContext(readFileSync(new URL('../extension/background.js',import.meta.url),'utf8'),{chrome,fetch,URL,AbortSignal,setTimeout:fn=>{startup=fn;},Date,console});
 await startup();
 assert.deepEqual(tabs.map(t=>t.url),['https://www.zhipin.com/web/geek/chat','https://www.zhipin.com/job_detail/fixture.html']);
 assert.equal(session.crawler.jobId,'job1');assert.equal(session.worker,undefined);assert(!requests.includes('/api/claim'));
 assert.equal(calls.find(c=>c.path==='/api/crawl/next')?.method,'POST');
});
test('聊天查看职位使用独立后台标签，只清理自己创建的标签且不调用招呼队列',async()=>{
 const session={},tabs=[{id:1,url:'https://www.zhipin.com/web/geek/chat'}],removed=[],requests=[];let listener;
 const chrome={runtime:{id:'fixture',onMessage:{addListener(fn){listener=fn;}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},storage:{local:{get:async()=>({token:'fixture'})},session:{get:async key=>({[key]:session[key]}),set:async v=>Object.assign(session,v),remove:async key=>delete session[key]}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{query:async()=>tabs,create:async v=>{const tab={id:tabs.length+1,...v};tabs.push(tab);return tab;},get:async id=>tabs.find(tab=>tab.id===id),remove:async id=>removed.push(id),update:async()=>assert.fail('后台读取不应切换标签'),onRemoved:{addListener(){}}}};
 const fetch=async url=>{requests.push(url);return {ok:true,json:async()=>({ok:true})};};vm.runInNewContext(readFileSync(new URL('../extension/background.js',import.meta.url),'utf8'),{chrome,fetch,URL,AbortSignal,setTimeout(){},Date,console});
 const message=(m,id,url)=>new Promise(r=>listener(m,{id:'fixture',tab:{id},url},r));
 const read={requestId:'read-1',lease:'readonly-lease',peerId:'boss:liu',role:{title:'游戏策划实习生',url:'https://www.zhipin.com/job_detail/read-only.html'}};
 assert((await message({type:'chatJobOpen',read,url:read.role.url},1,tabs[0].url)).ok);assert.equal(tabs[1].active,false);assert.equal(session.crawler,undefined);assert.equal(session.worker,undefined);
 assert.equal((await message({type:'chatJobWorker'},1,tabs[0].url)).result,null);assert.equal((await message({type:'chatJobWorker'},2,tabs[1].url)).result.requestId,'read-1');
 await message({type:'chatJobDone',requestId:'read-1'},1,tabs[0].url);assert.equal(removed.length,0);
 await message({type:'chatJobDone',requestId:'read-1'},2,tabs[1].url);assert.deepEqual(removed,[2]);assert.equal(session.chatJob,undefined);assert.equal(requests.length,0);
 const second={...read,requestId:'read-2',role:{title:read.role.title}};
 await message({type:'chatJobOpen',read:second},1,tabs[0].url);
 assert.equal((await message({type:'chatJobNavigate',requestId:'read-2',url:read.role.url},9,tabs[0].url)).ok,false);
 assert.equal((await message({type:'chatJobNavigate',requestId:'read-2',url:'https://example.com/job_detail/a.html'},1,tabs[0].url)).ok,false);
 assert.equal((await message({type:'chatJobNavigate',requestId:'read-2',url:read.role.url},1,tabs[0].url)).ok,true);
 assert.equal(tabs.at(-1).active,false);
 assert.equal(session.chatJob.role.url,read.role.url);assert.equal(session.chatJob.sourceTabId,1);assert.equal(session.crawler,undefined);
});

test('已有待发招呼先于下一条采集；后台唤醒保持聊天监听且不反复抢焦点',async()=>{
 const f=await backgroundFixture({existing:[{id:1,url:'https://www.zhipin.com/web/geek/chat',active:false},{id:2,url:'https://www.zhipin.com/web/geek/job',active:true}],response:p=>({
  '/api/browser-state':{running:true,config:{autoBrowse:true,chatRead:true,crawlEnabled:true}},
  '/api/work':{task:{id:'greet-1',job:{id:'j1',url:'https://www.zhipin.com/job_detail/send-first.html'}}},
  '/api/crawl/next':{job:{id:'read-2',url:'https://www.zhipin.com/job_detail/should-not-open.html'}}
 }[p]||{})});
 await f.run();assert.equal(f.session.worker.taskId,'greet-1');assert.equal(f.session.crawler,undefined);
 assert(!f.calls.some(c=>c.path==='/api/crawl/next'));assert(f.pokes.some(p=>p.id===1));
 await f.run();assert.equal(f.tabs.length,3);assert.equal(f.updates.length,0);
 assert.equal(f.calls.filter(c=>c.path==='/api/work').length,1);
});

test('只读模式保持唯一聊天监听，其他 BOSS 页及切换活动聊天页不会抢走游标',async()=>{
 const f=await backgroundFixture({existing:[{id:1,url:'https://www.zhipin.com/web/geek/chat',active:true},{id:2,url:'https://www.zhipin.com/web/geek/chat?other',active:false},{id:3,url:'https://www.zhipin.com/web/geek/job',active:false}],response:p=>p==='/api/browser-state'?{running:false,config:{readingEnabled:true,chatRead:true}}:{}});
 await f.run();f.tabs[0].active=false;f.tabs[1].active=true;
 const a=await f.message({type:'chatMonitor'},1,f.tabs[0].url),b=await f.message({type:'chatMonitor'},2,f.tabs[1].url);
 assert.equal(a.ok,true);assert.equal(a.result.monitor,true);assert.equal(b.result.monitor,false);assert.equal(b.result.tabId,1);
 const wrong=await f.message({type:'chatMonitor'},3,f.tabs[2].url);assert.equal(wrong.ok,false);
 assert.equal(f.tabs.length,3);assert(!f.calls.some(c=>c.path==='/api/work'));assert.equal(f.updates.length,0);
});

test('HR 新消息提示只接收真实聊天来源，暂停时不唤醒；恢复后直接唤醒固定聊天页',async()=>{
 let running=false;const f=await backgroundFixture({existing:[{id:1,url:'https://www.zhipin.com/web/geek/chat'},{id:2,url:'https://www.zhipin.com/web/geek/job'}],response:p=>p==='/api/browser-state'?{running,config:{readingEnabled:false,chatRead:true}}:{task:null,job:null}});
 const wrong=await f.message({type:'chatEvent'},2,f.tabs[1].url);assert.equal(wrong.ok,false);assert.equal(f.pokes.length,0);
 const paused=await f.message({type:'chatEvent',pending:1},1,f.tabs[0].url);assert.equal(paused.result.paused,true);assert.equal(f.pokes.length,0);
 running=true;const active=await f.message({type:'chatEvent',pending:2},1,f.tabs[0].url);assert.equal(active.ok,true);assert.equal(f.session.lastIncomingHint.pending,2);assert.equal(f.pokes[0].id,1);
 assert(!f.calls.some(c=>c.path==='/api/work'));assert.equal(f.updates.length,0);
});

test('岗位页关闭或超时仅报告该任务失败，不暂停全局 HR 监听和其他任务',async()=>{
 const f=await backgroundFixture({initialSession:{worker:{tabId:99,taskId:'greet-missing',at:Date.now()}},existing:[{id:1,url:'https://www.zhipin.com/web/geek/chat'}],response:p=>p==='/api/browser-state'?{running:true,config:{chatRead:true}}:{}});
 await f.run();assert.equal(f.session.worker,undefined);assert.equal(f.calls.find(c=>c.path==='/api/worker/fail')?.data.taskId,'greet-missing');assert(!f.calls.some(c=>c.path==='/api/stop'));assert(f.pokes.some(p=>p.id===1));
 f.session.worker={tabId:9,taskId:'greet-closed',at:Date.now()};await f.close(9);
 assert.equal(f.calls.filter(c=>c.path==='/api/worker/fail').at(-1).data.taskId,'greet-closed');assert.equal(f.session.worker,undefined);assert(!f.calls.some(c=>c.path==='/api/stop'));
});

test('自动采集完成只关闭自己的后台详情页，用户已切到的详情页保持打开',async()=>{
 const f=await backgroundFixture({existing:[{id:1,url:'https://www.zhipin.com/job_detail/read.html',active:false},{id:2,url:'https://www.zhipin.com/job_detail/manual.html',active:true}]});
 f.session.crawler={tabId:1,jobId:'read-1'};await f.message({type:'crawlDone'},2,f.tabs[1].url);assert(f.session.crawler);assert.equal(f.removed.length,0);
 await f.message({type:'crawlDone'},1,f.tabs[0].url);assert.equal(f.session.crawler,undefined);assert.deepEqual(f.removed,[1]);
 f.session.crawler={tabId:2,jobId:'read-2'};await f.message({type:'crawlDone'},2,f.tabs[1].url);assert.equal(f.session.crawler,undefined);assert.deepEqual(f.removed,[1]);
});

const greetingWorkerState=(extra={})=>{
 const job={title:'游戏策划实习生',company:'虚构游戏',url:'https://www.zhipin.com/job_detail/handoff-fixture.html'};
 const task={id:'handoff-task',kind:'greeting',action:'send_text',text:'你好，小鲸帮主人了解实习机会。',job};
 return {tabId:10,taskId:task.id,job,at:Date.now(),claimed:{id:task.id,lease:'fixture-claimed-lease',task},...extra};
};
const sourceTab=()=>({id:10,url:'https://www.zhipin.com/job_detail/handoff-fixture.html',active:false});
const childChat=(extra={})=>({id:11,url:'https://www.zhipin.com/web/geek/chat?bossId=fixture',openerTabId:10,active:true,...extra});
const handoffResponse=p=>p==='/api/check'?{allowed:true}:p==='/api/browser-state'?{running:true,config:{chatRead:true}}:{task:null,job:null};

test('立即沟通 window.open 后只将已领取的同一招呼接续到唯一 opener 子聊天页并保留 claim',async()=>{
 const original=greetingWorkerState(),f=await backgroundFixture({initialSession:{worker:original},existing:[sourceTab(),{id:3,url:'https://www.zhipin.com/web/geek/chat',active:false},childChat()],response:handoffResponse});
 const result=await f.message({type:'worker'},11,childChat().url);assert.equal(result.ok,true);assert.equal(result.result.tabId,11);assert.equal(result.result.sourceTabId,10);assert.equal(result.result.taskId,original.taskId);assert.equal(result.result.claimed.id,original.claimed.id);assert.equal(result.result.claimed.lease,original.claimed.lease);assert.equal(result.result.claimed.task.text,original.claimed.task.text);
 assert.equal(result.result.at,original.at);assert(result.result.handoffAt);assert.equal(f.calls.filter(c=>c.path==='/api/check').length,1);
 assert.equal((await f.message({type:'worker'},10,sourceTab().url)).result,null);assert.equal((await f.message({type:'worker'},3,'https://www.zhipin.com/web/geek/chat')).result,null);
 assert.equal((await f.message({type:'worker'},11,childChat().url)).result.claimed.lease,original.claimed.lease);assert.equal(f.calls.filter(c=>c.path==='/api/check').length,1);assert(f.pokes.some(p=>p.id===11));assert.equal(f.updates.length,0);
 assert(!f.calls.some(c=>['/api/claim','/api/work','/api/complete'].includes(c.path)));
});

test('子页面先请求 worker 时也能接续；后台调度报告接续阶段而不新建或重新领取招呼',async()=>{
 const f=await backgroundFixture({initialSession:{worker:greetingWorkerState()},existing:[sourceTab(),childChat()],response:handoffResponse});
 await f.run();assert.equal(f.session.worker.tabId,11);assert.match(f.calls.find(c=>c.path==='/api/worker-health').data.phase,/聊天页已接续/);assert(!f.calls.some(c=>c.path==='/api/work'));assert.equal(f.tabs.length,2);
 await f.close(10);assert.equal(f.session.worker.tabId,11);assert(!f.calls.some(c=>c.path==='/api/complete'));
});

test('没有领取、claim 任务不符、源岗位不符、任意现有聊天与非聊天子页均不得接管',async()=>{
 const variants=[
  {worker:greetingWorkerState({claimed:null}),tabs:[sourceTab(),childChat()]},
  {worker:greetingWorkerState({claimed:{...greetingWorkerState().claimed,id:'different-task'}}),tabs:[sourceTab(),childChat()]},
  {worker:greetingWorkerState(),tabs:[{...sourceTab(),url:'https://www.zhipin.com/job_detail/another-job.html'},childChat()]},
  {worker:greetingWorkerState(),tabs:[sourceTab(),childChat({openerTabId:99})]},
  {worker:greetingWorkerState(),tabs:[sourceTab(),childChat({openerTabId:undefined})]},
  {worker:greetingWorkerState(),tabs:[sourceTab(),childChat({url:'https://www.zhipin.com/job_detail/other.html'})]},
  {worker:greetingWorkerState(),tabs:[sourceTab(),childChat({url:'https://www.zhipin.com.evil.example/web/geek/chat'})]}
 ];
 for(const variant of variants){const f=await backgroundFixture({initialSession:{worker:variant.worker},existing:variant.tabs,response:handoffResponse});const result=await f.message({type:'worker'},11,variant.tabs[1].url);assert.equal(result.result??null,null);assert.equal(f.session.worker.tabId,10);assert(!f.calls.some(c=>c.path==='/api/check'));}
});

test('两个 opener 匹配的聊天子页属于歧义，不猜测接收人也不转移任务',async()=>{
 const f=await backgroundFixture({initialSession:{worker:greetingWorkerState()},existing:[sourceTab(),childChat(),childChat({id:12})],response:handoffResponse});
 assert.equal((await f.message({type:'worker'},11,childChat().url)).result,null);assert.equal(f.session.worker.tabId,10);assert(!f.calls.some(c=>c.path==='/api/check'));
});

test('已经失效或结果不明的执行凭据永不接续；超时任务不复活为可发送子页面',async()=>{
 const f=await backgroundFixture({initialSession:{worker:greetingWorkerState()},existing:[sourceTab(),childChat()],response:p=>p==='/api/check'?{allowed:false}:handoffResponse(p)});
 assert.equal((await f.message({type:'worker'},11,childChat().url)).result,null);assert.equal(f.session.worker.tabId,10);
 const expired=await backgroundFixture({initialSession:{worker:greetingWorkerState({at:Date.now()-181000})},existing:[sourceTab(),childChat()],response:handoffResponse});
 assert.equal((await expired.message({type:'worker'},11,childChat().url)).result,null);assert(!expired.calls.some(c=>c.path==='/api/check'));await expired.run();assert.equal(expired.session.worker,undefined);assert(!expired.calls.some(c=>c.path==='/api/work'));assert.equal(expired.calls.find(c=>c.path==='/api/complete').data.success,false);
});

test('已领取 worker 超时用原 lease 报不明结果，已 uncertain 的迟到拒绝仍清理绑定且不重发',async()=>{
 for(const claimed of [true,false]){
  const worker=greetingWorkerState({at:Date.now()-181000});if(!claimed)delete worker.claimed;
  const f=await backgroundFixture({initialSession:{worker},existing:[sourceTab()],response:p=>['/api/complete','/api/worker/fail'].includes(p)?{__http:400,error:'执行已经结束或结果待核对'}:handoffResponse(p)});
  await f.run();assert.equal(f.session.worker,undefined);const report=f.calls.find(c=>c.path===(claimed?'/api/complete':'/api/worker/fail'));assert(report);if(claimed){assert.equal(report.data.lease,'fixture-claimed-lease');assert.equal(report.data.success,false);assert.equal(report.data.notStarted,undefined);}
  assert(!f.calls.some(c=>c.path==='/api/stop'));assert(!f.calls.some(c=>c.path==='/api/claim'));assert(!f.calls.some(c=>c.path==='/api/work'));assert.match(f.calls.find(c=>c.path==='/api/worker-health').data.phase,/结果待核对/);
 }
});

test('claim 保存必须与原 worker 的任务和岗位一致，无法把其他任务接给子页',async()=>{
 const worker=greetingWorkerState({claimed:null}),f=await backgroundFixture({initialSession:{worker},existing:[sourceTab(),childChat()],response:handoffResponse});
 const wrong={...greetingWorkerState().claimed,id:'wrong'};assert.equal((await f.message({type:'saveClaim',claimed:wrong},10,sourceTab().url)).ok,false);assert.equal(f.session.worker.claimed,null);
 const good=greetingWorkerState().claimed;assert.equal((await f.message({type:'saveClaim',claimed:good},10,sourceTab().url)).ok,true);assert.equal((await f.message({type:'worker'},11,childChat().url)).result.claimed.id,good.id);
});

test('已经领取但尚无可接续子页时明确记录等待阶段并保留原 lease',async()=>{
 const worker=greetingWorkerState(),f=await backgroundFixture({initialSession:{worker},existing:[sourceTab()],response:handoffResponse});await f.run();assert.equal(f.session.worker.claimed.lease,worker.claimed.lease);assert.equal(f.session.worker.tabId,10);assert.match(f.calls.find(c=>c.path==='/api/worker-health').data.phase,/等待聊天页接续/);
});

test('两个通道四种组合独立：只开HR不找岗，只开求职不启动HR监听',async()=>{
 for(const [jobSearchRunning,hrInboxRunning] of [[false,false],[true,false],[false,true],[true,true]]){
  const state={running:jobSearchRunning||hrInboxRunning,config:{jobSearchRunning,hrInboxRunning,running:jobSearchRunning||hrInboxRunning,autoBrowse:true,chatRead:true,crawlEnabled:true,favoritesFirst:false}};
  const f=await backgroundFixture({response:p=>p==='/api/browser-state'?state:{task:null,job:null}});await f.run();
  assert.equal(f.tabs.some(t=>t.url==='https://www.zhipin.com/web/geek/chat'),hrInboxRunning);
  assert.equal(f.calls.some(c=>c.path==='/api/work'),jobSearchRunning);
  assert.equal(f.calls.some(c=>c.path==='/api/crawl/next'),jobSearchRunning);
  assert.equal(f.tabs.some(t=>t.url==='https://www.zhipin.com/web/geek/job'),jobSearchRunning);
 }
});

test('关闭自主求职清理旧岗位绑定但不关闭HR监听，关闭HR拒绝自动新消息唤醒',async()=>{
 const state={running:true,config:{jobSearchRunning:false,hrInboxRunning:true,autoBrowse:true,chatRead:true,crawlEnabled:true}};
 const f=await backgroundFixture({initialSession:{worker:{tabId:5,taskId:'old-job',greetingPlanId:'auto',at:Date.now()},crawler:{tabId:6,jobId:'old-detail'}},existing:[{id:1,url:'https://www.zhipin.com/web/geek/chat'},{id:5,url:'https://www.zhipin.com/job_detail/old-job.html'},{id:6,url:'https://www.zhipin.com/job_detail/old-detail.html'}],response:p=>p==='/api/browser-state'?state:{}});
 await f.run();assert.equal(f.session.worker,undefined);assert.equal(f.session.crawler,undefined);assert(f.pokes.some(p=>p.id===1));assert(!f.calls.some(c=>['/api/work','/api/crawl/next'].includes(c.path)));assert(!f.calls.some(c=>c.path==='/api/stop'));
 state.config.jobSearchRunning=true;state.config.hrInboxRunning=false;
 const hint=await f.message({type:'chatEvent',pending:1},1,f.tabs[0].url);assert(hint.result.paused);assert.equal(f.session.lastIncomingHint,undefined);
});

test('两个自动通道关闭时，明确的主人会话与单条测试仍能打开执行聊天页',async()=>{
 for(const manual of [{ownerChat:{targetId:'manual-target'}},{singleTest:{status:'selecting'}},{ownerGreeting:{id:'explicit-greeting',scope:'owner',automatic:false}}]){
  const f=await backgroundFixture({response:p=>p==='/api/browser-state'?{running:false,config:{jobSearchRunning:false,hrInboxRunning:false,chatRead:true,readingEnabled:false,...manual}}:{}});await f.run();
  assert.equal(f.tabs.length,1);assert.equal(f.tabs[0].url,'https://www.zhipin.com/web/geek/chat');
  assert.deepEqual(f.calls.filter(c=>c.path==='/api/crawl/next').map(c=>c.data),manual.ownerGreeting?[{ownerGreetingPlanId:manual.ownerGreeting.id,ownerGreetingReadRevision:0}]:[]);
  assert.equal(f.calls.some(c=>c.path==='/api/work'),!!manual.ownerGreeting);
 }
});

test('主人招呼取消后，迟到的读取任务不会开页或接管新委托，已选详情页保持打开',async()=>{
 const ownerGreeting={id:'old-owner-plan',scope:'owner',automatic:false};
 const job={id:'old-candidate',url:'https://www.zhipin.com/job_detail/old-owner-candidate.html',lease:'old-crawl-lease'};
 const state={config:{jobSearchRunning:false,hrInboxRunning:true,chatRead:true,ownerGreeting}};
 const started=Promise.withResolvers(),reply=Promise.withResolvers();
 const existing=[{id:1,url:'https://www.zhipin.com/web/geek/chat',active:false},{id:2,url:job.url,active:true}];
 const f=await backgroundFixture({existing,response:(path,data)=>{
  if(path==='/api/browser-state')return state;
  if(path==='/api/crawl/next'){
   assert.equal(data.ownerGreetingPlanId,ownerGreeting.id);started.resolve();return reply.promise;
  }
  return {task:null};
 }});
 const working=f.run();
 await started.promise;state.config.ownerGreeting={...ownerGreeting,id:'new-owner-plan'};reply.resolve({job});await working;
 assert.equal(f.tabs.length,2);assert.equal(f.session.crawler,undefined);
 assert(!f.calls.some(c=>c.path.startsWith('/api/favorites')||c.path==='/api/claim'));
 f.session.crawler={tabId:2,jobId:job.id,lease:job.lease,url:job.url,ownerGreetingPlanId:ownerGreeting.id,at:Date.now()};
 const sent=await f.message({type:'api',path:'/api/crawl/complete',data:{id:job.id,lease:job.lease,url:job.url,success:true}},2,job.url);
 assert.equal(sent.ok,false);assert(!f.calls.some(c=>c.path==='/api/crawl/complete'));
 assert.equal((await f.message({type:'crawlWorker'},2,job.url)).result,null);
 assert.equal(f.session.crawler,undefined);assert.deepEqual(f.removed,[]);assert.equal(f.tabs[1].active,true);assert(f.pokes.some(p=>p.id===1));
});

test('同一招呼委托恢复后，旧版读取回传不能打开或接管新版读取页',async()=>{
 const ownerGreeting={id:'same-owner-plan',scope:'owner',automatic:false};
 const job={id:'same-candidate',url:'https://www.zhipin.com/job_detail/same-candidate.html',lease:'old-reading'};
 const state={config:{jobSearchRunning:false,hrInboxRunning:true,chatRead:true,ownerGreeting}};
 const started=Promise.withResolvers(),reply=Promise.withResolvers();
 const owner={id:2,url:job.url,active:true};
 const existing=[{id:1,url:'https://www.zhipin.com/web/geek/chat',active:false},owner];
 const f=await backgroundFixture({existing,response:(path,data)=>{
  if(path==='/api/browser-state')return state;
  if(path==='/api/crawl/next'){
   assert.equal(data.ownerGreetingPlanId,ownerGreeting.id);
   if(data.ownerGreetingReadRevision===0){started.resolve();return reply.promise;}
   assert.equal(data.ownerGreetingReadRevision,1);return {job:{...job,lease:'new-reading'}};
  }
  return {task:null};
 }});
 const working=f.run();
 await started.promise;ownerGreeting.readRevision=1;reply.resolve({job});await working;
 assert.equal(f.tabs.length,2);assert.equal(f.session.crawler,undefined);
 // An old worker could already have stored this view before it saw the cancellation.
 f.session.crawler={tabId:owner.id,jobId:job.id,lease:job.lease,url:job.url,ownerGreetingPlanId:ownerGreeting.id,at:Date.now()};
 const oldReceipt=await f.message({type:'api',path:'/api/crawl/complete',data:{id:job.id,lease:job.lease,url:job.url}},owner.id,owner.url);
 assert.equal(oldReceipt.ok,false);assert(!f.calls.some(c=>c.path==='/api/crawl/complete'));
 await f.run();
 const fresh=f.session.crawler;
 assert.equal(fresh.ownerGreetingReadRevision,1);assert.equal(fresh.lease,'new-reading');
 assert.notEqual(fresh.tabId,owner.id);assert.equal(owner.active,true);assert.deepEqual(f.removed,[]);
 await f.message({type:'crawlDone'},owner.id,owner.url);
 assert.equal(f.session.crawler.lease,fresh.lease);
 assert.equal((await f.message({type:'crawlWorker'},fresh.tabId,job.url)).result.lease,fresh.lease);
});

test('关求职保留已领取的旧发送核对，HR继续唤醒；未发读取绑定清理且不关用户活动页',async()=>{
 const worker=greetingWorkerState(),state={running:true,config:{jobSearchRunning:false,hrInboxRunning:true,chatRead:true}};
 const f=await backgroundFixture({initialSession:{worker,crawler:{tabId:6,jobId:'read',url:'https://www.zhipin.com/job_detail/read.html'},favoritesWorker:{tabId:7,url:'https://www.zhipin.com/web/geek/recommend?tab=4',owned:true,at:Date.now()}},existing:[{id:1,url:'https://www.zhipin.com/web/geek/chat'},sourceTab(),{id:6,url:'https://www.zhipin.com/job_detail/read.html',active:false},{id:7,url:'https://www.zhipin.com/web/geek/recommend?tab=4',active:true}],response:p=>p==='/api/browser-state'?state:{}});
 await f.run();assert.equal(f.session.worker.claimed.lease,worker.claimed.lease);assert.equal(f.session.crawler,undefined);assert.equal(f.session.favoritesWorker,undefined);assert.deepEqual(f.removed,[6]);assert(f.pokes.some(p=>p.id===1));assert(!f.calls.some(c=>['/api/complete','/api/claim','/api/work','/api/crawl/next'].includes(c.path)));
 assert.equal((await f.message({type:'worker'},10,sourceTab().url)).result.claimed.lease,worker.claimed.lease,'original source may finish collecting its receipt');
 f.session.worker.at=Date.now()-181000;await f.run();assert.equal(f.session.worker,undefined);assert.equal(f.calls.find(c=>c.path==='/api/complete').data.success,false);assert(f.pokes.some(p=>p.id===1));assert(!f.calls.some(c=>c.path==='/api/stop'));
});

test('job-only的规划ownerBusy和readingEnabled不会悄悄开启聊天监听',async()=>{
 const f=await backgroundFixture({response:p=>p==='/api/browser-state'?{running:true,config:{jobSearchRunning:true,hrInboxRunning:false,ownerBusy:true,readingEnabled:true,chatRead:true,crawlEnabled:true,ownerGreeting:{id:'standing',scope:'jobSearch',automatic:true}}}:{task:null,job:null}});await f.run();assert(!f.tabs.some(t=>t.url.includes('/chat')));assert.equal(f.session.chatMonitorTabId,undefined);
});
