import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeAutonomy,configureAutonomy,autonomyFingerprint,recordAutonomyIncoming,nextAutonomyWake,beginAutonomy,finishAutonomy,autonomyContext} from '../server/autonomy.mjs';

const bare=()=>{const state={config:{running:true,profile:{cities:['北京'],titles:['游戏策划']}},tasks:[],ownerTasks:[],ownerChats:[],greetingPlans:[],jobs:{},memories:{}};initializeAutonomy(state);return state;};
const result=extra=>JSON.stringify({summary:'本轮仅核对资料，未发送。',completedStepIds:[],nextSteps:[],nextReviewAt:null,...extra});
function idle(){const state=bare();configureAutonomy(state,{goal:'先处理收藏岗位，再寻找校招实习',enabled:true},1000);const task={id:'initial'};beginAutonomy(state,task,nextAutonomyWake(state,1000),1000);finishAutonomy(state,task,result(),1000);return state;}

test('补读历史、旧简历提示、覆盖度和心跳都不能冒充新HR消息；新消息稳定锚点只唤醒一次',()=>{
 const s=idle(),before=autonomyFingerprint(s);s.memories.old={peerId:'boss:old',history:[{id:'2019-old-tail',role:'hr',observedAt:70000}],resume:{status:'sent'},historyCoverage:{complete:true},jobDetail:{status:'read',observedAt:70000}};s.browserWorker={at:70000,phase:'reading_history',error:'页面暂未更新'};assert.equal(autonomyFingerprint(s),before);assert.equal(nextAutonomyWake(s,70000),null);
 assert.equal(recordAutonomyIncoming(s,'boss:old','genuine-new-1',71000),true);const changed=autonomyFingerprint(s);assert.notEqual(changed,before);const wake=nextAutonomyWake(s,71000);assert.match(wake.reason,/真实新HR消息/);const task={id:'incoming'};beginAutonomy(s,task,wake,71000);finishAutonomy(s,task,result(),71000);assert.equal(recordAutonomyIncoming(s,'boss:old','genuine-new-1',120000),false);assert.equal(autonomyFingerprint(s),changed);assert.equal(nextAutonomyWake(s,240000),null);assert.equal(recordAutonomyIncoming(s,'boss:old','genuine-new-2',250000),true);assert(nextAutonomyWake(s,250000));
});

test('收藏结果指纹忽略重复扫描时间、顺序及后台刷新，仅对真实结果/明确阻塞/入口变化反应',()=>{
 const s=bare();s.favorites={status:'observed',lastScanAt:1000,nextScanAt:5000,lastJobIds:['job-b','job-a'],navigation:{url:'https://www.zhipin.com/web/geek/favorites',observedAt:1000}};const first=autonomyFingerprint(s);s.favorites.lastScanAt=5000;s.favorites.nextScanAt=9000;s.favorites.lastJobIds.reverse();s.favorites.navigation.observedAt=5000;assert.equal(autonomyFingerprint(s),first);for(const status of ['scanning','discovering','queued']){s.favorites.status=status;assert.equal(autonomyFingerprint(s),first);}s.favorites.status='observed';s.favorites.lastJobIds.push('job-c');assert.notEqual(autonomyFingerprint(s),first);const newResults=autonomyFingerprint(s);s.favorites.status='blocked';assert.notEqual(autonomyFingerprint(s),newResults);const blocked=autonomyFingerprint(s);s.favorites.nextScanAt=999999;assert.equal(autonomyFingerprint(s),blocked);s.favorites.navigation.url='https://www.zhipin.com/web/geek/job-recommend';assert.notEqual(autonomyFingerprint(s),blocked);
 s.favorites={status:'empty',lastScanAt:1000,lastJobIds:[]};const empty=autonomyFingerprint(s);s.favorites.status='discovering';assert.equal(autonomyFingerprint(s),empty);s.favorites={status:'unavailable',lastScanAt:1000,lastJobIds:['old'],failedAt:2000};const unavailable=autonomyFingerprint(s);s.favorites.status='discovering';assert.equal(autonomyFingerprint(s),unavailable);
});

test('相同缓存的再次读取和历史read委托不是进展，真实JD更新/有效跟进/发送回执会改变状态',()=>{
 const s=bare();s.jobs.a={id:'a',url:'https://www.zhipin.com/job_detail/fixture.html',status:'listed',description:'甲甲'};const listed=autonomyFingerprint(s);s.jobs.a.status='reading';s.jobs.a.lastSeenAt=5000;assert.equal(autonomyFingerprint(s),listed);s.ownerChats.push({id:'history-only',kind:'read',status:'done'});assert.equal(autonomyFingerprint(s),listed);s.jobs.a.description='乙乙';assert.notEqual(autonomyFingerprint(s),listed);const changed=autonomyFingerprint(s);s.ownerChats.push({id:'owner-followup',kind:'followup',status:'queued'});assert.notEqual(autonomyFingerprint(s),changed);const delegated=autonomyFingerprint(s);s.tasks.push({id:'sent-1',action:'send_text',status:'sent'});assert.notEqual(autonomyFingerprint(s),delegated);
});

test('收藏后搜索是明确主线，纯历史审阅步骤退役，读历史不算工作进展也不能安排周期复查',()=>{
 const s=bare();configureAutonomy(s,{goal:'自主求职',enabled:true},1000);const task={id:'read-only'};beginAutonomy(s,task,nextAutonomyWake(s,1000),1000);s.memories.a={peerId:'boss:a',history:[{id:'old',role:'hr'}],resume:{status:'sent'}};
 finishAutonomy(s,task,result({nextSteps:[{description:'继续补读历史聊天记录',dueAt:new Date(31000).toISOString()},{description:'审阅旧会话正文，整理下一批聊天记录',dueAt:new Date(31000).toISOString()},{description:'把剩余37条会话正文看完，判断跟进进度',dueAt:new Date(31000).toISOString()}],nextReviewAt:new Date(31000).toISOString()}),1000);
 assert.equal(s.autonomy.primaryWork,'favorites_then_search');assert.equal(s.autonomy.history.at(-1).madeProgress,false);assert.equal(s.autonomy.noProgressCount,1);assert(s.autonomy.nextSteps.every(step=>step.status==='superseded'));assert.equal(s.autonomy.nextWakeAt,0);assert.equal(nextAutonomyWake(s,86400000),null);const context=autonomyContext(s);assert.equal(context.primaryWork,'favorites_then_search');assert.match(context.workPolicy.history,/不计工作进展/);assert.equal(context.nextSteps.length,0);
});

test('旧历史步骤不会挡住新消息或主人明确跟进，已有人工委托保持有效',()=>{
 const s=idle();s.ownerChats=[{id:'explicit-read',kind:'read',status:'queued'},{id:'explicit-followup',kind:'followup',status:'queued'}];s.autonomy.nextSteps=[{id:'old-a',description:'查看过往聊天记录',status:'planned',dueAt:2},{id:'owner-context',description:'读取历史聊天，完成主人这次指定的上下文核对',waitForPlanId:'explicit-read',status:'planned',dueAt:2},{id:'followup',description:'主动跟进HR的实习筛选进度',waitForPlanId:'explicit-followup',status:'planned',dueAt:2}];initializeAutonomy(s);assert.equal(s.autonomy.nextSteps[0].status,'superseded');assert.equal(s.autonomy.nextSteps[1].status,'planned');assert.equal(s.autonomy.nextSteps[2].status,'planned');assert(s.ownerChats.every(plan=>plan.status==='queued'));s.autonomy.lastFingerprint=autonomyFingerprint(s);recordAutonomyIncoming(s,'boss:new','genuine-mid',70000);assert(nextAutonomyWake(s,70000));
});

test('到期动作只尝试一次，模型忘记完成或再次写同一旧步骤不会造成无限定时唤醒',()=>{
 const s=bare();configureAutonomy(s,{goal:'自主找岗',enabled:true},1000);const initial={id:'initial'};beginAutonomy(s,initial,nextAutonomyWake(s,1000),1000);finishAutonomy(s,initial,result({nextSteps:[{description:'搜索北京游戏策划实习岗位',dueAt:new Date(65000).toISOString()}]}),1000);const step=s.autonomy.nextSteps[0];const due=nextAutonomyWake(s,200000);assert.deepEqual(due.stepIds,[step.id]);const task={id:'attempt'};beginAutonomy(s,task,due,200000);assert.equal(step.status,'running');finishAutonomy(s,task,result({nextSteps:[{id:step.id,description:step.description,dueAt:new Date(231000).toISOString()}],nextReviewAt:new Date(231000).toISOString()}),200000);assert.equal(step.status,'waiting_event');assert.equal(nextAutonomyWake(s,999999),null);s.favorites={status:'observed',lastScanAt:1000000,lastJobIds:['real-new-job']};assert(nextAutonomyWake(s,1000000));
});

test('工作回合中仅收到新HR事件不伪造工作成绩，真实岗位来源结果才允许必要定时复查',()=>{
 const s=bare();configureAutonomy(s,{goal:'自主求职',enabled:true},1000);const first={id:'incoming-only'};beginAutonomy(s,first,nextAutonomyWake(s,1000),1000);recordAutonomyIncoming(s,'boss:a','incoming-during-run',2000);finishAutonomy(s,first,result({nextReviewAt:new Date(60000).toISOString()}),2000);assert.equal(s.autonomy.history.at(-1).madeProgress,false);assert.equal(s.autonomy.nextWakeAt,0);
 s.favorites={status:'observed',lastScanAt:70000,lastJobIds:['a']};const next={id:'source-progress'};beginAutonomy(s,next,nextAutonomyWake(s,70000),70000);s.jobs.a={id:'a',status:'ready',description:'真实取得了新岗位正文'};finishAutonomy(s,next,result({nextReviewAt:new Date(130000).toISOString()}),70000);assert.equal(s.autonomy.history.at(-1).madeProgress,true);assert.equal(s.autonomy.noProgressCount,0);assert.equal(s.autonomy.nextWakeAt,130000);
});
