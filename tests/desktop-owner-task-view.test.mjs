import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {desktopOwnerTaskView} from '../server/owner-conversations.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const turn=(conversationId,turnIndex,extra={})=>({
 id:conversationId+'-'+turnIndex,conversationId,turnIndex,at:1000+turnIndex,finishedAt:2000+turnIndex,
 status:'done',prompt:conversationId+'-prompt-'+turnIndex+' 合成指令'.repeat(100),
 result:conversationId+'-answer-'+turnIndex+' 合成报告'.repeat(700),...extra
});
function fixture(){
 const ownerConversations=[
  {id:'owner-older',title:'旧主人任务',updatedAt:2000},
  {id:'owner-current',title:'当前主人任务',updatedAt:3000,harnessSessionId:'not-in-scoped-response'},
  {id:'job-lane',title:'自主找岗',sourceChannel:'jobSearch',updatedAt:5000},
  {id:'hr-lane',title:'回复HR',sourceChannel:'hrInbox',updatedAt:5500},
  {id:'old-dedicated',title:'原HR专属',sourceChannel:'hrInbox',updatedAt:5600},
  {id:'old-autonomy',title:'旧自主目标',autonomyGoalId:'old-goal',updatedAt:5700}
 ];
 const ownerTasks=[
  ...Array.from({length:26},(_,i)=>turn('owner-older',i+1)),
  turn('owner-current',1,{status:'running',startedAt:2500,finishedAt:undefined,
   progress:{stage:'tool',toolCalls:2,lastActivityAt:2600,raw:'private-runtime-data'}}),
  turn('owner-current',2,{status:'queued',finishedAt:undefined}),
  ...Array.from({length:30},(_,i)=>turn('job-lane',i+1,{source:'autonomy',sourceChannel:'jobSearch'})),
  turn('hr-lane',1,{sourceChannel:'hrInbox'}),
  turn('old-dedicated',1,{sourceChannel:'hrInbox'}),
  turn('old-autonomy',1,{source:'autonomy'}),
  turn('hr-lane',2,{sourceChannel:'jobSearch',source:'autonomy'})
 ].reverse();
 return {ownerConversations,ownerTasks,channelConversations:{hrInbox:'hr-lane'},autonomy:{conversationId:'job-lane'}};
}

test('主人列表保留其他会话的状态和计数，只投影当前线程的完整正文',()=>{
 const state=fixture(),view=desktopOwnerTaskView(state,'owner',null);
 assert.equal(view.ownerTaskScope,'owner');
 assert.equal(view.ownerTaskThread,'owner-current');
 assert.deepEqual(view.ownerTaskIndex,[
  {id:'owner-current',title:'当前主人任务',updatedAt:3000,status:'running',turnCount:2,queued:1},
  {id:'owner-older',title:'旧主人任务',updatedAt:2026,status:'done',turnCount:26,queued:0}
 ]);
 assert.deepEqual(view.ownerTasks.map(task=>task.id),['owner-current-1','owner-current-2']);
 assert.equal(view.ownerTasks[0].prompt,turn('owner-current',1).prompt);
 assert.equal(view.ownerTasks[0].result,turn('owner-current',1).result);
 assert.equal(view.ownerTasks[0].startedAt,2500);
 assert.deepEqual(view.ownerTasks[0].progress,{stage:'tool',toolCalls:2,lastActivityAt:2600});
 assert.equal(desktopOwnerTaskView(state,'owner','owner-older').ownerTasks.length,26);
 assert.equal(desktopOwnerTaskView(state,'owner','hr-lane').ownerTaskThread,'owner-current');
 assert.equal(desktopOwnerTaskView(state,'owner','missing').ownerTaskThread,'owner-current');
 const fresh=desktopOwnerTaskView(state,'owner','~new');
 assert.equal(fresh.ownerTaskThread,'');
 assert.deepEqual(fresh.ownerTasks,[]);
 assert.deepEqual(fresh.ownerTaskIndex,view.ownerTaskIndex);
});

test('通道只返回自身最近 24 轮，未知页面没有正文，异常跨通道标记不混入',()=>{
 const state=fixture();
 const job=desktopOwnerTaskView(state,'job-channel','owner-older');
 assert.equal(job.ownerTaskThread,'job-lane');
 assert.equal(job.ownerTasks.length,24);
 assert.equal(job.ownerTasks[0].turnIndex,7);
 assert.equal(job.ownerTasks.at(-1).turnIndex,30);
 assert(job.ownerTasks.every(task=>task.conversationId==='job-lane'));
 const hr=desktopOwnerTaskView(state,'hr-channel','job-lane');
 assert.equal(hr.ownerTaskThread,'hr-lane');
 assert.deepEqual(hr.ownerTasks.map(task=>task.id),['hr-lane-1']);
 assert.deepEqual(desktopOwnerTaskView(state,'overview','owner-current'),{ownerTaskScope:'overview',ownerTaskThread:'',ownerTaskIndex:[],ownerTasks:[]});
 state.channelConversations.hrInbox='job-lane';
 assert.equal(desktopOwnerTaskView(state,'hr-channel').ownerTaskThread,'');
 assert.deepEqual(desktopOwnerTaskView(state,'hr-channel').ownerTasks,[]);
});

test('正文版本绑定页面与实际线程，同样长度的结果或可见进度变化也会换版本',()=>{
 const state=fixture();
 const initial=desktopOwnerTaskView(state,'owner','owner-current');
 assert.match(initial.ownerTaskRevision,/^[a-f0-9]{64}$/);
 const same=desktopOwnerTaskView(state,'owner','owner-current',initial.ownerTaskRevision);
 assert.equal(same.ownerTaskRevision,initial.ownerTaskRevision);
 assert.equal(same.ownerTasksUnchanged,true);
 assert.equal(Object.hasOwn(same,'ownerTasks'),false);
 assert.deepEqual(same.ownerTaskIndex,initial.ownerTaskIndex);
 assert.deepEqual(desktopOwnerTaskView(state,'owner','owner-current').ownerTasks,initial.ownerTasks);

 const active=state.ownerTasks.find(row=>row.id==='owner-current-1');
 active.result=active.result.replace('合成报告','替换结果');
 const changedResult=desktopOwnerTaskView(state,'owner','owner-current',initial.ownerTaskRevision);
 assert.notEqual(changedResult.ownerTaskRevision,initial.ownerTaskRevision);
 assert.equal(changedResult.ownerTasks[0].result,active.result);
 assert.equal(changedResult.ownerTasksUnchanged,undefined);
 active.progress.stage='checking';
 active.progress.toolCalls++;
 const changedProgress=desktopOwnerTaskView(state,'owner','owner-current',changedResult.ownerTaskRevision);
 assert.notEqual(changedProgress.ownerTaskRevision,changedResult.ownerTaskRevision);
 assert.equal(changedProgress.ownerTasks[0].progress.stage,'checking');
 assert.equal(changedProgress.ownerTasks[0].progress.toolCalls,3);

 const other=desktopOwnerTaskView(state,'owner','owner-older',changedProgress.ownerTaskRevision);
 assert.notEqual(other.ownerTaskRevision,changedProgress.ownerTaskRevision);
 assert.equal(other.ownerTasks.length,26);
 state.channelConversations.jobSearch='owner-current';
 const differentPanel=desktopOwnerTaskView(state,'job-channel',null,changedProgress.ownerTaskRevision);
 assert.equal(differentPanel.ownerTaskThread,changedProgress.ownerTaskThread);
 assert.deepEqual(differentPanel.ownerTasks,changedProgress.ownerTasks);
 assert.notEqual(differentPanel.ownerTaskRevision,changedProgress.ownerTaskRevision);
 const fresh=desktopOwnerTaskView(state,'owner','~new',initial.ownerTaskRevision);
 assert.equal(fresh.ownerTaskRevision,undefined);
 assert.deepEqual(fresh.ownerTasks,[]);
});

async function start(t,desktop){
 const port=await testPort(),app=createApplication({port,desktop,local:mkdtempSync(join(tmpdir(),'xiaojing-owner-scope-')),key:'fixture'});
 const state=fixture();
 Object.assign(app.state,{ownerConversations:state.ownerConversations,ownerTasks:state.ownerTasks,channelConversations:state.channelConversations});
 Object.assign(app.state.autonomy,state.autonomy);
 app.state.ownerBusy=true;
 app.state.tasks=[{id:'fixture-lease',status:'executing',reservedAt:Date.now()}];
 await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
 t.after(async()=>{
  const closed=once(app.server,'close');app.shutdown();app.server.closeAllConnections();await closed;
 });
 const base='http://127.0.0.1:'+port,{token}=await(await fetch(base+'/api/session')).json();
 async function fetchState(query){
  const response=await fetch(base+'/api/state'+query,{headers:{'X-Boss-Token':token}});
  assert(response.ok);
  const text=await response.text();
  return {value:JSON.parse(text),bytes:Buffer.byteLength(text)};
 }
 return {app,fetchState,state};
}

test('桌面状态只在指定页面附带对话，省略页面参数和非桌面接口保留旧响应',async t=>{
 const {fetchState,state}=await start(t,true);
 const previous=await fetchState('?view=desktop');
 assert.equal(previous.value.ownerTasks.length,state.ownerTasks.length);
 assert(previous.value.ownerConversations.some(row=>row.harnessSessionId==='not-in-scoped-response'));
 const overview=await fetchState('?view=desktop&panel=overview');
 assert(overview.bytes<previous.bytes/10);
 assert.deepEqual(overview.value.ownerTasks,[]);
 assert.equal(overview.value.ownerConversations,undefined);
 assert.equal(overview.value.ownerBusy,true);
 assert.equal(overview.value.channels.jobSearch.conversationId,'job-lane');
 const selected=await fetchState('?view=desktop&panel=owner&thread=owner-current');
 assert.equal(selected.value.ownerTaskThread,'owner-current');
 assert.deepEqual(selected.value.ownerTaskIndex.map(row=>row.status),['running','done']);
 assert.equal(selected.value.ownerTasks.length,2);
 assert(!JSON.stringify(selected.value).includes('job-lane-answer'));
 const lane=await fetchState('?view=desktop&panel=job-channel');
 assert.equal(lane.value.ownerTaskThread,'job-lane');
 assert.equal(lane.value.ownerTasks.length,24);
 assert(!JSON.stringify(lane.value).includes('hr-lane-answer'));

 const legacy=await start(t,false);
 const unscoped=await legacy.fetchState('?view=desktop&panel=overview');
 assert.equal(unscoped.value.ownerTasks.length,legacy.state.ownerTasks.length);
 assert.equal(unscoped.value.ownerTaskScope,undefined);
});

test('匹配正文版本时桌面状态仍实时刷新，旧查询和版本不符始终返回完整正文',async t=>{
 const {app,fetchState,state}=await start(t,true);
 const query='?view=desktop&panel=owner&thread=owner-current';
 const first=await fetchState(query);
 const revision=first.value.ownerTaskRevision;
 assert.match(revision,/^[a-f0-9]{64}$/);
 assert.equal(first.value.ownerBusy,true);
 app.state.ownerBusy=false;
 state.ownerTasks.find(row=>row.id==='owner-older-26').status='queued';
 const next=await fetchState(query+'&turnsRevision='+revision);
 assert.equal(next.value.ownerBusy,false);
 assert.equal(next.value.ownerTaskIndex.find(row=>row.id==='owner-older').queued,1);
 assert.equal(next.value.ownerTaskIndex.find(row=>row.id==='owner-older').status,'queued');
 assert.equal(next.value.ownerTaskRevision,revision);
 assert.equal(next.value.ownerTasksUnchanged,true);
 assert.equal(Object.hasOwn(next.value,'ownerTasks'),false);
 assert(next.bytes<first.bytes/2);
 assert.equal((await fetchState(query)).value.ownerTasks.length,2);
 assert.equal((await fetchState(query+'&turnsRevision='+'f'.repeat(64))).value.ownerTasks.length,2);
 const legacy=await fetchState('?view=desktop&turnsRevision='+revision);
 assert.equal(legacy.value.ownerTasks.length,state.ownerTasks.length);
 assert.equal(legacy.value.ownerTaskRevision,undefined);
 assert.equal(legacy.value.ownerTasksUnchanged,undefined);
});
