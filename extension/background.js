const BASE='http://127.0.0.1:17321';
const jobRunning=state=>typeof state.config?.jobSearchRunning==='boolean'?state.config.jobSearchRunning:!!(state.running??state.config?.running);
const hrRunning=state=>typeof state.config?.hrInboxRunning==='boolean'?state.config.hrInboxRunning:!!(state.running??state.config?.running);
const manualChat=state=>!!(state.config?.ownerChat||state.config?.ownerGreeting&&state.config.ownerGreeting.automatic!==true||['selecting','ready','executing'].includes(state.config?.singleTest?.status)||state.config?.hrInboxRunning===undefined&&state.config?.readingEnabled);
const greetingEnabled=(state,worker)=>jobRunning(state)||!!(state.config?.ownerGreeting&&(!worker?.greetingPlanId||state.config.ownerGreeting.id===worker.greetingPlanId));
const canBrowseJobs=state=>!state.accountRecheck?.required&&jobRunning(state)&&state.config.autoBrowse!==false&&state.config.crawlEnabled!==false&&!state.config.ownerBusy&&!state.config.ownerChat;
function ownerGreetingReadScope(state){
 const plan=state.config?.ownerGreeting;
 return !state.accountRecheck?.required&&plan?.automatic===false?{ownerGreetingPlanId:plan.id,ownerGreetingReadRevision:plan.readRevision??0}:null;
}
function canReadCrawler(state,crawler){
 if(state.accountRecheck?.required)return false;
 if(!crawler.ownerGreetingPlanId)return jobRunning(state);
 const scope=ownerGreetingReadScope(state);
 return scope?.ownerGreetingPlanId===crawler.ownerGreetingPlanId&&scope.ownerGreetingReadRevision===(crawler.ownerGreetingReadRevision??0);
}
function canOpenGreeting(state,task){
 if(state.accountRecheck?.required)return false;
 const plan=state.config.ownerGreeting;
 return task.greetingPlanId?plan?.id===task.greetingPlanId&&(jobRunning(state)||plan.automatic!==true):jobRunning(state);
}
const paths=new Set(['/api/browser-state','/api/heartbeat','/api/observe','/api/prepare','/api/replies/enqueue','/api/replies/state','/api/tasks','/api/claim','/api/check','/api/complete','/api/work','/api/worker/fail','/api/stop','/api/inspection','/api/jobs/observe','/api/crawl/next','/api/crawl/complete','/api/single-test/prepare','/api/single-test/fail','/api/chat/resolve','/api/chat/history','/api/chat/job/start','/api/chat/job/complete','/api/owner-chat/prepare','/api/owner-chat/fail','/api/greetings/target','/api/worker-health','/api/search/observed','/api/favorites/state','/api/favorites/observe','/api/favorites/fail']);
const jobURL=value=>{try{const u=new URL(value);return u.origin==='https://www.zhipin.com'&&/^\/job_detail\/[\w-]+\.html$/.test(u.pathname)?u.origin+u.pathname:'';}catch{return '';}};
const chatPage=value=>{try{const u=new URL(value);return u.origin==='https://www.zhipin.com'&&/^\/web\/geek\/chat\/?$/.test(u.pathname);}catch{return false;}};
const bossPage=value=>{try{const u=new URL(value);return u.origin==='https://www.zhipin.com'&&!u.username&&!u.password?u.origin+u.pathname:'';}catch{return '';}};
const loginPage=value=>/^https:\/\/www\.zhipin\.com\/web\/user\/?$/.test(bossPage(value));
const monitorDeparture=value=>!!bossPage(value)&&(/^https:\/\/www\.zhipin\.com\/web\/geek\/(?:job|jobs|recommend)\/?$/.test(bossPage(value))||!!jobURL(value));
function fromCrawlerTab(crawler,sender){
 return crawler&&crawler.tabId===sender.tab?.id&&!(sender.frameId>0)&&(!crawler.url||jobURL(sender.url)===jobURL(crawler.url));
}
async function releaseCrawler(crawler,observedURL=''){
 const {crawler:current}=await chrome.storage.session.get('crawler');
 if(current?.tabId!==crawler.tabId||current?.lease!==crawler.lease)return;
 await chrome.storage.session.remove('crawler');
 const tab=await chrome.tabs.get(crawler.tabId).catch(()=>null);
 const url=jobURL(crawler.url)||observedURL;
 if(tab&&tab.active!==true&&url&&jobURL(tab.url)===url)await chrome.tabs.remove?.(tab.id)?.catch(()=>{});
}
async function monitorTab(tabs){
 const candidates=tabs.filter(t=>chatPage(t.url)&&t.automation!=='greeting'&&t.unavailable!==true),{chatMonitorTabId}=await chrome.storage.session.get('chatMonitorTabId');
 const chosen=candidates.find(t=>t.id===chatMonitorTabId)||candidates.find(t=>t.active)||candidates[0];
 if(chosen&&chosen.id!==chatMonitorTabId)await chrome.storage.session.set({chatMonitorTabId:chosen.id});
 return chosen;
}
async function pokeChat(tab){if(tab)await chrome.tabs.sendMessage(tab.id,{type:'assistant-read',command:'tick'}).catch(()=>{});}
async function releaseWorker(worker){const current=(await chrome.storage.session.get('worker')).worker;if(current&&current.taskId===worker.taskId&&current.tabId===worker.tabId&&current.at===worker.at)await chrome.storage.session.remove('worker');}
const validClaim=worker=>!!(worker?.claimed?.lease&&worker.claimed.id===worker.taskId&&worker.claimed.task?.id===worker.taskId&&worker.claimed.task?.kind==='greeting'&&jobURL(worker.claimed.task.job?.url)&&jobURL(worker.claimed.task.job.url)===jobURL(worker.job?.url));
const nativeClaims=new Map(),nativeCrashes=new Map(),embeddedRuntime=chrome.runtime.id==='xiaojing-embedded';
const matchesClaim=(record,input)=>!!(record&&record.id===input?.id&&record.lease===input.lease);
function completeNativeClaim(record,data,method){
 if(record.completing)return record.completing;
 const flight=api('/api/complete',data,method).then(result=>{
  if(!record.crashed&&nativeClaims.get(record.tabId)===record)nativeClaims.delete(record.tabId);
  return result;
 }).finally(()=>{if(record.completing===flight)record.completing=null;});
 record.completing=flight;return flight;
}
async function settleCrashedClaim(tabId,record=nativeClaims.get(tabId)){
 if(!record||record.crashed||nativeClaims.get(tabId)!==record)return;
 record.crashed=true;
 try{
  // A genuine receipt already accepted by the worker gets the first attempt.
  if(record.completing){try{await record.completing;return;}catch{}}
  if(nativeClaims.get(tabId)!==record)return;
  await completeNativeClaim(record,{id:record.id,lease:record.lease,success:false,evidence:'站内执行页面已退出，未能核对本次回执，结果待核对'});
 }catch{/* The server may already have revoked or finalized this exact lease. */}
 finally{
  try{
   if(record.kind==='greeting'){
    const {worker}=await chrome.storage.session.get('worker');
    if(worker?.tabId===tabId&&worker.taskId===record.id&&(!worker.claimed||matchesClaim(record,worker.claimed)))await releaseWorker(worker);
   }
  }finally{if(nativeClaims.get(tabId)===record)nativeClaims.delete(tabId);}
 }
}
async function rememberNativeClaim(sender,input,result,crashMark){
 const task=result.task,tabId=sender.tab?.id;
 if(!embeddedRuntime||!Number.isSafeInteger(tabId)||task?.status!=='executing'||task.id!==input?.id||!Number.isFinite(task.reservedAt)||typeof result.lease!=='string'||!result.lease)return;
 const previous=nativeClaims.get(tabId);
 if(previous&&previous.reservedAt>=task.reservedAt)return;
 const record={id:task.id,lease:result.lease,kind:task.kind,reservedAt:task.reservedAt,tabId};
 nativeClaims.set(tabId,record);
 const tab=await chrome.tabs.get(tabId).catch(()=>null);
 if(!tab||tab.unavailable===true||nativeCrashes.get(tabId)!==crashMark)void settleCrashedClaim(tabId,record).catch(()=>{});
}
let verifiedGreeting=null,lastGreetingReceipt=null,externalReadTab=null;
const taskTab=(url,kind)=>chrome.tabs.createAutomation?chrome.tabs.createAutomation({url,kind}):chrome.tabs.create({url,active:false});
async function openReadTab(read,url){
 const tab=await taskTab(url,'chat-job');read.tabId=tab.id;read.detailURL=url;read.created=true;
 if(!chrome.tabs.removeAutomation)externalReadTab={id:tab.id,selected:tab.active===true};
}
async function closeReadTab(read){
 const external=externalReadTab?.id===read.tabId?externalReadTab:null;
 const tab=await chrome.tabs.get(read.tabId).catch(()=>null);
 if(!tab||tab.active===true||jobURL(tab.url)!==read.detailURL)return;
 if(chrome.tabs.removeAutomation)await chrome.tabs.removeAutomation(tab.id,{kind:'chat-job',url:tab.url});
 else if(external&&externalReadTab===external&&!external.selected)await chrome.tabs.remove(tab.id);
}
async function releaseReadTab(read){
 const {chatJob:current}=await chrome.storage.session.get('chatJob');
 if(!current||current.requestId!==read.requestId||current.at!==read.at)return false;
 await chrome.storage.session.remove('chatJob');return true;
}
async function closeGreetingSource(worker){
 const tab=await chrome.tabs.get(worker.sourceTabId).catch(()=>null);
 if(tab&&jobURL(tab.url)===jobURL(worker.job.url))await chrome.tabs.removeAutomation(tab.id,{kind:'greeting',url:tab.url});
}
async function closePriorGreeting(prior){
 const {chatMonitorTabId}=await chrome.storage.session.get('chatMonitorTabId');
 if(prior.id!==chatMonitorTabId)await chrome.tabs.removeAutomation(prior.id,{kind:'greeting',url:prior.url,openerTabId:prior.openerTabId});
}
async function settleGreeting(worker,sender){
 const proof=verifiedGreeting;
 if(!proof||proof.taskId!==worker.taskId||proof.tabId!==worker.tabId||proof.at!==worker.at||proof.lease!==worker.claimed?.lease||!chatPage(sender.url)){
  await releaseWorker(worker);return;
 }
 verifiedGreeting=null;
 const prior=lastGreetingReceipt;
 lastGreetingReceipt={id:worker.tabId,url:sender.url,openerTabId:worker.sourceTabId};
 await releaseWorker(worker);
 if(prior&&prior.id!==worker.tabId)void closePriorGreeting(prior).catch(()=>{});
 if(worker.sourceTabId)void closeGreetingSource(worker).catch(()=>{});
}
let handoffFlight=null;
async function greetingWorker(){
 if(handoffFlight)return handoffFlight;
 handoffFlight=(async()=>{
  const {worker}=await chrome.storage.session.get('worker');
  if(!validClaim(worker)||worker.handoffAt||Date.now()-worker.at>=180000)return worker;
  const source=await chrome.tabs.get(worker.tabId).catch(()=>null);
  if(!source||source.unavailable===true||!(jobURL(source.url)===jobURL(worker.job.url)||chatPage(source.url)))return worker;
  const tabs=await chrome.tabs.query({url:'https://www.zhipin.com/*'}),children=tabs.filter(tab=>tab.id!==worker.tabId&&tab.openerTabId===worker.tabId&&tab.unavailable!==true&&chatPage(tab.url));
  // An opener relationship plus one live execution lease is the only handoff path.
  // Never adopt a pre-existing chat tab or guess between multiple children.
  if(children.length!==1)return worker;
  const check=await api('/api/check',{id:worker.claimed.id,lease:worker.claimed.lease});if(!check.allowed)return worker;
  const current=(await chrome.storage.session.get('worker')).worker;
  if(current?.taskId!==worker.taskId||current?.tabId!==worker.tabId||current.claimed?.lease!==worker.claimed.lease)return current;
  const next={...current,sourceTabId:current.tabId,tabId:children[0].id,handoffAt:Date.now()};
  const native=nativeClaims.get(current.tabId);
  if(matchesClaim(native,current.claimed)){
   if(native.crashed||native.completing)return current;
   nativeClaims.delete(current.tabId);native.tabId=next.tabId;nativeClaims.set(next.tabId,native);
  }
  await chrome.storage.session.set({worker:next});void pokeChat(children[0]);return next;
 })();
 try{return await handoffFlight;}finally{handoffFlight=null;}
}
async function failWorker(worker,reason){
 const crashed=nativeClaims.get(worker.tabId);
 if(crashed?.crashed&&crashed.id===worker.taskId&&(!worker.claimed||matchesClaim(crashed,worker.claimed)))return;
 try{
  if(validClaim(worker))await api('/api/complete',{id:worker.claimed.id,lease:worker.claimed.lease,success:false,evidence:reason+'；发送结果不明，未重新发送'});
  else await api('/api/worker/fail',{taskId:worker.taskId,reason});
 }catch(error){await chrome.storage.local.set?.({workerError:{at:Date.now(),phase:'清理已结束的岗位操作页',error:error.message,taskId:worker.taskId}});}
 finally{await releaseWorker(worker);}
}
async function api(path,data,method) {
  if(!paths.has(path))throw Error('接口不被允许');
  const {token}=await chrome.storage.local.get('token');if(!token)throw Error('请先在扩展中粘贴本地配对码');
  if(path==='/api/heartbeat'&&data)data={...data,diagnostics:{extensionVersion:chrome.runtime.getManifest?.().version||'0.9.0',...data.diagnostics}};
  const r=await fetch(BASE+path,{method:method||(data?'POST':'GET'),headers:{'Content-Type':'application/json','X-Boss-Token':token},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(135000)});
  const v=await r.json();if(!r.ok)throw Error(v.error||'本地服务请求失败');return v;
}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  const own=sender.id===chrome.runtime.id;
  const allowed=own&&(!sender.tab||sender.url?.startsWith('https://www.zhipin.com/'));
  if(!allowed)return false;
  (async()=>{
    if(m.type==='api'){
      if(m.path!=='/api/heartbeat'){
        if(m.path==='/api/crawl/complete'){
          const {crawler}=await chrome.storage.session.get('crawler');
          if(crawler?.ownerGreetingPlanId&&(!fromCrawlerTab(crawler,sender)||crawler.jobId!==m.data?.id||crawler.lease!==m.data?.lease||jobURL(m.data?.url)!==jobURL(crawler.url)||!canReadCrawler(await api('/api/browser-state'),crawler)))throw Error('职位读取委托已变更或与当前页面不匹配');
        }
        const native=nativeClaims.get(sender.tab?.id);
        const ownsClaim=matchesClaim(native,m.data);
        if(m.path==='/api/check'||m.path==='/api/complete'){
          const belongsElsewhere=!ownsClaim&&[...nativeClaims.values()].some(record=>matchesClaim(record,m.data));
          if(m.path==='/api/check'&&(belongsElsewhere||ownsClaim&&native.crashed))return {allowed:false};
          if(belongsElsewhere)throw Error('发送任务已接续到另一个页面，原页面不能提交回执');
        }
        const crashMark=m.path==='/api/claim'?nativeCrashes.get(sender.tab?.id):undefined;
        const result=await (m.path==='/api/complete'&&ownsClaim?completeNativeClaim(native,m.data,m.method):api(m.path,m.data,m.method));
        if(m.path==='/api/claim')await rememberNativeClaim(sender,m.data,result,crashMark);
        if(m.path==='/api/complete'&&result.executionStatus==='sent'&&chrome.tabs.removeAutomation&&sender.tab&&chatPage(sender.url)){
          const {worker}=await chrome.storage.session.get('worker');
          if(validClaim(worker)&&worker.tabId===sender.tab.id&&worker.taskId===m.data?.id&&worker.claimed.lease===m.data.lease){
            verifiedGreeting={taskId:worker.taskId,tabId:worker.tabId,at:worker.at,lease:worker.claimed.lease};
          }
        }
        return result;
      }
      if(!sender.tab||sender.frameId>0)throw Error('页面状态必须来自 BOSS 顶层页面');
      const page=bossPage(sender.url),tab=await chrome.tabs.get(sender.tab.id);
      if(!page||bossPage(tab?.url)!==page)throw Error('BOSS 页面已经切换');
      const accountSignal=['sign-in-ui','chat-workspace'].includes(m.data?.accountSignal)?m.data.accountSignal:undefined;
      return api(m.path,{page,accountSignal,accountForeground:tab.active===true,diagnostics:m.data?.diagnostics},m.method);
    }
    if(m.type==='chatMonitor'){
      if(!sender.tab||!chatPage(sender.url))throw Error('只在BOSS聊天页建立消息监听');
      const tab=await monitorTab(await chrome.tabs.query({url:'https://www.zhipin.com/*'}));return {monitor:tab?.id===sender.tab.id,tabId:tab?.id||null};
    }
    if(m.type==='chatEvent'){
      if(!sender.tab||!chatPage(sender.url))throw Error('新消息信号必须来自BOSS聊天页');
      const state=await api('/api/browser-state');if(!hrRunning(state))return {paused:true};
      await chrome.storage.session.set({lastIncomingHint:{at:Date.now(),tabId:sender.tab.id,pending:Math.max(0,Number(m.pending)||0)}});
      await pokeChat(await monitorTab(await chrome.tabs.query({url:'https://www.zhipin.com/*'})));return {ok:true};
    }
    if(m.type==='worker'){
      const {worker:stored}=await chrome.storage.session.get('worker');
      const native=nativeClaims.get(sender.tab?.id);
      if(native?.crashed&&stored?.taskId===native.id)return null;
      if(stored){const state=await api('/api/browser-state');if(!greetingEnabled(state,stored)){
       if(validClaim(stored)&&Date.now()-stored.at<180000)return stored.tabId===sender.tab?.id?stored:null;
       await failWorker(stored,'自主求职已关闭，本次岗位任务停止');return null;
      }}
      const worker=await greetingWorker();return worker?.tabId===sender.tab?.id?worker:null;
    }
    if(m.type==='crawlWorker'){
      const {crawler}=await chrome.storage.session.get('crawler');if(!fromCrawlerTab(crawler,sender))return null;
      if(!canReadCrawler(await api('/api/browser-state'),crawler)){await releaseCrawler(crawler);return null;}
      return crawler;
    }
    if(m.type==='crawlDone'){const {crawler}=await chrome.storage.session.get('crawler');if(fromCrawlerTab(crawler,sender))await releaseCrawler(crawler,jobURL(sender.url));return {ok:true};}
    if(m.type==='chatJobOpen'){
      if(!sender.tab||!/^https:\/\/www\.zhipin\.com\/web\/geek\/chat(?:[?#]|$)/.test(sender.url||''))throw Error('只能从BOSS聊天页读取对应职位');
      const {chatJob}=await chrome.storage.session.get('chatJob');if(chatJob&&Date.now()-chatJob.at<45000)throw Error('已有职位正在读取');
      if(!m.read?.requestId||!m.read?.lease||!m.read?.peerId)throw Error('缺少职位读取关联');
      const tabs=await chrome.tabs.query({url:'https://www.zhipin.com/*'}),read={...m.read,sourceTabId:sender.tab.id,existingTabs:tabs.map(t=>t.id),at:Date.now()};
      if(m.url){const url=jobURL(m.url);if(!url||url!==jobURL(read.role.url))throw Error('职位链接与读取目标不符');await openReadTab(read,url);}
      await chrome.storage.session.set({chatJob:read});return {pending:!!read.tabId};
    }
    if(m.type==='chatJobFind'){
      const {chatJob:read}=await chrome.storage.session.get('chatJob');if(!read||read.sourceTabId!==sender.tab?.id||read.requestId!==m.requestId)return {};
      if(read.tabId)return {pending:true};
      const tabs=await chrome.tabs.query({url:'https://www.zhipin.com/*'}),matches=tabs.filter(t=>t.openerTabId===sender.tab.id&&!read.existingTabs.includes(t.id)&&jobURL(t.url));
      if(matches.length!==1)return {};
      const [tab]=matches;read.tabId=tab.id;await chrome.storage.session.set({chatJob:read});void pokeChat(tab);return {pending:true};
    }
    if(m.type==='chatJobNavigate'){
      const {chatJob:read}=await chrome.storage.session.get('chatJob'),url=jobURL(m.url);
      if(!read||read.sourceTabId!==sender.tab?.id||read.requestId!==m.requestId||!url||read.tabId)throw Error('职位打开目标不一致');
      await openReadTab(read,url);read.role.url=url;await chrome.storage.session.set({chatJob:read});return {pending:true};
    }
    if(m.type==='chatJobWorker'){
      const {chatJob:read}=await chrome.storage.session.get('chatJob');if(!read)return null;
      if(Date.now()-read.at>60000){
        await api('/api/chat/job/complete',{requestId:read.requestId,lease:read.lease,peerId:read.peerId,success:false,reason:'职位读取超时，未重试打开'}).catch(()=>{});
        if(await releaseReadTab(read)&&read.created)void closeReadTab(read).catch(()=>{});
        return null;
      }
      if(read.sourceTabId===sender.tab?.id&&jobURL(sender.url)&&!read.tabId){read.tabId=sender.tab.id;read.sameTab=true;await chrome.storage.session.set({chatJob:read});}
      return read.tabId===sender.tab?.id?read:null;
    }
    if(m.type==='chatJobRelease'){
      const {chatJob:read}=await chrome.storage.session.get('chatJob');if(read?.sourceTabId===sender.tab?.id&&read.requestId===m.requestId&&!read.tabId)await chrome.storage.session.remove('chatJob');return {};
    }
    if(m.type==='chatJobDone'){
      const {chatJob:read}=await chrome.storage.session.get('chatJob');
      if(read&&read.tabId===sender.tab?.id&&read.requestId===m.requestId&&await releaseReadTab(read)){
        if(read.created)await closeReadTab(read);
        else if(read.sameTab)await chrome.tabs.goBack?.(read.tabId);
      }return {};
    }
    if(m.type==='saveClaim') {
      const {worker}=await chrome.storage.session.get('worker');
      if(worker?.tabId!==sender.tab?.id)throw Error('岗位操作页不一致');
      const next={...worker,claimed:m.claimed};if(!validClaim(next))throw Error('招呼执行凭据与任务或岗位不一致');
      await chrome.storage.session.set({worker:next});return {ok:true};
    }
    if(m.type==='workerDone') {
      const {worker}=await chrome.storage.session.get('worker');
      if(worker&&worker.tabId===sender.tab?.id&&(!m.taskId||worker.taskId===m.taskId))await settleGreeting(worker,sender);
      return {ok:true};
    }
    throw Error('未知请求');
  })().then(result=>respond({ok:true,result})).catch(e=>respond({ok:false,error:e.message}));return true;
});
chrome.alarms.create('jobs',{periodInMinutes:0.5});
let opening=false;
const listPage=url=>{try{return /^\/web\/geek\/(?:job|jobs|recommend)$/.test(new URL(url).pathname);}catch{return false;}};
const favoriteURL=value=>{try{const u=new URL(value);return u.origin==='https://www.zhipin.com'&&/^\/web\/geek\//.test(u.pathname)&&!chatPage(u.href)&&!u.username&&!u.password?u.href:'';}catch{return '';}};
async function favoriteProbe(tab,allowNavigate=false){
 let timer;try{return await Promise.race([chrome.tabs.sendMessage(tab.id,{type:'assistant-read',command:'favorites-scan',allowNavigate}),new Promise(resolve=>{timer=setTimeout(()=>resolve({error:'收藏页面扫描暂未返回'}),6500);})]);}catch(e){return {error:e.message};}finally{if(timer&&typeof clearTimeout==='function')clearTimeout(timer);}
}
const favoriteResult=value=>value?.result||value||{};
async function rememberFavoriteProbe(worker,value){
 const probe=favoriteResult(value),current=(await chrome.storage.session.get('favoritesWorker')).favoritesWorker;
 if(!current||current.tabId!==worker.tabId||current.at!==worker.at)return false;
 current.lastProbeAt=Date.now();current.lastReason=String(probe.reason||probe.error||current.lastReason||'收藏页面尚未返回可确认的列表').slice(0,500);
 const deferred=probe.deferred==='human_active';
 if(deferred){current.deferredAt=Date.now();current.retryAt=Date.now()+15000;}
 await chrome.storage.session.set({favoritesWorker:current});
 await chrome.storage.local.set?.({favoriteScan:{status:deferred?'deferred':'scanning',reason:current.lastReason,at:Date.now(),url:current.url,retryAt:current.retryAt||0}});return deferred;
}
async function favoriteFinished(worker,status,reason=''){
 await chrome.storage.session.remove('favoritesWorker');
 await chrome.storage.local.set?.({favoriteScan:{status,reason,at:Date.now(),url:worker?.url||''}});
 const tab=worker?.owned?await chrome.tabs.get(worker.tabId).catch(()=>null):null;
 if(tab&&tab.active!==true&&favoriteURL(tab.url)===worker.url)await chrome.tabs.remove?.(tab.id)?.catch(()=>{});
}
async function browseFavorites(tabs){
 const snapshot=await api('/api/favorites/state'),saved=(await chrome.storage.session.get('favoritesWorker')).favoritesWorker;
 if(snapshot.enabled!==true){if(saved)await favoriteFinished(saved,'disabled');return false;}
 if(saved){
  const tab=await chrome.tabs.get(saved.tabId).catch(()=>null);
  if(snapshot.lastScanAt>=saved.at||!snapshot.due&&['observed','empty','scanned'].includes(snapshot.status)){await favoriteFinished(saved,snapshot.status||'observed');return false;}
  if(tab&&saved.deferredAt){if(saved.retryAt>Date.now())return false;saved.deferredMs=(saved.deferredMs||0)+Math.max(0,Date.now()-saved.deferredAt);delete saved.deferredAt;delete saved.retryAt;await chrome.storage.session.set({favoritesWorker:saved});}
  if(!tab||Date.now()-saved.at-(saved.deferredMs||0)>45000){const base=tab?'收藏页面45秒内未确认列表，不刷新重开':'收藏扫描页面已经关闭',reason=base+(saved.lastReason?'；最近扫描结果：'+saved.lastReason:'');await api('/api/favorites/fail',{phase:'scan',url:saved.url,reason,retryAt:Date.now()+300000});await favoriteFinished(saved,'unavailable',reason);return false;}
  if(tab.status==='loading'&&favoriteURL(tab.url)!==saved.url)return true;
  if(favoriteURL(tab.url)!==saved.url){const reason='收藏扫描页已离开来源导航，未继续操作';await api('/api/favorites/fail',{phase:'scan',url:saved.url,reason,retryAt:Date.now()+300000});await favoriteFinished(saved,'unavailable',reason);return false;}
  const deferred=await rememberFavoriteProbe(saved,await favoriteProbe(tab,tab.active!==true));return !deferred;
 }
 if(!snapshot.due)return false;
 // Keep new HR responses ahead of an optional collection scan. No tab focus is taken.
 const {lastIncomingHint}=await chrome.storage.session.get('lastIncomingHint');
 if(lastIncomingHint&&Date.now()-lastIncomingHint.at<30000)return false;
 let url=favoriteURL(snapshot.navigation?.url),navigation=snapshot.navigation;
 if(!url){
  const {favoriteDiscovery}=await chrome.storage.session.get('favoriteDiscovery');if(favoriteDiscovery?.retryAt>Date.now())return false;
  await chrome.storage.session.set({favoriteDiscovery:{at:Date.now(),retryAt:Date.now()+300000}});let probe={};
  const sources=tabs.filter(t=>listPage(t.url)||favoriteURL(t.url));
  const background=sources.filter(t=>t.active!==true),available=background.length?background:sources;
  const candidate=available.find(t=>listPage(t.url))||available[0];
  const source=candidate?await chrome.tabs.get(candidate.id).catch(()=>null):null;
  if(source&&source.url===candidate.url){probe=favoriteResult(await favoriteProbe(source,source.active!==true));if(probe.deferred==='human_active'){const reason=String(probe.reason||'检测到主人正在操作，收藏读取稍后继续').slice(0,500),retryAt=Date.now()+15000;await chrome.storage.session.set({favoriteDiscovery:{at:Date.now(),retryAt,lastReason:reason}});await chrome.storage.local.set?.({favoriteScan:{status:'deferred',reason,at:Date.now(),retryAt}});return false;}const discovered=await api('/api/favorites/state');if(['observed','empty','scanned'].includes(discovered.status)&&!discovered.due)return false;navigation=discovered.navigation;url=favoriteURL(navigation?.url);}
  if(!url){const base='当前可见导航未提供可核对的收藏入口，继续岗位搜索；不会猜测收藏网址',detail=String(probe.reason||probe.error||'').slice(0,500),reason=base+(detail?'；最近扫描结果：'+detail:'');await api('/api/favorites/fail',{phase:'discovery',reason,retryAt:Date.now()+300000});await chrome.storage.session.set({favoriteDiscovery:{at:Date.now(),retryAt:Date.now()+300000,lastReason:detail||base}});await chrome.storage.local.set?.({favoriteScan:{status:'unavailable',reason,at:Date.now()}});return false;}
 }
 const existing=tabs.find(t=>t.url===url);let tab=existing;
 if(!tab){
  const latest=await api('/api/browser-state');
  if(!canBrowseJobs(latest)||latest.favorites&&(latest.favorites.enabled!==true||latest.favorites.due!==true||favoriteURL(latest.favorites.navigation?.url)!==url))return true;
  tab=await chrome.tabs.create({url,active:false});
 }
 const worker={tabId:tab.id,url,at:Date.now(),owned:!existing,navigation};await chrome.storage.session.set({favoritesWorker:worker});
 await chrome.storage.local.set?.({favoriteScan:{status:'opening',at:worker.at,url}});void favoriteProbe(tab,false).then(result=>rememberFavoriteProbe(worker,result)).catch(()=>{});return true;
}
let ensuringChat=null;
async function ensureChat(state){
 if(state.accountRecheck?.required||(!hrRunning(state)&&!manualChat(state))||state.config.chatRead===false)return;
 if(ensuringChat)return ensuringChat;
 ensuringChat=(async()=>{
  const tabs=await chrome.tabs.query({url:'https://www.zhipin.com/*'});
  let tab=await monitorTab(tabs);
  if(!tab){tab=await chrome.tabs.create({url:'https://www.zhipin.com/web/geek/chat',active:false});await chrome.storage.session.set({chatMonitorTabId:tab.id});}
  if(state.config.ownerChat){const {focusedOwnerTarget}=await chrome.storage.session.get('focusedOwnerTarget');if(focusedOwnerTarget!==state.config.ownerChat.targetId){await chrome.tabs.update?.(tab.id,{active:true});await chrome.storage.session.set({focusedOwnerTarget:state.config.ownerChat.targetId});}}
  void pokeChat(tab);
 })();
 try{await ensuringChat;}finally{ensuringChat=null;}
}
async function restoreChatMonitor(id,departureURL){
 const {chatMonitorTabId}=await chrome.storage.session.get('chatMonitorTabId');
 if(chatMonitorTabId!==id&&!ensuringChat)return true;
 // A simultaneous tab setup may have selected the unavailable page. Wait for
 // that short flight only, without waiting for the separate job scheduler.
 await ensuringChat?.catch(()=>{});
 if((await chrome.storage.session.get('chatMonitorTabId')).chatMonitorTabId!==id)return true;
 if(departureURL){
  const result=await chrome.tabs.sendMessage(id,{type:'assistant-read',command:'monitor-destination'},{frameId:0}).catch(()=>null);
  const current=await chrome.tabs.get(id).catch(()=>null);
  if(result?.clear!==true||result.page!==bossPage(departureURL)||current?.url!==departureURL||current.status!=='complete'||current.unavailable)return false;
 }
 await ensureChat(await api('/api/browser-state'));
 return true;
}
async function crawl(scope){
 const {crawler}=await chrome.storage.session.get('crawler');
 if(crawler){
  const tab=await chrome.tabs.get(crawler.tabId).catch(()=>null);
  if(tab&&!tab.unavailable&&Date.now()-crawler.at<=180000)return true;
  await releaseCrawler(crawler);
 }
 const {job}=await api('/api/crawl/next',scope||{});
 if(!job)return false;
 const latest=await api('/api/browser-state');
 if(scope?!canReadCrawler(latest,scope)||latest.config.ownerBusy||latest.config.ownerChat:!canBrowseJobs(latest))return true;
 const url=jobURL(job.url);
 if(!url)return true;
 const tab=await chrome.tabs.create({url,active:false});
 await chrome.storage.session.set({crawler:{tabId:tab.id,jobId:job.id,lease:job.lease,url,at:Date.now(),...scope}});
 return true;
}
async function browse(state){
 if(!canBrowseJobs(state))return;
 const tabs=await chrome.tabs.query({url:'https://www.zhipin.com/*'});
 const favoriteSources=new Set([state.config.selectors?.favoriteCollectionURL,state.favorites?.navigation?.url].map(favoriteURL).filter(Boolean));
 const searchableList=tab=>listPage(tab.url)&&!favoriteSources.has(favoriteURL(tab.url));
 // Existing prepared sends run in work() first. Favorites precede only new
 // search navigation and new detail claims, and are bounded to one read-only tab.
 if(await browseFavorites(tabs))return;
 let searchedTab=null;
 if(state.search){
  const {lastSearch}=await chrome.storage.session.get('lastSearch');
  if(lastSearch?.id===state.search.id){searchedTab=await chrome.tabs.get(lastSearch.tabId).catch(()=>null);if(searchedTab&&!searchableList(searchedTab))searchedTab=null;if(searchedTab)void chrome.tabs.sendMessage(searchedTab.id,{type:'assistant-read',command:'tick'}).catch(()=>{});}
  if(!searchedTab){
   let tab=tabs.find(t=>t.url===state.search.url);
   if(!tab){
    const latest=await api('/api/browser-state');
    if(!canBrowseJobs(latest)||latest.search?.id!==state.search.id||latest.search?.url!==state.search.url)return;
    const candidate=tabs.find(t=>t.active!==true&&searchableList(t));
    const current=candidate?await chrome.tabs.get(candidate.id).catch(()=>null):null;
    tab=current&&current.active!==true&&!current.unavailable&&current.url===candidate.url
     ?await chrome.tabs.update(current.id,{url:state.search.url,active:false})
     :await chrome.tabs.create({url:state.search.url,active:false});
   }
   await chrome.storage.session.set({lastSearch:{id:state.search.id,tabId:tab.id}});return;
  }
 }
 // Claim stocked details before any list navigation. Navigation failures cannot starve the detail queue.
 if(await crawl())return;

 const tab=searchedTab||tabs.find(searchableList);
 if(tab){if(tab.id!==searchedTab?.id)void chrome.tabs.sendMessage(tab.id,{type:'assistant-read',command:'tick'}).catch(()=>{});}
 else if(canBrowseJobs(await api('/api/browser-state')))await chrome.tabs.create({url:'https://www.zhipin.com/web/geek/job',active:false});
}
async function work(){
 if(opening)return;opening=true;let phase='读取浏览器任务',error='';
 try{
  phase='保持HR消息监听';const state=await api('/api/browser-state');
  if(state.accountRecheck?.required){
   phase='等待主人核对原 BOSS 账号';
   for(const key of ['worker','crawler','favoritesWorker','chatJob','lastIncomingHint','focusedOwnerTarget','chatMonitorTabId','lastSearch'])await chrome.storage.session.remove(key);
   return;
  }
  await ensureChat(state);
  const {worker:stored}=await chrome.storage.session.get('worker');
  const {crawler}=await chrome.storage.session.get('crawler');
  if(crawler&&!canReadCrawler(state,crawler))await releaseCrawler(crawler);
  if(!jobRunning(state)){
   const {favoritesWorker}=await chrome.storage.session.get('favoritesWorker');if(favoritesWorker)await favoriteFinished(favoritesWorker,'disabled','自主求职已关闭');
  }
  if(stored&&!greetingEnabled(state,stored)){
   phase='自主求职已关闭，清理岗位任务';
   if(validClaim(stored)&&Date.now()-stored.at<180000){phase='自主求职已关闭，保留原发送回执核对';const tab=await chrome.tabs.get(stored.tabId).catch(()=>null);if(tab)void pokeChat(tab);return;}
   await failWorker(stored,'自主求职已关闭，本次岗位任务停止');
  }
  if(!jobRunning(state)&&!state.config.ownerGreeting){
   phase=hrRunning(state)?'仅保持HR新消息监听':'两个自动通道均已关闭';return;
  }
  const worker=await greetingWorker();
  if(worker){
   phase=worker.claimed?(worker.handoffAt?'招呼聊天页已接续，等待发送回执':'招呼等待聊天页接续'):'等待岗位页领取招呼任务';
   const tab=await chrome.tabs.get(worker.tabId).catch(()=>null);
   if(!tab||Date.now()-worker.at>180000){phase='招呼结果待核对，清理本地页面绑定';await failWorker(worker,'岗位操作页关闭或超时，保留实际发送状态，请核对站内记录');}
   else{
    void chrome.tabs.sendMessage(tab.id,{type:'assistant-read',command:'tick'}).catch(()=>{});
    // A stalled sender keeps its lease and DOM. Optional favorites reads use
    // other list tabs or their own inactive page; never claim another send.
    if(canBrowseJobs(state)&&worker.claimed&&Date.now()-worker.at>=5000){
     const tabs=(await chrome.tabs.query({url:'https://www.zhipin.com/*'})).filter(t=>t.id!==worker.tabId&&t.id!==worker.sourceTabId&&!chatPage(t.url)&&!jobURL(t.url));
     const {favoritesWorker}=await chrome.storage.session.get('favoritesWorker');
     if(!favoritesWorker||favoritesWorker.tabId!==worker.tabId&&favoritesWorker.tabId!==worker.sourceTabId)await browseFavorites(tabs);
    }
   }
   return;
  }
  // Execute prepared greetings before consuming another detail-reading slot.
  phase='优先执行待发招呼';const {task}=await api('/api/work');
  if(task){
   if(!canOpenGreeting(await api('/api/browser-state'),task)){phase='岗位招呼授权已变更，未打开页面';return;}
   const tab=await taskTab(task.job.url,'greeting');await chrome.storage.session.set({worker:{tabId:tab.id,taskId:task.id,greetingPlanId:task.greetingPlanId,job:task.job,at:Date.now()}});phase='已打开待发送岗位';return;
  }
  phase='采集必要岗位详情';
  if(jobRunning(state))await browse(state);
  else if(!state.config.ownerBusy&&!state.config.ownerChat){
   const scope=ownerGreetingReadScope(state);
   if(scope)await crawl(scope);
  }
 }catch(e){error=e.message;await chrome.storage.local.set?.({workerError:{at:Date.now(),phase,error}});}
 finally{opening=false;await api('/api/worker-health',{phase,error,lastWorkAt:Date.now(),extensionVersion:chrome.runtime.getManifest?.().version||'0.9.0'}).catch(()=>{});}
}
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='jobs')work();});
// Fast path while the worker is awake; the alarm remains the suspension recovery path.
if(typeof setInterval==='function')setInterval(()=>{void work();},5000);
chrome.tabs.onUpdated?.addListener((id,change,tab)=>{
 if(change.unavailable===true){
  if(embeddedRuntime)nativeCrashes.set(id,(nativeCrashes.get(id)||0)+1);
  void settleCrashedClaim(id).catch(()=>{});void restoreChatMonitor(id).catch(()=>{});return;
 }
 if(change.status!=='complete'||!bossPage(tab?.url))return;
 if(loginPage(tab.url)){
  void api('/api/heartbeat',{page:bossPage(tab.url),accountSignal:'login-navigation',accountForeground:tab.active===true}).then(work).catch(()=>{});
 }else if(monitorDeparture(tab.url)){
  void restoreChatMonitor(id,tab.url).then(clear=>{if(clear)void work();}).catch(()=>{});
 }else void work();
});
chrome.tabs.onActivated?.addListener(({tabId}={})=>{if(externalReadTab&&externalReadTab.id===tabId)externalReadTab.selected=true;void work();});
async function bootstrap(){
  const version=chrome.runtime.getManifest?.().version||'0.9.0';
  const {loadedVersion}=await chrome.storage.session.get('loadedVersion');
  if(loadedVersion!==version){
    await chrome.storage.session.set({loadedVersion:version});
    const tabs=await chrome.tabs.query({url:'https://www.zhipin.com/*'});
    for(const t of tabs)if(/^\/web\/geek\/(?:chat|job|jobs|recommend)$/.test(new URL(t.url).pathname))await chrome.tabs.reload?.(t.id);
  }
  return work();
}
chrome.runtime.onStartup.addListener(()=>bootstrap());
chrome.runtime.onInstalled.addListener(()=>bootstrap());
setTimeout(()=>bootstrap(),2500);
chrome.tabs.onRemoved.addListener(async(id,info)=>{
 if(!nativeClaims.get(id)?.crashed)nativeClaims.delete(id);
 nativeCrashes.delete(id);
 const recovery=info?.isWindowClosing?null:restoreChatMonitor(id).catch(()=>{});
  const {worker}=await chrome.storage.session.get('worker');
  if(worker?.tabId===id)await failWorker(worker,'岗位操作页面已关闭，请核对该任务执行状态');
 await recovery;
});
