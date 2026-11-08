import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {canRun} from '../server/core.mjs';
import {testPort} from './port.mjs';
async function fixture(t,options={}){
 const port=await testPort(),app=createApplication({port,local:mkdtempSync(join(tmpdir(),'whale-limits-')),key:'fixture',inference:async()=>({action:'send_text',text:'您好，帮主人跟进一下筛选进度。',reason:'跟进进度',score:90}),...options});await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const base=`http://127.0.0.1:${port}`,{token,extensionToken}=await(await fetch(base+'/api/session')).json();const api=async(p,d,owner=true)=>{const r=await fetch(base+p,{method:d?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?token:extensionToken},...(d?{body:JSON.stringify(d)}:{})});return {httpStatus:r.status,...await r.json()};};
 await api('/api/config',{mode:'auto',browserCalibrated:true,learningEnabled:false,profile:{name:'测试主人',facts:'2027届本科生',titles:['游戏策划'],cities:['北京']}});return {app,api};
}
test('主人任务中改时间与间隔不自我中断，保留已准备的追问及运行状态',async t=>{
 let finishOwner,ownerSignal;const {app,api}=await fixture(t,{ownerInference:async(payload,signal)=>{ownerSignal=signal;return new Promise(r=>finishOwner=r);}});await api('/api/run',{running:true});await api('/api/owner-task',{prompt:'把发送改成8—23点，间隔30秒'});
 const {plan}=await api('/api/owner-chat',{kind:'followup',requestId:'limits-test',instruction:'询问进度',targets:[{name:'甲女士',company:'测试游戏'}]}),{task}=await api('/api/owner-chat/prepare',{planId:plan.id,targetId:plan.targets[0].id,name:'甲女士',company:'测试游戏',uniquePeer:true,header:'甲女士 测试游戏',messages:[{id:'self1',role:'self',text:'此前已沟通'}]},false);
 const r=await api('/api/limits',{hoursStart:8,hoursEnd:23,intervalSeconds:30});assert.equal(r.httpStatus,200);assert.equal(ownerSignal.aborted,false);assert.equal(app.state.ownerBusy,true);assert.equal(app.state.config.running,true);assert.equal(app.state.ownerChats[0].status,'queued');assert.equal(app.state.tasks[0].id,task.id);assert.equal(app.state.tasks[0].status,'approved');assert.equal(app.state.config.limits.dailyMessages,30);
 const beforeZero=structuredClone(app.state.config.limits),zero=await api('/api/limits',{intervalSeconds:0});assert.equal(zero.httpStatus,200);assert.deepEqual(zero.limits,{...beforeZero,intervalSeconds:0});assert.equal(zero.running,true);assert.equal(ownerSignal.aborted,false);assert.equal(app.state.ownerBusy,true);assert.equal(app.state.ownerChats[0].status,'queued');assert.equal(app.state.tasks[0].id,task.id);assert.equal(app.state.tasks[0].status,'approved');
 assert.equal((await api('/api/config',{limits:{hoursStart:0,hoursEnd:24,intervalSeconds:30}})).httpStatus,200);assert.equal(ownerSignal.aborted,false);assert.equal(app.state.config.running,true);assert.equal(app.state.tasks[0].status,'approved');
 // The settings form also submits other fields with unchanged values.
 assert.equal((await api('/api/config',{...app.state.config,limits:{...app.state.config.limits,hoursStart:8,hoursEnd:23}})).httpStatus,200);assert.equal(ownerSignal.aborted,false);
 finishOwner({text:'设置已修改，原队列保留'});await new Promise(r=>setTimeout(r,10));assert.equal(app.state.ownerTasks[0].status,'done');assert.equal(app.state.config.running,true);
});
test('限制修改仅限主人；无效值不改变状态；暂停时修改不会自行开始发送',async t=>{
 const {app,api}=await fixture(t);assert.equal((await api('/api/limits',{intervalSeconds:30},false)).httpStatus,403);const before=structuredClone(app.state.config);
 for(const data of [{hoursStart:23,hoursEnd:8},{intervalSeconds:-1},{mode:'auto'}])assert.equal((await api('/api/limits',data)).httpStatus,400);assert.deepEqual(app.state.config,before);
 const r=await api('/api/limits',{hoursStart:8,hoursEnd:23,intervalSeconds:30});assert.equal(r.running,false);assert.equal(app.state.config.running,false);assert.equal(r.limits.dailyGreetings,10);assert.equal(r.limits.dailyMessages,30);
 const task={kind:'reply',action:'send_text',status:'approved',stableMessageIds:true};app.state.config.running=true;assert.equal(canRun(app.state,task,false,Date.UTC(2026,10,1,14,0)), '');assert.match(canRun(app.state,task,false,Date.UTC(2026,10,1,16,0)),/工作时段/);
});

test('零间隔立即允许下一条消息，保留每日上限且重启后仍为零',async t=>{
 const local=mkdtempSync(join(tmpdir(),'whale-zero-interval-')),{app,api}=await fixture(t,{local});await api('/api/limits',{hoursStart:0,hoursEnd:24});await api('/api/run',{running:true});
 const before=structuredClone(app.state.config.limits),zero=await api('/api/limits',{intervalSeconds:0});assert.equal(zero.httpStatus,200);assert.deepEqual(zero.limits,{...before,intervalSeconds:0});assert.equal(zero.running,true);
 const now=Date.now(),task={kind:'reply',action:'send_text',status:'approved',stableMessageIds:true};app.state.lastAction=now;assert.equal(canRun(app.state,task,false,now),'');
 assert.equal((await api('/api/limits',{intervalSeconds:1})).httpStatus,200);assert.match(canRun(app.state,task,false,now),/发送间隔/);assert.equal((await api('/api/limits',{intervalSeconds:0})).httpStatus,200);
 app.state.tasks=Array.from({length:before.dailyMessages},()=>({kind:'reply',reservedAt:now}));assert.match(canRun(app.state,task,false,now),/每日消息上限/);
 await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});const restarted=await fixture(t,{local});assert.deepEqual(restarted.app.state.config.limits,{...before,intervalSeconds:0});assert.equal(restarted.app.state.config.running,false);
});
