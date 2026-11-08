import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,canRun} from '../server/core.mjs';
import {ensureAutomaticGreeting,greetingCriteria,nextGreetingTarget,refreshGreeting} from '../server/greetings.mjs';

const NOW=Date.now();
const job=(id,status='listed',extra={})=>({id,status,url:`https://www.zhipin.com/job_detail/automatic-${id}.html`,title:'游戏策划实习生',company:'虚构游戏'+id,city:'北京',experience:'在校/应届',description:'面向在校实习生和2027届毕业生，参与系统与玩法设计、规则原型验证和文档编写。普通技能差距可以在实习期间学习。',...extra});
function fixture(jobs=[job('one')]){
 const config=structuredClone(defaults);
 Object.assign(config,{running:true,autoGreet:true,mode:'auto',minScore:55,browserCalibrated:true,profile:{...config.profile,name:'测试主人',titles:['游戏策划'],cities:['北京','深圳','广州'],facts:'2027届本科生，虚构测试资料',earlyCareerOnly:true},limits:{...config.limits,hoursStart:0,hoursEnd:24,intervalSeconds:30}});
 return {config,jobs:Object.fromEntries(jobs.map(j=>[j.id,j])),tasks:[],greetingPlans:[],memories:{},ownerTasks:[],ownerChats:[],boundedGreetings:true,lastAction:0};
}
const taskFor=(state,j,status,extra={})=>({id:'task-'+j.id,kind:'greeting',job:structuredClone(j),action:status==='skip'?'skip':'send_text',status,criteriaHash:greetingCriteria(state.config),...extra});

test('standing goal 无需新的主人数量命令即可建持久队列，重复调度复用当前批',()=>{
 const state=fixture([job('one'),job('two')]);
 const plan=ensureAutomaticGreeting(state,NOW);assert(plan);assert.equal(plan.origin,'standing_goal');assert.equal(plan.requested,1);assert.equal(plan.status,'queued');assert.equal(plan.ownerTaskId,undefined);
 assert.equal(state.ownerTasks.length,0);assert.equal(state.greetingPlans.length,1);assert.deepEqual(plan.jobIds,['one','two']);assert.equal(plan.targets.length,2);
 assert.equal(ensureAutomaticGreeting(state,NOW+1),null);assert.equal(state.greetingPlans[0].id,plan.id);
});

test('已读完详情的 ready 岗位先执行，已有待发招呼时不另开候选分析',()=>{
 const state=fixture([job('listed-first'),job('ready-second','ready'),job('ready-third','ready')]);
 const plan=ensureAutomaticGreeting(state,NOW);assert.deepEqual(plan.jobIds,['ready-second','ready-third','listed-first']);
 const next=nextGreetingTarget(state,plan);assert.equal(next.job.id,'ready-second');
 const task=taskFor(state,next.job,'approved',{greetingPlanId:plan.id,greetingTargetId:next.target.id});
 next.target.taskId=task.id;state.tasks.push(task);refreshGreeting(state,plan,NOW);
 assert.equal(nextGreetingTarget(state,plan),null);assert.equal(plan.targets.find(t=>t.jobId==='ready-second').status,'ready');
});

test('同一求职条件下已 skip 的岗位不会因心跳、重复扫描或新调度反复分析',()=>{
 const state=fixture([job('one','ready')]);state.tasks.push(taskFor(state,state.jobs.one,'skip'));
 const before=structuredClone(state.tasks);
 for(let i=0;i<20;i++){state.jobs.one.lastSeenAt=NOW+i;state.heartbeat={at:NOW+i};assert.equal(ensureAutomaticGreeting(state,NOW+i),null);}
 assert.equal(state.greetingPlans.length,0);assert.deepEqual(state.tasks,before);
});

test('minScore 或主人履历条件变化可重新评估先前 skip，普通限速变化不重算匹配',()=>{
 for(const change of [s=>s.config.minScore=45,s=>s.config.profile.facts+='；补充了真实 Unity 项目经历']){
  const state=fixture([job('one','ready')]),stamp=greetingCriteria(state.config);state.tasks.push(taskFor(state,state.jobs.one,'skip'));
  state.config.limits.intervalSeconds=60;assert.equal(greetingCriteria(state.config),stamp);assert.equal(ensureAutomaticGreeting(state,NOW),null);
  change(state);assert.notEqual(greetingCriteria(state.config),stamp);const plan=ensureAutomaticGreeting(state,NOW);assert(plan);assert.equal(nextGreetingTarget(state,plan).job.id,'one');
 }
});

test('sent、uncertain、executing 记录即使修改评分条件也始终排除，不重新投同一岗位',()=>{
 for(const status of ['sent','uncertain','executing']){
  const state=fixture([job('one','ready')]);state.tasks.push(taskFor(state,state.jobs.one,status));state.config.minScore=0;state.config.profile.facts+=' 新技能';
  assert.equal(ensureAutomaticGreeting(state,NOW),null,status);assert.equal(state.greetingPlans.length,0);
 }
});

test('已有实际 HR 往来的岗位按去查询参数的职位链接排除，纯系统开场提示不算已联系',()=>{
 const state=fixture([job('contacted-self','ready'),job('contacted-hr','ready'),job('welcome-only','ready')]);
 state.memories={
  self:{job:{url:state.jobs['contacted-self'].url+'?securityId=fixture'},history:[{role:'self',text:'你好，想了解这个实习岗位'}]},
  hr:{job:{url:state.jobs['contacted-hr'].url},history:[{role:'hr',text:'你好，可以介绍下项目吗？'}]},
  welcome:{job:{url:state.jobs['welcome-only'].url},history:[{role:'self',text:'快来与招聘者沟通吧'}]}
 };
 const plan=ensureAutomaticGreeting(state,NOW);assert.deepEqual(plan.jobIds,['welcome-only']);assert.equal(nextGreetingTarget(state,plan).job.id,'welcome-only');
});

test('每日招呼与消息额度任何一项用完都不建新批，昨日额度不占今日额度',()=>{
 for(const [kind,limitKey] of [['greeting','dailyGreetings'],['reply','dailyMessages']]){
  const state=fixture();state.config.limits[limitKey]=1;state.tasks.push({id:'today',kind,status:'sent',reservedAt:NOW,job:{url:'https://www.zhipin.com/job_detail/other.html'}});
  assert.equal(ensureAutomaticGreeting(state,NOW),null,limitKey);assert.equal(state.greetingPlans.length,0);
  state.tasks[0].reservedAt=NOW-86400000;assert(ensureAutomaticGreeting(state,NOW),limitKey+' yesterday');
 }
});

test('暂停、关闭自动招呼或审核模式都不创建自主发送批次',()=>{
 for(const patch of [{running:false},{autoGreet:false},{mode:'review'}]){
  const state=fixture();Object.assign(state.config,patch);assert.equal(ensureAutomaticGreeting(state,NOW),null);assert.equal(state.greetingPlans.length,0);
 }
});

test('已有 standing 自动批也必须服从暂停，有限主人显式批次保留既有独立授权语义',()=>{
 for(const automatic of [true,false]){
  const state=fixture([job('one','ready')]),plan=ensureAutomaticGreeting(state,NOW),target=plan.targets[0];
  const task=taskFor(state,state.jobs.one,'approved',{greetingPlanId:plan.id,greetingTargetId:target.id});target.taskId=task.id;target.status='ready';state.tasks.push(task);
  if(!automatic)delete plan.origin;
  state.config.running=false;
  assert.equal(canRun(state,task,false,NOW),automatic?'已暂停':'');
 }
});

test('不会恢复旧 cancelled 有限数量批，也不将它取消的目标装入新的自动批',()=>{
 const state=fixture([job('cancelled','ready'),job('new','ready')]);
 const old={id:'owner-old',requestId:'old-request',ownerTaskId:'old-owner-task',requested:3,status:'cancelled',targets:[{id:'old-target',jobId:'cancelled',status:'cancelled'}],expiresAt:NOW+86400000};state.greetingPlans.push(old);
 const plan=ensureAutomaticGreeting(state,NOW);assert(plan);assert.notEqual(plan.id,old.id);assert.equal(plan.origin,'standing_goal');assert.deepEqual(plan.jobIds,['new']);assert.equal(old.status,'cancelled');assert.equal(old.requested,3);assert.equal(old.targets[0].status,'cancelled');
 const onlyCancelled=fixture([job('cancelled','ready')]);onlyCancelled.greetingPlans.push(structuredClone(old));assert.equal(ensureAutomaticGreeting(onlyCancelled,NOW),null);
});

test('自动批所有候选 skip 后进入 exhausted，新增候选可开下一批且不复查旧 skip',()=>{
 const state=fixture([job('one','ready'),job('two','ready')]),first=ensureAutomaticGreeting(state,NOW);
 for(const target of first.targets){const task=taskFor(state,state.jobs[target.jobId],'skip');target.taskId=task.id;state.tasks.push(task);}
 refreshGreeting(state,first,NOW);assert.equal(first.status,'exhausted');assert.equal(first.sent,0);assert.equal(ensureAutomaticGreeting(state,NOW),null);
 state.jobs.three=job('three','ready');const next=ensureAutomaticGreeting(state,NOW+1);assert(next);assert.notEqual(next.id,first.id);assert.deepEqual(next.jobIds,['three']);assert.equal(nextGreetingTarget(state,next).job.id,'three');assert.equal(state.tasks.length,2);assert.equal(first.status,'exhausted');
});
