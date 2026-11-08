import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {embeddedRuntimeId,startEmbeddedWorker} from '../desktop/embedded-worker.mjs';

const extensionDir=fileURLToPath(new URL('../extension/',import.meta.url));
const token='a'.repeat(64);
const chat='https://www.zhipin.com/web/geek/chat';
const job={url:'https://www.zhipin.com/job_detail/fixture-worker.html',title:'测试岗位'};
const sender=tab=>({id:embeddedRuntimeId,url:tab.url,tab:{id:tab.id}});
const sleepUntil=async check=>{
  for(let attempt=0;attempt<120;attempt++){
    if(check())return;
    await wait(10);
  }
  throw Error('等待内嵌浏览器后台调度超时');
};

function event(){
  const listeners=new Set();
  return {
    size:()=>listeners.size,
    addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),
    fire:(...args)=>{for(const fn of listeners)fn(...args);},
  };
}

async function fixture(t){
  const calls=[],pokes=[],pages=[],reloads=[],failures=[],responses=new Map();
  const state={config:{jobSearchRunning:false,hrInboxRunning:false,chatRead:true,crawlEnabled:false}};
  let nextTabId=1,workGate;
  const app=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers['x-boss-token'],token);
      assert.equal(req.headers.host,`127.0.0.1:${app.address().port}`);
      assert.equal(req.socket.localPort,app.address().port);
      const chunks=[];
      for await(const chunk of req)chunks.push(chunk);
      const data=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):undefined;
      calls.push({path:req.url,method:req.method,data});
      let value={ok:true},status=200;
      const scripted=responses.get(req.url);
      if(scripted){({value,status=200}=await scripted(data));}
      else if(req.url==='/api/browser-state')value=state;
      else if(req.url==='/api/work'){
        if(workGate)await workGate;
        value={task:{id:'fixture-greeting',job}};
      }
      else if(req.url==='/api/check')value={allowed:true};
      res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(value));
    }catch(error){failures.push(error);res.writeHead(500).end('{}');}
  });
  await new Promise(done=>app.listen(0,'127.0.0.1',done));
  const get=id=>{const tab=pages.find(row=>row.id===id);if(!tab)throw Error('模拟页面已关闭');return tab;};
  const tabs={
    onActivated:event(),onRemoved:event(),onUpdated:event(),
    query:async()=>pages,get:async id=>get(id),
    create:async details=>{const tab={id:nextTabId++,status:'complete',...details};pages.push(tab);return tab;},
    update:async(id,details)=>Object.assign(get(id),details),
    remove:async(id,info)=>{pages.splice(pages.indexOf(get(id)),1);tabs.onRemoved.fire(id,info);},
    reload:async id=>reloads.push(id),
    sendMessage:async(id,msg)=>{
      pokes.push({id,msg});
      if(msg.command==='monitor-destination'){
        const tab=get(id),url=new URL(tab.url);
        return {page:url.origin+url.pathname,clear:tab.destinationClear!==false};
      }
      return {ok:true};
    },
  };
  const worker=startEmbeddedWorker({tabs,extensionDir,port:app.address().port,token});
  t.after(async()=>{
    worker.close();
    await new Promise(done=>{app.close(done);app.closeAllConnections();});
    assert.deepEqual(failures,[]);
  });
  return {state,worker,tabs,pages,pokes,calls,reloads,responses,holdWork(){
    let release;workGate=new Promise(resolve=>{release=resolve;});return ()=>{release();workGate=null;};
  }};
}

test('内嵌后台把扩展心跳转到桌面服务端口，维持独立 HR 调度并拒绝越权请求',async t=>{
  const {state,worker,tabs,pages,pokes,calls,reloads}=await fixture(t);
  await sleepUntil(()=>calls.some(c=>c.path==='/api/worker-health'));
  assert.equal(pages.length,0);
  assert.equal(reloads.length,0);
  assert.equal(tabs.onActivated.size(),1);
  assert((await worker.receiveMessage({type:'api',path:'/api/session'},sender({id:1,url:chat}))).ok===false);
  assert((await worker.receiveMessage({type:'api',path:'/api/state'},sender({id:1,url:chat}))).ok===false);
  assert((await worker.receiveMessage({type:'api',path:'/api/browser-state',method:'DELETE'},sender({id:1,url:chat}))).ok===false);
  assert((await worker.receiveMessage({type:'api',path:'/api/browser-state'},sender({id:1,url:'https://www.zhipin.com.other.test/'}))).ok===false);
  assert((await worker.receiveMessage({type:'api',path:'/api/browser-state'},{id:'untrusted',url:chat,tab:{id:1}})).ok===false);
  assert(!calls.some(c=>['/api/session','/api/state'].includes(c.path)||c.method==='DELETE'));
  state.config.hrInboxRunning=true;
  tabs.onActivated.fire({tabId:1,windowId:1});
  await sleepUntil(()=>pages.length===1&&pokes.some(poke=>poke.id===pages[0].id));
  const page=pages[0];
  assert.equal(page.url,chat);
  assert.equal(page.active,false);
  assert(!calls.some(c=>c.path==='/api/work'));
  const selected=await worker.receiveMessage({type:'chatMonitor'},sender(page));
  assert.deepEqual(selected,{ok:true,result:{monitor:true,tabId:page.id}});
  const result=await worker.receiveMessage({type:'api',path:'/api/heartbeat',data:{diagnostics:{fixture:true}}},sender(page));
  assert(result.ok);
  assert(calls.find(c=>c.path==='/api/heartbeat').data.diagnostics.extensionVersion);
  worker.close();
  assert.equal(tabs.onActivated.size(),0);
  assert.equal(tabs.onUpdated.size(),0);
  assert.equal(tabs.onRemoved.size(),0);
  tabs.onActivated.fire({tabId:1,windowId:1});
  assert.equal((await worker.receiveMessage({type:'chatMonitor'},sender(page))).ok,false);
});

test('已选监听标签关闭时独立恢复，不等待已卡住的招呼生成或抢占当前页面',async t=>{
  const {state,worker,tabs,pages,pokes,calls,holdWork}=await fixture(t);
  await sleepUntil(()=>calls.some(c=>c.path==='/api/worker-health'));
  const monitor=await tabs.create({url:chat,active:false});
  const ownerPage=await tabs.create({url:job.url,active:true});
  const unrelated=await tabs.create({url:chat+'?unrelated',active:false});
  assert.equal((await worker.receiveMessage({type:'chatMonitor'},sender(monitor))).result.tabId,monitor.id);
  state.config.jobSearchRunning=true;state.config.hrInboxRunning=true;
  const release=holdWork();
  try{
    tabs.onActivated.fire({tabId:ownerPage.id,windowId:1});
    await sleepUntil(()=>calls.some(c=>c.path==='/api/work'));
    const stateCalls=calls.filter(c=>c.path==='/api/browser-state').length;
    await tabs.remove(unrelated.id,{isWindowClosing:false});await wait(30);
    assert.equal(calls.filter(c=>c.path==='/api/browser-state').length,stateCalls,'非监听标签不应触发恢复');
    await tabs.remove(monitor.id,{isWindowClosing:false});
    tabs.onActivated.fire({tabId:ownerPage.id,windowId:1});
    await sleepUntil(()=>pages.some(p=>p.url===chat&&p.id!==monitor.id)&&pokes.some(p=>p.id!==monitor.id));
    const restored=pages.find(p=>p.url===chat);
    assert.equal(restored.active,false);
    assert.equal(ownerPage.active,true);
    assert.equal(pages.filter(p=>p.url===chat).length,1);
    assert.equal(calls.filter(c=>c.path==='/api/work').length,1,'独立恢复不会重启挂起的招呼任务');
    assert.equal((await worker.receiveMessage({type:'chatMonitor'},sender(restored))).result.tabId,restored.id);
  }finally{release();}
});

test('内嵌后台等待岗位任务时停用自主求职，保留活动页面与HR监听',async t=>{
  const {state,tabs,pages,pokes,calls,responses}=await fixture(t);
  await sleepUntil(()=>calls.some(c=>c.path==='/api/worker-health'));
  const monitor=await tabs.create({url:chat,active:false});
  const ownerPage=await tabs.create({url:'https://www.zhipin.com/web/geek/job?query=owner',active:true});
  const expectedURL=ownerPage.url;
  Object.assign(state.config,{jobSearchRunning:true,hrInboxRunning:true,autoBrowse:true,crawlEnabled:true});
  state.search={id:'old-search',url:'https://www.zhipin.com/web/geek/job?query=old'};
  const pending=Promise.withResolvers(),healthCount=calls.filter(call=>call.path==='/api/worker-health').length;
  responses.set('/api/work',async()=>{await pending.promise;return {value:{task:null}};});
  try{
    tabs.onActivated.fire({tabId:ownerPage.id,windowId:1});
    await sleepUntil(()=>calls.some(call=>call.path==='/api/work'));
    assert(pokes.some(poke=>poke.id===monitor.id));
    state.config.jobSearchRunning=false;delete state.search;
    pending.resolve();
    await sleepUntil(()=>calls.filter(call=>call.path==='/api/worker-health').length>healthCount);
    assert.deepEqual(pages.map(tab=>[tab.url,tab.active]),[[chat,false],[expectedURL,true]]);
    assert(!calls.some(call=>['/api/claim','/api/crawl/next'].includes(call.path)));
  }finally{pending.resolve();}
});

test('自主求职关闭时，明确招呼委托只读取指定在库岗位，再执行同一委托',async t=>{
  const {state,worker,tabs,pages,pokes,calls,responses}=await fixture(t);
  await sleepUntil(()=>calls.some(c=>c.path==='/api/worker-health'));
  const ownerPage=await tabs.create({url:'https://www.zhipin.com/web/geek/job?query=owner',active:true});
  const originalURL=ownerPage.url;
  const monitor=await tabs.create({url:chat,active:false});
  const plan={id:'fixture-owner-plan',scope:'owner',automatic:false};
  const detail={id:'fixture-job',url:job.url,lease:'fixture-crawl-lease'};
  let ready=false;
  Object.assign(state.config,{hrInboxRunning:true,ownerGreeting:plan,autoBrowse:true,crawlEnabled:true});
  state.search={id:'unrelated-search',url:'https://www.zhipin.com/web/geek/job?query=unrelated'};
  responses.set('/api/work',async()=>({value:{task:ready?{id:'fixture-greeting',job,greetingPlanId:plan.id}:null}}));
  responses.set('/api/crawl/next',async data=>{
    assert.deepEqual(data,{ownerGreetingPlanId:plan.id,ownerGreetingReadRevision:0});
    return {value:{job:detail}};
  });
  responses.set('/api/crawl/complete',async data=>{
    assert.deepEqual([data.id,data.lease,data.url],[detail.id,detail.lease,detail.url]);
    ready=true;
    return {value:{ok:true}};
  });
  const wake=()=>tabs.onActivated.fire({tabId:ownerPage.id,windowId:1});
  const doneCount=()=>calls.filter(c=>c.path==='/api/worker-health').length;
  let done=doneCount();wake();await sleepUntil(()=>doneCount()>done);
  const detailPage=pages.find(tab=>tab.url===detail.url);
  assert(detailPage);assert.equal(detailPage.active,false);
  assert(pokes.some(poke=>poke.id===monitor.id));
  assert.deepEqual([ownerPage.url,ownerPage.active],[originalURL,true]);
  assert(!calls.some(call=>call.path.startsWith('/api/favorites')));
  assert(!pages.some(tab=>tab.url===state.search.url));
  assert.equal((await worker.receiveMessage({type:'crawlWorker'},sender(ownerPage))).result,null);
  done=doneCount();wake();await sleepUntil(()=>doneCount()>done);
  assert.equal(calls.filter(c=>c.path==='/api/crawl/next').length,1);
  const {result:crawl}=await worker.receiveMessage({type:'crawlWorker'},sender(detailPage));
  assert.deepEqual([crawl.jobId,crawl.lease,crawl.ownerGreetingPlanId],[detail.id,detail.lease,plan.id]);
  assert((await worker.receiveMessage({type:'api',path:'/api/crawl/complete',data:{id:crawl.jobId,lease:crawl.lease,url:detail.url,success:true}},sender(detailPage))).ok);
  assert((await worker.receiveMessage({type:'crawlDone'},sender(detailPage))).ok);
  assert(!pages.some(tab=>tab.id===detailPage.id));
  done=doneCount();wake();await sleepUntil(()=>doneCount()>done);
  assert(pages.some(tab=>tab.url===detail.url&&tab.id!==detailPage.id&&tab.active===false));
});

test('监听恢复使用最新开关和账号状态，关闭整窗时不唤醒服务',async t=>{
  const {state,tabs,pages,calls}=await fixture(t);
  await sleepUntil(()=>calls.some(c=>c.path==='/api/worker-health'));
  for(const [index,blocked] of ['paused','read-disabled','account','window-close'].entries()){
    state.config.hrInboxRunning=true;state.config.chatRead=true;delete state.accountRecheck;
    const healthCalls=calls.filter(c=>c.path==='/api/worker-health').length;
    tabs.onActivated.fire({tabId:1,windowId:1});
    await sleepUntil(()=>calls.filter(c=>c.path==='/api/worker-health').length>healthCalls&&pages.some(p=>p.url===chat));
    const current=pages.find(p=>p.url===chat),stateCalls=calls.filter(c=>c.path==='/api/browser-state').length;
    if(blocked==='paused')state.config.hrInboxRunning=false;
    if(blocked==='read-disabled')state.config.chatRead=false;
    if(blocked==='account')state.accountRecheck={required:true};
    await tabs.remove(current.id,{isWindowClosing:blocked==='window-close'});
    if(blocked!=='window-close')await sleepUntil(()=>calls.filter(c=>c.path==='/api/browser-state').length>stateCalls);
    await wait(30);
    assert.equal(calls.filter(c=>c.path==='/api/browser-state').length,stateCalls+(blocked==='window-close'?0:1),`${index} ${blocked}`);
    assert.equal(pages.length,0,blocked);
  }
});

test('先接续已有聊天页，关闭恢复与常规唤醒并发时只打开一个后台页',async t=>{
  const {state,worker,tabs,pages,pokes,calls}=await fixture(t);
  await sleepUntil(()=>calls.some(c=>c.path==='/api/worker-health'));
  const monitor=await tabs.create({url:chat,active:false});
  const ownerPage=await tabs.create({url:job.url,active:true});
  const standby=await tabs.create({url:chat+'?standby',active:false});
  assert.equal((await worker.receiveMessage({type:'chatMonitor'},sender(monitor))).result.tabId,monitor.id);
  state.config.hrInboxRunning=true;
  await tabs.remove(monitor.id,{isWindowClosing:false});
  await sleepUntil(()=>pokes.some(poke=>poke.id===standby.id));
  assert.equal(pages.length,2);
  assert.equal((await worker.receiveMessage({type:'chatMonitor'},sender(standby))).result.tabId,standby.id);

  let release,opens=0;
  const gate=new Promise(resolve=>{release=resolve;}),create=tabs.create;
  tabs.create=async details=>{opens++;await gate;return create(details);};
  try{
    const stateCalls=calls.filter(c=>c.path==='/api/browser-state').length;
    await tabs.remove(standby.id,{isWindowClosing:false});
    await sleepUntil(()=>opens===1);
    tabs.onActivated.fire({tabId:ownerPage.id,windowId:1});
    await sleepUntil(()=>calls.filter(c=>c.path==='/api/browser-state').length>=stateCalls+2);
    await wait(30);
    assert.equal(opens,1);
  }finally{release();}
  await sleepUntil(()=>pages.some(p=>p.url===chat));
  assert.equal(pages.filter(p=>p.url===chat).length,1);
  assert.equal(pages.find(p=>p.url===chat).active,false);
  assert.equal(ownerPage.active,true);
});

test('仅监听页面崩溃时移交，优先保留正在加载的候选，不刷新原页面或处理旧发送',async t=>{
  const {state,worker,tabs,pages,pokes,calls,reloads,holdWork}=await fixture(t);
  await sleepUntil(()=>calls.some(c=>c.path==='/api/worker-health'));
  const monitor=await tabs.create({url:chat,active:false});
  const ownerPage=await tabs.create({url:job.url,active:true});
  const standby=await tabs.create({url:chat+'?standby',active:false,status:'loading',ready:false});
  const unrelated=await tabs.create({url:job.url+'?unrelated',active:false});
  assert.equal((await worker.receiveMessage({type:'chatMonitor'},sender(monitor))).result.tabId,monitor.id);
  state.config.jobSearchRunning=true;state.config.hrInboxRunning=true;
  const release=holdWork();
  function crash(tab){tab.unavailable=true;tab.ready=false;tabs.onUpdated.fire(tab.id,{unavailable:true},{...tab});}
  try{
    tabs.onActivated.fire({tabId:ownerPage.id,windowId:1});
    await sleepUntil(()=>calls.some(c=>c.path==='/api/work'));
    const stateCalls=calls.filter(c=>c.path==='/api/browser-state').length;
    crash(unrelated);await wait(30);
    assert.equal(calls.filter(c=>c.path==='/api/browser-state').length,stateCalls);
    crash(monitor);await sleepUntil(()=>pokes.some(poke=>poke.id===standby.id));
    assert.equal(pages.length,4,'正在加载的已有聊天仍应复用');
    assert.equal((await worker.receiveMessage({type:'chatMonitor'},sender(standby))).result.tabId,standby.id);
    crash(standby);crash(standby);
    await sleepUntil(()=>pages.some(p=>p.url===chat&&p.id!==monitor.id));
    const replacement=pages.find(p=>p.url===chat&&p.id!==monitor.id);
    assert.equal(replacement.active,false);
    assert.equal(ownerPage.active,true);
    assert.equal(pages.filter(p=>p.url===chat&&!p.unavailable).length,1);
    assert.equal(pages.find(p=>p.id===monitor.id).unavailable,true);
    assert.equal(pages.find(p=>p.id===standby.id).unavailable,true);
    assert.equal((await worker.receiveMessage({type:'chatMonitor'},sender(replacement))).result.tabId,replacement.id);
    assert.deepEqual(reloads,[]);
    assert(!calls.some(c=>['/api/claim','/api/complete'].includes(c.path)));
    assert.equal(calls.filter(c=>c.path==='/api/work').length,1);
  }finally{release();}
});

test('监听页面导航到已确认职位或收藏后独立恢复，保留所选页面，跳过加载、登录、验证和过时的回传',async t=>{
  const {state,worker,tabs,pages,pokes,calls,reloads,holdWork}=await fixture(t);
  await sleepUntil(()=>calls.some(c=>c.path==='/api/worker-health'));
  const monitor=await tabs.create({url:chat,active:true});
  const favorites='https://www.zhipin.com/web/geek/recommend?tab=4';
  const login='https://www.zhipin.com/web/user/';
  assert.equal((await worker.receiveMessage({type:'chatMonitor'},sender(monitor))).result.tabId,monitor.id);
  state.config.jobSearchRunning=true;state.config.hrInboxRunning=true;
  const release=holdWork();
  const navigate=(url,status='complete')=>{
    monitor.url=url;monitor.status=status;tabs.onUpdated.fire(monitor.id,{status},{...monitor});
  };
  const probes=()=>pokes.filter(p=>p.id===monitor.id&&p.msg.command==='monitor-destination').length;
  try{
    tabs.onActivated.fire({tabId:monitor.id,windowId:1});
    await sleepUntil(()=>calls.some(c=>c.path==='/api/work'));
    navigate(favorites,'loading');await wait(30);
    assert.equal(probes(),0);
    assert.equal(pages.length,1);
    navigate(login);
    await sleepUntil(()=>calls.some(c=>c.path==='/api/heartbeat'&&c.data.accountSignal==='login-navigation'));
    assert.equal(probes(),0);
    assert.equal(pages.length,1);
    monitor.destinationClear=false;navigate(favorites);
    await sleepUntil(()=>probes()===1);await wait(30);
    assert.equal(pages.length,1,'验证页面保留给用户，不能另开聊天绕过');

    monitor.destinationClear=true;
    let changed=false;
    const send=tabs.sendMessage;
    tabs.sendMessage=async(id,msg)=>{
      const reply=await send(id,msg);
      if(id===monitor.id&&msg.command==='monitor-destination'&&!changed){
        changed=true;monitor.url=job.url;monitor.status='loading';
      }
      return reply;
    };
    navigate(favorites);await sleepUntil(()=>changed);await wait(30);
    assert.equal(pages.length,1,'前一次导航回传不能接续已改变的页面');
    state.accountRecheck={required:true};navigate(job.url);
    const stateCalls=calls.filter(c=>c.path==='/api/browser-state').length;
    await sleepUntil(()=>calls.filter(c=>c.path==='/api/browser-state').length>stateCalls);await wait(30);
    assert.equal(pages.length,1);
    delete state.accountRecheck;navigate(favorites);
    await sleepUntil(()=>pages.some(p=>p.id!==monitor.id&&p.url===chat));
    const replacement=pages.find(p=>p.id!==monitor.id&&p.url===chat);
    assert.equal(replacement.active,false);
    assert.equal(monitor.url,favorites);
    assert.equal(monitor.active,true);
    assert.equal((await worker.receiveMessage({type:'chatMonitor'},sender(replacement))).result.tabId,replacement.id);
    assert.deepEqual(reloads,[]);
    assert.equal(calls.filter(c=>c.path==='/api/work').length,1);
    assert(!calls.some(c=>['/api/claim','/api/complete'].includes(c.path)));
  }finally{release();}
});

test('崩溃只将对应标签的精确租约置为待核对，正在提交的真实回执优先',async t=>{
  const {worker,tabs,calls,responses}=await fixture(t);
  await sleepUntil(()=>calls.some(c=>c.path==='/api/worker-health'));
  const first=await tabs.create({url:chat,active:false}),second=await tabs.create({url:chat+'?second',active:false});
  const input=id=>({id,lease:'lease-'+id});
  const request=(tab,path,data)=>worker.receiveMessage({type:'api',path,data},sender(tab));
  const completed=()=>calls.filter(call=>call.path==='/api/complete').map(call=>call.data);
  responses.set('/api/claim',async data=>({value:{task:{id:data.id,kind:'followup',status:'executing',reservedAt:Date.now()},lease:input(data.id).lease}}));
  responses.set('/api/complete',async data=>({value:{ok:true,executionStatus:data.success?'sent':'uncertain'}}));
  function crash(tab){tab.unavailable=true;tabs.onUpdated.fire(tab.id,{unavailable:true},{...tab});}
  assert((await request(first,'/api/claim',{id:'exact'})).ok);
  crash(second);await wait(30);assert.deepEqual(completed(),[]);
  crash(first);crash(first);
  await sleepUntil(()=>completed().length===1);
  assert.deepEqual(completed().map(({evidence,...rest})=>rest),[{...input('exact'),success:false}]);
  assert.match(completed()[0].evidence,/待核对/);

  await wait(20);
  first.unavailable=false;
  assert((await request(first,'/api/claim',{id:'verified'})).ok);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  responses.set('/api/complete',async data=>{await gate;return {value:{ok:true,executionStatus:data.success?'sent':'uncertain'}};});
  try{
    const verified=request(first,'/api/complete',{...input('verified'),success:true,evidence:'合成回执'});
    await sleepUntil(()=>completed().length===2);crash(first);await wait(30);
    assert.equal(completed().length,2,'已收到的真实回执正在提交，崩溃不能抢先覆盖');
    release();assert.equal((await verified).result.executionStatus,'sent');
    await wait(30);assert.equal(completed().length,2);
    assert.deepEqual(completed()[1],{...input('verified'),success:true,evidence:'合成回执'});
  }finally{release();}
});

test('领取回传慢于崩溃和重载时仍只结束原领取，已撤销租约由服务拒绝',async t=>{
  const {worker,tabs,calls,responses}=await fixture(t);
  await sleepUntil(()=>calls.some(c=>c.path==='/api/worker-health'));
  const tab=await tabs.create({url:chat,active:false});
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  responses.set('/api/claim',async data=>{
    await gate;return {value:{task:{id:data.id,kind:'reply',status:'executing',reservedAt:Date.now()},lease:'revoked-fixture-lease'}};
  });
  responses.set('/api/complete',async()=>({status:409,value:{error:'账号待核对，原租约已撤销'}}));
  try{
    const result=worker.receiveMessage({type:'api',path:'/api/claim',data:{id:'before-crash'}},sender(tab));
    await sleepUntil(()=>calls.some(c=>c.path==='/api/claim'));
    tab.unavailable=true;tabs.onUpdated.fire(tab.id,{unavailable:true},{...tab});
    tab.unavailable=false;tabs.onUpdated.fire(tab.id,{status:'complete'},{...tab});
    release();assert((await result).ok);
    await sleepUntil(()=>calls.some(c=>c.path==='/api/complete'));
    const completions=calls.filter(c=>c.path==='/api/complete');
    assert.equal(completions.length,1);
    assert.equal(completions[0].data.id,'before-crash');
    assert.equal(completions[0].data.lease,'revoked-fixture-lease');
    assert.equal(completions[0].data.success,false);
  }finally{release();}
});

test('内嵌后台复用原岗位页到聊天子标签的执行凭据核对，只有接续后的页面崩溃才能结束原租约',async t=>{
  const {state,worker,tabs,pages,pokes,calls,responses}=await fixture(t);
  state.config.jobSearchRunning=true;
  await sleepUntil(()=>pages.length===1&&calls.some(c=>c.path==='/api/worker-health'));
  const jobTab=pages[0];
  assert.equal(jobTab.url,job.url);
  const before=await worker.receiveMessage({type:'worker'},sender(jobTab));
  assert.equal(before.result.taskId,'fixture-greeting');
  const claimed={id:'fixture-greeting',lease:'fixture-only',task:{id:'fixture-greeting',kind:'greeting',job}};
  responses.set('/api/claim',async()=>({value:{...claimed,task:{...claimed.task,status:'executing',reservedAt:Date.now()}}}));
  assert((await worker.receiveMessage({type:'api',path:'/api/claim',data:{id:claimed.id}},sender(jobTab))).ok);
  assert((await worker.receiveMessage({type:'saveClaim',claimed},sender(jobTab))).ok);
  const unrelated=await tabs.create({url:chat,active:true});
  const unclaimed=await worker.receiveMessage({type:'worker'},sender(unrelated));
  assert.equal(unclaimed.result,null);
  const child=await tabs.create({url:chat,active:false,openerTabId:jobTab.id});
  const handoff=await worker.receiveMessage({type:'worker'},sender(child));
  assert.equal(handoff.result.tabId,child.id);
  assert.equal(handoff.result.sourceTabId,jobTab.id);
  assert.equal(handoff.result.claimed.lease,'fixture-only');
  assert.deepEqual(calls.find(c=>c.path==='/api/check').data,{id:claimed.id,lease:claimed.lease});
  assert(pokes.some(poke=>poke.id===child.id&&poke.msg.command==='tick'));
  assert(!calls.some(c=>c.path==='/api/complete'));
  const claimInput={id:claimed.id,lease:claimed.lease};
  const checkCount=calls.filter(c=>c.path==='/api/check').length;
  const checkFrom=tab=>worker.receiveMessage({type:'api',path:'/api/check',data:claimInput},sender(tab));
  assert.deepEqual(await checkFrom(jobTab),{ok:true,result:{allowed:false}});
  assert.deepEqual(await checkFrom(unrelated),{ok:true,result:{allowed:false}});
  assert.equal(calls.filter(c=>c.path==='/api/check').length,checkCount);
  const staleCompletion=await worker.receiveMessage({type:'api',path:'/api/complete',data:{...claimInput,success:false,evidence:'过期原页面'}},sender(jobTab));
  assert.equal(staleCompletion.ok,false);
  assert.match(staleCompletion.error,/已接续到另一个页面/);
  assert(!calls.some(c=>c.path==='/api/complete'));
  assert.deepEqual(await checkFrom(child),{ok:true,result:{allowed:true}});
  jobTab.unavailable=true;tabs.onUpdated.fire(jobTab.id,{unavailable:true},jobTab);await wait(30);
  assert(!calls.some(c=>c.path==='/api/complete'),'原岗位页的崩溃不能结束已交给子页的租约');
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  responses.set('/api/complete',async()=>{await gate;return {value:{executionStatus:'uncertain'}};});
  try{
    child.unavailable=true;tabs.onUpdated.fire(child.id,{unavailable:true},child);
    await sleepUntil(()=>calls.some(c=>c.path==='/api/complete'));
    await tabs.remove(child.id,{isWindowClosing:false});await wait(30);
    const completed=calls.filter(c=>c.path==='/api/complete');
    assert.equal(completed.length,1,'崩溃回执在提交时，再关闭该页也不能另行结束租约');
    assert.deepEqual({...completed[0].data,evidence:''},{id:claimed.id,lease:claimed.lease,success:false,evidence:''});
  }finally{release();}
});
