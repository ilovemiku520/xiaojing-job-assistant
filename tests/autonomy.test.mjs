import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeAutonomy,configureAutonomy,autonomyFingerprint,recordAutonomyIncoming,nextAutonomyWake,beginAutonomy,finishAutonomy,failAutonomy,createAutonomyFiles} from '../server/autonomy.mjs';
import {requestSearch,observeSearch} from '../server/search.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
const bare=()=>{const s={config:{running:true,profile:{cities:['北京','深圳','广州']}},tasks:[],ownerTasks:[],ownerChats:[],greetingPlans:[],jobs:{},memories:{}};initializeAutonomy(s);return s;};
const result=(extra={})=>JSON.stringify({summary:'已根据真实状态安排下一步，没有发送。',completedStepIds:[],nextSteps:[],nextReviewAt:null,...extra});
test('自主唤醒只响应实质事件，心跳和反复读取不触发新模型调用',()=>{
 const s=bare();configureAutonomy(s,{goal:'寻找实习',enabled:true},1000);const wake=nextAutonomyWake(s,1000);beginAutonomy(s,{id:'first'},wake,1000);finishAutonomy(s,{id:'first'},result(),1000);
 s.heartbeat={at:60000};s.jobs={j:{id:'j',status:'listed'}};s.autonomy.lastFingerprint=autonomyFingerprint(s);s.jobs.j.lastSeenAt=70000;assert.equal(nextAutonomyWake(s,70000),null);
 s.memories.c={peerId:'boss:c',history:[{id:'old-hr',role:'hr'}]};assert.equal(nextAutonomyWake(s,71000),null);recordAutonomyIncoming(s,'boss:c','new-hr',71000);assert.match(nextAutonomyWake(s,71000).reason,/发生变化/);
 s.config.running=false;assert.equal(nextAutonomyWake(s,72000),null);
});
test('跨回合步骤按时间和实际委托完成唤醒；结果不明不自动重发',()=>{
 const s=bare();configureAutonomy(s,{goal:'跟进实习',enabled:true},1000);beginAutonomy(s,{id:'one'},nextAutonomyWake(s,1000),1000);s.ownerChats=[{id:'plan',status:'queued'}];
 finishAutonomy(s,{id:'one'},result({nextSteps:[{description:'完成后读结果',dueAt:new Date(65000).toISOString(),waitForPlanId:'plan'}]}),1000);
 assert.equal(nextAutonomyWake(s,200000),null);s.ownerChats[0].status='uncertain';const wake=nextAutonomyWake(s,201000);assert(wake);beginAutonomy(s,{id:'two'},wake,201000);finishAutonomy(s,{id:'two'},result(),201000);assert.equal(nextAutonomyWake(s,500000),null);
 s.ownerChats[0].status='done';assert(nextAutonomyWake(s,501000));
});
test('没有新进展时退避，异常有定时恢复且保留目标和回合记录',()=>{
 const s=bare();configureAutonomy(s,{goal:'自己推进',enabled:true},1000);const task={id:'one'};beginAutonomy(s,task,nextAutonomyWake(s,1000),1000);finishAutonomy(s,task,result({nextSteps:[{description:'复查',dueAt:new Date(31000).toISOString()}]}),1000);assert.equal(nextAutonomyWake(s,40000),null);assert(nextAutonomyWake(s,150000));
 failAutonomy(s,task,'模拟工具断连',150000);assert.equal(nextAutonomyWake(s,200000),null);assert.match(nextAutonomyWake(s,400000).reason,/重试/);
 const dir=mkdtempSync(join(tmpdir(),'autonomy-files-'));createAutonomyFiles(dir).save(s);assert.equal(JSON.parse(readFileSync(join(dir,'goal.json'))).goal,'自己推进');assert.equal(JSON.parse(readFileSync(join(dir,'next-actions.json'))).length,1);assert(JSON.parse(readFileSync(join(dir,'episodes.json'))).some(e=>e.status==='incomplete'));
});
test('搜索重试幂等，当前城市范围生效，只在真实DOM结果回传后认定观察完成',()=>{
 const s=bare(),req={requestId:'search-one',query:'系统策划',city:'深圳',stage:'internship'},q=requestSearch(s,req,1000);assert.equal(requestSearch(s,req,1001).id,q.id);assert.equal(q.status,'queued');assert.equal(new URL(q.url).pathname,'/web/geek/job');assert.match(new URL(q.url).searchParams.get('query'),/实习/);
 assert.throws(()=>observeSearch(s,{id:q.id,url:q.url.replace('101280600','101010100'),cards:10}),/不一致/);observeSearch(s,{id:q.id,url:q.url,cards:4},2000);assert.equal(q.status,'observed');assert.equal(q.cards,4);assert.throws(()=>requestSearch(s,{...req,requestId:'other',city:'杭州'}),/搜索/);assert.throws(()=>requestSearch(s,{...req,query:'其他'}),/编号/);
});
test('杭州加入主人偏好后可搜索，未加入时不扩大求职城市',()=>{
 const s=bare(),input={requestId:'hangzhou',query:'游戏策划',city:'杭州',stage:'internship'};assert.throws(()=>requestSearch(s,input),/求职偏好/);s.config.profile.cities.push('杭州');const q=requestSearch(s,input);assert.equal(new URL(q.url).searchParams.get('city'),'101210100');observeSearch(s,{id:q.id,url:q.url,cards:2});assert.equal(q.status,'observed');
});
async function fixture(t,ownerInference){
 const local=mkdtempSync(join(tmpdir(),'autonomy-api-')),app=createApplication({local,port:await testPort(),key:'fixture',inference:async()=>({action:'hold',text:'',reason:'测试',score:90}),ownerInference,autonomyIntervalMs:15});await new Promise(r=>app.server.listen(app.port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const base=`http://127.0.0.1:${app.port}`,session=await(await fetch(base+'/api/session')).json();const api=async(p,d,owner=true)=>{const r=await fetch(base+p,{method:d?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(d?{body:JSON.stringify(d)}:{})});return {http:r.status,...await r.json()};};await api('/api/config',{learningEnabled:false,mode:'auto',browserCalibrated:true,profile:{name:'测试主人',facts:'2027届本科生',titles:['游戏策划'],cities:['北京','深圳','广州']}});return {app,api,local};
}
const settle=async fn=>{for(let i=0;i<200&&!fn();i++)await new Promise(r=>setTimeout(r,10));assert(fn());};
test('长期目标仅主人可配置；自主回合不占HR暂停锁，同目标后续沿用原生上下文',async t=>{
 const calls=[];const {app,api}=await fixture(t,async(p,signal,meta)=>{calls.push({p,meta});assert.equal(app.state.ownerBusy,false);return {text:result(),sessionId:'session-autonomy-test'};});
 assert.equal((await api('/api/autonomy',{goal:'篡改',enabled:true},false)).http,403);assert.equal((await api('/api/search',{query:'游戏策划'},false)).http,403);
 app.state.config.running=true;await api('/api/autonomy',{goal:'寻找符合真实背景的游戏实习，自己决定下一步',enabled:true});await settle(()=>app.state.autonomy.history.length===1);assert.equal(calls.length,1);assert.equal(app.state.ownerTasks[0].source,'autonomy');
 app.state.autonomy.lastRunAt=0;recordAutonomyIncoming(app.state,'boss:fixture-c','new-message');await settle(()=>calls.length===2);assert.equal(calls[1].meta.sessionId,'session-autonomy-test');assert.equal(calls[1].p.conversationId,calls[0].p.conversationId);assert.equal(app.state.tasks.length,0);
 await api('/api/owner-conversations/stop',{conversationId:app.state.autonomy.conversationId});assert.equal(app.state.autonomy.enabled,false);assert.equal(app.state.config.running,true);
});
test('主人补充优先接管自主思考，已接受的独立委托保持不变',async t=>{
 const calls=[];let autoSignal;const {app,api}=await fixture(t,async(p,signal)=>{calls.push(p.owner_instruction);if(p.channel==='owner_authorized_autonomy'){autoSignal=signal;return await new Promise((r,j)=>signal.addEventListener('abort',()=>j(Error('被主人接管')),{once:true}));}return {text:'已处理主人新要求'};});
 app.state.config.running=true;const {plan}=await api('/api/owner-chat',{requestId:'prior',kind:'read',instruction:'独立读取',targets:[{name:'测试HR',company:'测试游戏'}]});await api('/api/autonomy',{goal:'自己整理岗位',enabled:true});await settle(()=>!!autoSignal);
 const {task}=await api('/api/owner-task',{requestId:'manual',prompt:'优先处理这条补充'});await settle(()=>app.state.ownerTasks.find(t=>t.id===task.id)?.status==='done');assert.equal(autoSignal.aborted,true);assert.equal(calls[1],'优先处理这条补充');assert.equal(app.state.ownerChats.find(p=>p.id===plan.id).status,'queued');assert.equal(app.state.config.running,true);
});
