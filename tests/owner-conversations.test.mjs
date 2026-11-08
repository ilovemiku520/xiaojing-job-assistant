import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
const settle=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setTimeout(r,10));assert(predicate());};
async function fixture(t,ownerInference,{desktop=false}={}){
 const local=mkdtempSync(join(tmpdir(),'whale-conversation-')),port=await testPort(),app=createApplication({local,port,key:'fixture',ownerInference,desktop});await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const session=await(await fetch(`http://127.0.0.1:${port}/api/session`)).json();const api=async(path,data,owner=true)=>{
  const browserToken=desktop&&app.activeBrowserBridge()==='embedded'?app.embeddedToken:session.extensionToken;
  const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:browserToken},...(data?{body:JSON.stringify(data)}:{})});return {http:r.status,...await r.json()};};return {app,api,local};
}
test('同一任务连续两轮使用同一原生会话，新任务不会继承该原生会话',async t=>{
 const calls=[];const {app,api}=await fixture(t,async(payload,signal,meta)=>{calls.push({payload,sessionId:meta.sessionId});return {text:'已记录本轮',sessionId:meta.sessionId||'session-'+payload.conversationId};});
 const a=(await api('/api/owner-task',{requestId:'first',prompt:'先分析岗位资料'})).task;await settle(()=>a.id&&app.state.ownerTasks.find(t=>t.id===a.id).status==='done');
 const b=(await api('/api/owner-task',{requestId:'second',conversationId:a.conversationId,prompt:'继续，只保留北京岗位'})).task;await settle(()=>calls.length===2&&app.state.ownerTasks[0].status==='done');assert.equal(b.conversationId,a.conversationId);assert.equal(b.turnIndex,2);assert.equal(calls[1].sessionId,'session-'+a.conversationId);assert.equal(calls[1].payload.owner_instruction,'继续，只保留北京岗位');
 await api('/api/owner-task',{requestId:'different',prompt:'另一个独立分析'});await settle(()=>calls.length===3);assert.equal(calls[2].sessionId,undefined);assert.notEqual(calls[2].payload.conversationId,a.conversationId);
});
test('桌面主人频道使用实时浏览器桥接状态，不把内置浏览器当成外部配对扩展',async t=>{
 const calls=[],{app,api}=await fixture(t,async payload=>{calls.push(payload.runtime.browser);return {text:'模拟状态报告'};},{desktop:true});
 assert.equal((await api('/api/worker-health',{phase:'模拟浏览器桥接在线'},false)).http,200);
 await api('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/chat',accountSignal:'sign-in-ui',accountForeground:true},false);
 await api('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/job',accountForeground:false},false);
 const first=await api('/api/owner-task',{requestId:'embedded-state',prompt:'核对浏览器当前的连接状态'});
 await settle(()=>app.state.ownerTasks.find(task=>task.id===first.task.id)?.status==='done');
 assert.deepEqual(calls[0],{kind:'embedded',bridgeConnected:true,pageConnected:false,signInRequired:true,sendCalibrated:false,accountRecheckRequired:false});
 assert.equal((await api('/api/state')).desktopSetup.signIn,true);
 await api('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/chat',accountSignal:'chat-workspace',accountForeground:true},false);
 const ready=(await api('/api/state')).desktopSetup;
 assert.equal(ready.page,true);assert.equal(ready.signIn,false);
 const pairing=app.prepareExternalBrowserPairing();pairing.activate();
 const switched=await fetch(`http://127.0.0.1:${app.port}/api/desktop-pair`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'chrome-extension://'+'a'.repeat(32)},body:JSON.stringify({code:pairing.code})});
 assert.equal(switched.status,200);await switched.body.cancel();
 const second=await api('/api/owner-task',{requestId:'external-state',conversationId:first.task.conversationId,prompt:'重新核对连接状态'});
 await settle(()=>app.state.ownerTasks.find(task=>task.id===second.task.id)?.status==='done');
 assert.deepEqual(calls[1],{kind:'external',bridgeConnected:false,pageConnected:false,signInRequired:false,sendCalibrated:false,accountRecheckRequired:false});
});
test('处理中补充会排队，当前轮不中断；下一轮依序处理且网络重试不重复',async t=>{
 let finish,firstSignal;const calls=[];const {app,api}=await fixture(t,async(payload,signal)=>{calls.push(payload);if(calls.length===1){firstSignal=signal;return await new Promise(r=>finish=r);}return {text:'补充已处理'};});
 const a=(await api('/api/owner-task',{requestId:'queue-first',prompt:'先看系统策划方向'})).task;
 const req={requestId:'queue-next',conversationId:a.conversationId,prompt:'补充：也考虑关卡方向'},b=(await api('/api/owner-task',req)).task;assert.equal(b.status,'queued');assert.equal((await api('/api/owner-task',req)).task.id,b.id);assert.equal(firstSignal.aborted,false);assert.equal(calls.length,1);
 finish({text:'系统方向已看完'});await settle(()=>calls.length===2&&app.state.ownerTasks.find(t=>t.id===b.id).status==='done');assert.equal(calls[1].conversation_history[0].owner,a.prompt);assert.equal(calls[1].conversation_history[0].assistant,'系统方向已看完');assert.equal(app.state.ownerBusy,false);
});
test('资料库损坏时排队轮次落盘为失败，恢复文件后可继续同一原生会话',async t=>{
 let finish;const calls=[];
 const {app,api,local}=await fixture(t,async(payload,signal,meta)=>{
  calls.push({prompt:payload.owner_instruction,sessionId:meta.sessionId});
  if(calls.length===1)return await new Promise(resolve=>{finish=resolve;});
  return {text:'已继续核对合成资料'};
 });
 const libraryPath=join(local,'owner-library.json');
 app.library.setPersona({persona:'用于回归测试的角色'});
 const valid=readFileSync(libraryPath),marker='fixture-private-library-marker',damaged=`{ "documents": ${marker} }`;
 const first=(await api('/api/owner-task',{requestId:'preflight-first',prompt:'开始核对合成资料'})).task;
 writeFileSync(libraryPath,damaged);
 const req={requestId:'preflight-failed',conversationId:first.conversationId,prompt:'继续核对第二份资料'};
 const queued=await api('/api/owner-task',req);
 assert.equal(queued.http,200);
 assert.equal(queued.task.status,'queued');
 finish({text:'已核对第一份资料',sessionId:'fixture-preparation-session'});
 await settle(()=>!app.state.ownerBusy&&app.state.ownerTasks.find(task=>task.id===queued.task.id)?.status==='error');
 assert.equal(calls.length,1);
 assert.equal(readFileSync(libraryPath,'utf8'),damaged);
 const saved=readFileSync(join(local,'state.json'),'utf8'),state=JSON.parse(saved);
 assert(!saved.includes(marker));
 assert.equal(state.ownerBusy,false);
 const failed=state.ownerTasks.find(task=>task.id===queued.task.id);
 assert.equal(failed.errorCode,'OWNER_PREPARATION_FAILED');
 assert.equal(failed.status,'error');
 assert(Number.isFinite(failed.finishedAt));
 assert.match(failed.result,/资料库或知识文件/);
 const immediate=await api('/api/owner-task',{requestId:'preflight-immediate',prompt:'独立核对合成资料'});
 assert.equal(immediate.http,200);
 assert.equal(immediate.task.status,'error');
 assert.equal(immediate.task.errorCode,failed.errorCode);
 assert.equal(immediate.task.result,failed.result);
 writeFileSync(libraryPath,valid);
 const retry=await api('/api/owner-task',req);
 assert.equal(retry.http,200);
 assert.deepEqual(retry.task,failed);
 assert.equal(calls.length,1);
 const next=await api('/api/owner-task',{...req,requestId:'preflight-restored',prompt:'从当前会话继续'});
 assert.equal(next.http,200);
 assert.equal(next.task.turnIndex,3);
 await settle(()=>!app.state.ownerBusy&&app.state.ownerTasks.find(task=>task.id===next.task.id)?.status==='done');
 assert.deepEqual(calls,[{prompt:first.prompt,sessionId:undefined},{prompt:'从当前会话继续',sessionId:'fixture-preparation-session'}]);
});
test('超时轮次可在同任务继续，不重试旧指令，对话和进度落盘',async t=>{
 let calls=0;const {app,api,local}=await fixture(t,async(payload,signal,meta)=>{calls++;if(calls===1){meta.onProgress({type:'session',stage:'thinking',sessionId:'session-timeout',lastActivityAt:Date.now()});const e=Error('模拟空闲超时');e.code='HARNESS_TIMEOUT';e.sessionId='session-timeout';throw e;}assert.equal(meta.sessionId,'session-timeout');return {text:'先核对已有进度，继续本轮补充'};});
 const first=(await api('/api/owner-task',{requestId:'timeout',prompt:'核对我的求职进度'})).task;await settle(()=>app.state.ownerTasks.find(t=>t.id===first.id).status==='timed_out');assert.equal(calls,1);const saved=JSON.parse(readFileSync(join(local,'state.json')));assert.equal(saved.ownerConversations[0].harnessSessionId,'session-timeout');assert.match(saved.ownerTasks[0].result,/已保留/);
 const second=(await api('/api/owner-task',{requestId:'continue',conversationId:first.conversationId,prompt:'请从已有记录继续核对，不重复发送'})).task;await settle(()=>app.state.ownerTasks.find(t=>t.id===second.id).status==='done');assert.equal(calls,2);assert.equal(app.state.tasks.length,0);
});
test('仅主人可读写任务对话；停止该任务会撤回未执行补充，不影响另一个任务',async t=>{
 let calls=0;const {app,api}=await fixture(t,async(payload,signal)=>{calls++;if(calls===1)return await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));return {text:'另一个任务继续'};});
 for(const path of ['/api/owner-conversations','/api/owner-conversations/detail','/api/owner-conversations/stop'])assert.equal((await api(path,path.includes('/detail')||path.includes('/stop')?{conversationId:'x'}:undefined,false)).http,403);
 const a=(await api('/api/owner-task',{requestId:'stop-first',prompt:'分析系统方向'})).task;const b=(await api('/api/owner-task',{requestId:'stop-second',conversationId:a.conversationId,prompt:'接着分析关卡'})).task;const other=(await api('/api/owner-task',{requestId:'other',prompt:'独立资料任务'})).task;
 await api('/api/owner-conversations/stop',{conversationId:a.conversationId});await settle(()=>app.state.ownerTasks.find(t=>t.id===other.id).status==='done');assert.equal(app.state.ownerTasks.find(t=>t.id===b.id).status,'cancelled');assert.equal(calls,2);assert.equal(app.state.ownerTasks.find(t=>t.id===a.id).status,'interrupted');
});
test('旧任务导入为可续聊对话，重启不自动执行未完成或排队轮次',async t=>{
 const {app,local}=await fixture(t,async()=>({text:'不应重放'}));const state=structuredClone(app.state);state.ownerTasks=[{id:'legacy',prompt:'原先超时的任务',result:'Harness 生成超时',status:'error',at:1},{id:'queued',conversationId:'persisted-conversation',turnIndex:1,prompt:'未执行的补充',status:'queued',at:2}];state.ownerConversations=[{id:'persisted-conversation',title:'原任务',createdAt:1,updatedAt:2,turnsAssigned:1,harnessSessionId:'session-persisted'}];writeFileSync(join(local,'state.json'),JSON.stringify(state));
 const restored=createApplication({local,port:await testPort(),key:'fixture',ownerInference:async()=>{throw Error('不应执行');}});t.after(()=>restored.server.close());assert.equal(restored.state.ownerTasks[0].conversationId,'legacy-legacy');assert.equal(restored.state.ownerTasks[1].status,'interrupted');assert.equal(restored.state.ownerConversations.find(c=>c.id==='persisted-conversation').harnessSessionId,'session-persisted');assert.equal(restored.state.ownerBusy,false);
});
