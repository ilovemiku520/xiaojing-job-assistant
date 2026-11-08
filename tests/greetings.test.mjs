import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
import {contactedJob,greetingReadOnlyIntent,greetingRequest,refreshGreeting,resumeGreeting} from '../server/greetings.mjs';

const decision={action:'send_text',text:'你好，我是小鲸，帮主人了解游戏策划实习机会，想请问目前是否还在招？',reason:'虚构JD符合实习方向',score:90};
const job=n=>({title:'游戏策划实习生',company:'虚构公司'+n,city:'北京',experience:'在校/应届',url:`https://www.zhipin.com/job_detail/fixtureg${n}.html`,description:'负责游戏玩法设计、规则原型和系统文档，岗位面向在校实习生和2027届校招生，能够结合统计学基础分析游戏体验并参与项目讨论。'});
async function fixture(t,extra={}){
 const local=mkdtempSync(join(tmpdir(),'whale-greetings-')),port=await testPort();let ownerCalls=0;
 const app=createApplication({local,port,key:'fixture-key',greetingIntervalMs:3600000,inference:async()=>({...decision}),ownerInference:async()=>{ownerCalls++;return {text:'不应空口承诺'};},...extra});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const session=await(await fetch(`http://127.0.0.1:${port}/api/session`)).json();
 async function api(path,data,owner=true){const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:data?'POST':'GET',headers:{'X-Boss-Token':owner?session.token:session.extensionToken,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return {http:r.status,...await r.json()};}
 await api('/api/config',{profile:{name:'测试主人',titles:['游戏策划'],cities:['北京'],facts:'2027届在校生，虚构测试资料',earlyCareerOnly:true},browserCalibrated:true,mode:'auto',learningEnabled:false,limits:{hoursStart:0,hoursEnd:24,intervalSeconds:30}});
 await api('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/jobs',diagnostics:{extensionVersion:'0.7.1',adapter:'0.7.1'}},false);
 return {app,api,local,get ownerCalls(){return ownerCalls;}};
}
test('仅当前明确数量命令自动路由，问题、否定和示例不触发发送',()=>{
 for(const [text,count] of [['小鲸帮我向三位hr打招呼',3],['请向10位HR发送招呼',10],['先给十二位HR打招呼',12],['帮我给两名人事打招呼',2],['小鲸鱼，帮我先给三个HR打个招呼吧！',3],['请向 2 位符合条件的 HR 发一条招呼，谢谢。',2],['再给二十位HR发送问候',20],['给3个HR打招呼',3]]){
  assert.equal(greetingRequest(text)?.count,count,text);
 }
 for(const text of ['不要向三位HR打招呼','为什么向三位HR打招呼没成功','测试“向三位HR打招呼”出现的问题','之前让你向三位HR打招呼','如果给三位HR打招呼呢','帮我向零位HR打招呼','请给二十一位HR打招呼','小鲸，帮我写三位HR的打招呼草稿','帮我挑三位HR可以打招呼的岗位','帮我给三位HR写个打招呼文案','请向三位HR打招呼的草稿改一下','帮我给三位HR打招呼吗？']){
  assert.equal(greetingRequest(text),null,text);
 }
});
test('只准备草稿和筛选的指令保持只读，明确继续发送的复合指令仍可委托',()=>{
 for(const prompt of ['小鲸，帮我写三位HR的打招呼草稿','帮我挑三位HR可以打招呼的岗位','帮我给三位HR写个打招呼文案','请先不要给三位HR打招呼','只需要一份打招呼话术','先拟一份招呼话术，等我确认后再发送','请先写给HR的招呼，不要自动发送','帮我把这段发给HR的招呼草稿改一下','帮我写三份打招呼草稿，再发给我看看','帮我挑几位HR，发给我看看','帮我挑几位HR，发送 给我看看','先只筛选，不发送']){
  assert.equal(greetingReadOnlyIntent(prompt),true,prompt);
 }
 for(const prompt of ['先帮我筛选三位符合条件的HR，然后向他们打招呼','帮我给三位HR写好招呼再发出去','帮我把这三位HR的招呼草稿发给他们','不要只写草稿，直接发给三位HR','挑三位合适的HR打个招呼','帮我挑三位HR顺便打个招呼','不要重复发送，筛选合适的新HR后发送','不用等我确认，直接向三位HR打招呼','写好三位HR的招呼，无需等我确认，直接发送招呼','不用给我草稿，直接发送招呼']){
  assert.equal(greetingReadOnlyIntent(prompt),false,prompt);
 }
});
test('真实主人路由和工具提交都服从当前指令，工具改写无法把草稿变成发送',async t=>{
 const attempts=[];let f;
 f=await fixture(t,{ownerInference:async payload=>{
  const result=await f.api('/api/greetings',{requestId:'fixture-tool:'+payload.ownerTaskId,instruction:'请立即向三位HR发送招呼',count:3});
  attempts.push(result);
  return {text:'这是合成测试结果。'};
 }});
 const {app,api}=f;
 const {ids}=await api('/api/jobs/observe',{jobs:[job(1),job(2),job(3)]},false);
 for(const id of ids)app.state.jobs[id].status='ready';
 async function submit(prompt,index){
  const accepted=await api('/api/owner-task',{requestId:'fixture-intent-'+index,prompt});
  assert.equal(accepted.http,200);
  for(let attempt=0;attempt<100&&!attempts[index];attempt++)await new Promise(resolve=>setTimeout(resolve,10));
  assert(attempts[index],'fixture owner tool must have attempted to create a plan');
  return accepted.task;
 }
 const readonly=['小鲸，帮我写三位HR的打招呼草稿','帮我挑三位HR可以打招呼的岗位','请先写给招聘方的招呼草稿，先不要发送'];
 for(const [index,prompt] of readonly.entries()){
  const task=await submit(prompt,index);
  assert.equal(task.greetingPlanId,undefined);
  assert.equal(attempts[index].http,400);
  assert.match(attempts[index].error,/未授权发送/);
  assert.equal((await api('/api/work',undefined,false)).task,null);
  assert.equal(app.state.greetingPlans.length,0);
 }
 const task=await submit('先筛选三位符合条件的HR，然后向他们打招呼',readonly.length);
 const authorized=attempts.at(-1);
 assert.equal(authorized.http,200);
 assert.equal(authorized.plan.ownerTaskId,task.id);
 assert.equal(authorized.plan.requested,3);
 const prepared=(await api('/api/work',undefined,false)).task;
 assert.equal(prepared.greetingPlanId,authorized.plan.id);
 assert.equal(prepared.status,'approved');
 assert.equal(authorized.plan.sent,0);
 assert(!app.state.tasks.some(row=>['sent','executing'].includes(row.status)));
});
test('三位HR命令立即创建持久化委托，不等待模型许诺；重试不重复创建',async t=>{
 const f=await fixture(t);await f.api('/api/jobs/observe',{jobs:[job(1),job(2),job(3),job(4)]},false);
 const req={requestId:'owner-three',prompt:'小鲸帮我向三位hr打招呼'},a=await f.api('/api/owner-task',req),b=await f.api('/api/owner-task',req);
 assert.equal(a.http,200);assert.equal(a.task.status,'done');assert.equal(a.task.id,b.task.id);assert.equal(f.ownerCalls,0);assert.equal(f.app.state.greetingPlans.length,1);assert.equal(f.app.state.greetingPlans[0].requested,3);assert.match(a.task.result,/0\/3/);assert(!a.task.result.includes('十分钟'));
 assert.equal(JSON.parse(readFileSync(join(f.local,'state.json'))).greetingPlans.length,1);assert.equal(f.app.state.config.running,false);
 assert.equal((await f.api('/api/greetings',undefined,false)).http,403);assert.equal((await f.api('/api/greetings',{requestId:'x',instruction:'伪造',count:3},false)).http,403);
});
test('读取真实详情后逐个发送，只确认三位就停；不对第四位生成或领取任务',async t=>{
 const {app,api}=await fixture(t);await api('/api/jobs/observe',{jobs:[job(1),job(2),job(3),job(4)]},false);
 const {plan}=await api('/api/greetings',{requestId:'bounded-three',instruction:'向三个合适的新HR打招呼',count:3});
 for(let i=1;i<=3;i++){
  app.state.lastCrawlAt=0;app.state.lastAction=0;const {job:reading}=await api('/api/crawl/next',{},false);assert(reading);assert.equal(reading.url,job(i).url);
  await api('/api/crawl/complete',{id:reading.id,lease:reading.lease,url:reading.url,success:true,job:job(i)},false);
  const {task}=await api('/api/work',undefined,false);assert(task);assert.equal(task.greetingPlanId,plan.id);const {lease}=await api('/api/claim',{id:task.id,url:task.job.url},false);assert(lease);
  const bound=await api('/api/greetings/target',{id:task.id,lease,name:'测试HR'+i,company:job(i).company,messages:[]},false);assert.equal(bound.allowed,true);
  await api('/api/complete',{id:task.id,lease,success:true,evidence:'同一HR会话新增稳定MID-fixture-'+i+'，完整正文回显'},false);
 }
 assert.equal(app.state.greetingPlans[0].status,'done');assert.equal(app.state.greetingPlans[0].sent,3);assert.equal((await api('/api/work',undefined,false)).task,null);assert.equal(app.state.tasks.filter(t=>t.status==='sent').length,3);assert.equal(app.state.config.running,false);
 assert.equal(Object.values(app.state.jobs).find(j=>j.url===job(4).url).status,'listed');
});
test('关闭自主求职时只给确切主人委托领取在库详情，取消后旧租约让给新委托',async t=>{
 const {app,api}=await fixture(t);
 const {ids}=await api('/api/jobs/observe',{jobs:[job(1),job(2),job(3)]},false);
 const claim=ownerGreetingPlanId=>api('/api/crawl/next',{ownerGreetingPlanId},false);
 assert.equal((await api('/api/browser-state',undefined,false)).config.jobSearchRunning,false);
 assert.equal((await claim('no-plan')).job,null);
 const {plan:first}=await api('/api/greetings',{requestId:'read-old',instruction:'只读取指定候选的详情',count:1,jobIds:[ids[1]]});
 assert.equal((await claim('wrong-plan')).job,null);
 const {job:reading}=await claim(first.id);assert(reading);
 assert.deepEqual([reading.id,reading.ownerGreetingPlanId,reading.status],[ids[1],first.id,'reading']);
 assert.equal(app.state.jobs[ids[0]].status,'listed');
 await api('/api/operations/cancel',{kind:'greeting',id:first.id});
 const {plan:second}=await api('/api/greetings',{requestId:'read-new',instruction:'只读取新指定候选的详情',count:1,jobIds:[ids[2]]});
 assert.equal((await claim(first.id)).job,null);
 app.state.lastCrawlAt=0;
 const {job:next}=await claim(second.id);
 assert.deepEqual([next.id,next.ownerGreetingPlanId,next.status],[ids[2],second.id,'reading']);
 assert.equal(app.state.jobs[ids[1]].status,'listed');assert.equal(app.state.jobs[ids[1]].lease,undefined);assert.equal(app.state.jobs[ids[1]].ownerGreetingPlanId,undefined);
 assert.equal((await api('/api/crawl/complete',{id:reading.id,lease:reading.lease,url:reading.url,success:true,job:job(2)},false)).http,400);
 assert.equal(app.state.jobs[ids[2]].lease,next.lease);
});
test('旧委托已经观测到的详情可保存，但不能替另一批生成或发送招呼',async t=>{
 let generations=0;
 const {app,api}=await fixture(t,{inference:async()=>{generations++;return {...decision};}});
 const {ids}=await api('/api/jobs/observe',{jobs:[job(1),job(2)]},false);
 const {plan:first}=await api('/api/greetings',{requestId:'late-detail',instruction:'第一批指定候选',count:1,jobIds:[ids[0]]});
 const {job:reading}=await api('/api/crawl/next',{ownerGreetingPlanId:first.id},false);
 await api('/api/operations/cancel',{kind:'greeting',id:first.id});
 app.state.jobs[ids[1]].status='ready';
 const {plan:next}=await api('/api/greetings',{requestId:'distinct-job-new-plan',instruction:'新一批独立委托',count:1,jobIds:[ids[1]]});
 const receipt=await api('/api/crawl/complete',{id:reading.id,lease:reading.lease,url:reading.url,success:true,job:job(1)},false);
 assert.equal(receipt.status,'ready');assert.equal(generations,0);assert.equal(app.state.tasks.length,0);
 assert.equal(app.state.jobs[reading.id].ownerGreetingPlanId,undefined);
 const {task}=await api('/api/work',undefined,false);
 assert.equal(task.greetingPlanId,next.id);assert.equal(generations,1);
});
test('原委托恢复时释放已经超时的详情预约，只接受当前读取版本和租约',async t=>{
 let generations=0;
 const {app,api}=await fixture(t,{inference:async()=>{generations++;return {...decision};}});
 const {ids}=await api('/api/jobs/observe',{jobs:[job(1),job(2)]},false);
 const {plan}=await api('/api/greetings',{requestId:'resumed-read',instruction:'只向这个候选打招呼',count:1,jobIds:[ids[0]]});
 const scope=ownerGreetingReadRevision=>({ownerGreetingPlanId:plan.id,ownerGreetingReadRevision});
 const claim=revision=>api('/api/crawl/next',scope(revision),false);
 const browser=()=>api('/api/browser-state',undefined,false);
 assert.equal((await browser()).config.ownerGreeting.readRevision,0);
 const {job:old}=await claim(0);assert(old.lease);
 await api('/api/operations/cancel',{kind:'greeting',id:plan.id});
 app.state.jobs[old.id].reservedAt=Date.now()-181000;
 await api('/api/greetings/resume',{planId:plan.id});
 assert.equal((await browser()).config.ownerGreeting.readRevision,1);
 assert.equal(app.state.jobs[old.id].status,'listed');assert.equal(app.state.jobs[old.id].lease,undefined);
 assert.equal((await claim(0)).job,null);
 app.state.lastCrawlAt=0;
 const {job:fresh}=await claim(1);
 assert.equal(fresh.id,old.id);assert.notEqual(fresh.lease,old.lease);
 const complete=lease=>api('/api/crawl/complete',{id:old.id,url:old.url,lease,success:true,job:job(1)},false);
 assert.equal((await complete(old.lease)).http,400);
 assert.equal(app.state.jobs[old.id].lease,fresh.lease);
 assert.equal((await complete(fresh.lease)).status,'ready');
 const {task}=await api('/api/work',undefined,false);
 assert.equal(task.greetingPlanId,plan.id);assert.equal(generations,1);
 assert.equal(app.state.jobs[ids[1]].status,'listed');
});
test('缺失公司和城市的候选不能冒充合格岗位；低分跳过后继续筛选',async t=>{
 let n=0;const {app,api}=await fixture(t,{inference:async()=>({...decision,score:++n===1?20:90,action:n===1?'skip':'send_text'})});
 const missing={title:'游戏策划实习生',url:job(1).url};await api('/api/jobs/observe',{jobs:[missing,job(2)]},false);
 await api('/api/greetings',{requestId:'unknown',instruction:'请发一位合格HR',count:1});const candidates=await api('/api/greetings/candidates');assert.match(candidates.jobs[0].matchReason,/未识别/);
 const first=(await api('/api/crawl/next',{},false)).job;await api('/api/crawl/complete',{id:first.id,lease:first.lease,url:first.url,success:true,job:job(1)},false);assert.equal(app.state.tasks[0].status,'skip');
 app.state.lastCrawlAt=0;const next=(await api('/api/crawl/next',{},false)).job;assert.equal(next.url,job(2).url);assert.equal(app.state.greetingPlans[0].sent,0);
});
test('已有往来的HR跳过，不计为发送；未知发送停止此批且不补发',async t=>{
 const {app,api}=await fixture(t);await api('/api/jobs/observe',{jobs:[job(1),job(2),job(3)]},false);await api('/api/greetings',{requestId:'skip-known',instruction:'一位新HR',count:1});
 for(let i=1;i<=2;i++){app.state.lastCrawlAt=0;app.state.lastAction=0;const reading=(await api('/api/crawl/next',{},false)).job;await api('/api/crawl/complete',{id:reading.id,lease:reading.lease,url:reading.url,success:true,job:job(i)},false);const task=(await api('/api/work',undefined,false)).task;const {lease}=await api('/api/claim',{id:task.id,url:task.job.url},false);
  if(i===1){const r=await api('/api/greetings/target',{id:task.id,lease,name:'旧HR',company:job(i).company,messages:[{role:'self',text:'之前发过'}]},false);assert(r.skipped);assert.equal(app.state.greetingPlans[0].sent,0);}
  else{await api('/api/greetings/target',{id:task.id,lease,name:'新HR',company:job(i).company,messages:[]},false);await api('/api/complete',{id:task.id,lease,success:false,evidence:'未发现新消息MID'},false);}
 }
 assert.equal(app.state.greetingPlans[0].status,'uncertain');assert.equal((await api('/api/work',undefined,false)).task,null);assert.equal((await api('/api/greetings',{requestId:'no-retry',instruction:'再发',count:1})).http,400);
});
test('相同历史正文的新旧浏览器回报均跳过，只有新发送回执计入本批',async t=>{
 const {app,api}=await fixture(t);
 await api('/api/jobs/observe',{jobs:[job(1),job(2),job(3)]},false);
 const {plan}=await api('/api/greetings',{requestId:'existing-text-upgrade',instruction:'一位新的合适HR',count:1});
 const reports=[
  {success:false,alreadyPresent:true,evidence:'站内已有相同招呼正文，本轮未点击发送'},
  {success:true,evidence:'聊天记录已存在完全相同的招呼语，未重复发送'},
  {success:true,evidence:'同一会话出现新消息编号 fixture-new-mid 及本次完整正文（忽略时间与送达标签）'},
 ];
 for(const [index,report] of reports.entries()){
  const expectedJob=job(index+1);
  app.state.lastCrawlAt=0;
  app.state.lastAction=0;
  const {job:reading}=await api('/api/crawl/next',{},false);
  assert.equal(reading.url,expectedJob.url);
  await api('/api/crawl/complete',{id:reading.id,lease:reading.lease,url:reading.url,success:true,job:expectedJob},false);
  const {task}=await api('/api/work',undefined,false);
  const {lease}=await api('/api/claim',{id:task.id,url:task.job.url},false);
  const bound=await api('/api/greetings/target',{id:task.id,lease,name:'虚构HR'+index,company:expectedJob.company,messages:[]},false);
  assert.equal(bound.allowed,true);
  const result=await api('/api/complete',{id:task.id,lease,...report},false);
  assert.equal(result.http,200);
  assert.equal((await api('/api/check',{id:task.id,lease},false)).allowed,false);
  const saved=app.state.tasks.find(entry=>entry.id===task.id);
  const persisted=app.state.greetingPlans.find(entry=>entry.id===plan.id);
  if(index<2){
   assert.equal(saved.status,'skip');
   assert.equal(saved.alreadyPresent,true);
   assert.equal(persisted.sent,0);
   assert.equal(persisted.status,'queued');
   assert.equal(contactedJob(app.state,expectedJob),true);
  }else{
   assert.equal(saved.status,'sent');
   assert.equal(persisted.sent,1);
   assert.equal(persisted.status,'done');
  }
 }
});
test('主人修改普通配置不再中止自己，保留队列及原运行状态',async t=>{
 let release;const {app,api}=await fixture(t,{ownerInference:async()=>await new Promise(r=>release=r)});await api('/api/run',{running:true});
 await api('/api/owner-task',{requestId:'change-own-config',prompt:'打开岗位采集并查看状态'});assert(app.state.ownerBusy);
 assert.equal((await api('/api/config',{crawlEnabled:false})).http,200);assert(app.state.ownerBusy);assert.equal(app.state.config.running,true);assert.equal(app.state.ownerTasks[0].status,'running');
 release({text:'已修改'});await new Promise(r=>setTimeout(r,15));assert.equal(app.state.ownerTasks[0].status,'done');
});
test('旧数量命令重启后只限制无限招呼，不把历史文字重新当成发送指令',async t=>{
 const {app,api}=await fixture(t);const base=structuredClone(app.state);base.ownerTasks=[{id:'old',prompt:'小鲸帮我向三位hr打招呼',status:'done',result:'历史报告',at:1}];delete base.boundedGreetings;
 const local=mkdtempSync(join(tmpdir(),'whale-greet-restart-'));writeFileSync(join(local,'state.json'),JSON.stringify(base));const port=await testPort(),restarted=createApplication({local,port,key:'fixture',inference:async()=>decision});t.after(()=>restarted.server.close());
 assert.equal(restarted.state.boundedGreetings,true);assert.equal(restarted.state.greetingPlans.length,0);assert.equal(restarted.state.config.running,false);
});
test('浏览器扩展已更新而页面组件仍旧时不交付发送；已更新后可继续',async t=>{
 const {app,api}=await fixture(t);await api('/api/jobs/observe',{jobs:[job(1)]},false);const j=Object.values(app.state.jobs)[0];j.status='ready';
 await api('/api/greetings',{requestId:'stale-adapter',instruction:'一位新HR',count:1});
 await api('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/jobs',diagnostics:{extensionVersion:'0.7.1',adapter:'0.6.6'}},false);
 assert.equal((await api('/api/work',undefined,false)).task,null);assert.equal(app.state.tasks.length,0);assert.match(app.state.greetingPlans[0].waitingReason,/页面组件/);
 await api('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/jobs',diagnostics:{extensionVersion:'0.7.1',adapter:'0.7.1'}},false);assert((await api('/api/work',undefined,false)).task);
});
test('停止一批招呼不关闭全局运行，不取消独立聊天委托，重复请求不增加批次',async t=>{
 const {app,api}=await fixture(t);await api('/api/run',{running:true});const request={requestId:'only-this-batch',instruction:'一位新HR',count:1};
 const {plan}=await api('/api/greetings',request);assert.equal((await api('/api/greetings',request)).plan.id,plan.id);assert.equal((await api('/api/greetings',{...request,count:2})).http,400);
 const {plan:read}=await api('/api/owner-chat',{requestId:'independent-read',kind:'read',instruction:'只读历史',targets:[{name:'测试HR',company:'另家公司'}]});
 await api('/api/operations/cancel',{kind:'greeting',id:plan.id});assert.equal(app.state.greetingPlans[0].status,'cancelled');assert.equal(app.state.config.running,true);assert.equal(app.state.ownerChats.find(p=>p.id===read.id).status,'queued');
});
test('停止后迟到的真实发送回执仍更新已发数量，但不会恢复该批执行',()=>{
 const task={id:'one',status:'sent',evidence:'新MID与完整正文'},plan={status:'uncertain',requested:3,targets:[{taskId:'one',status:'executing'}]};refreshGreeting({tasks:[task]},plan);assert.equal(plan.sent,1);assert.equal(plan.targets[0].status,'sent');assert.equal(plan.status,'uncertain');
});
test('继续原批次只恢复确定未开始的目标，保留已发和不明结果，浏览器无权恢复',async t=>{
 const {app,api}=await fixture(t);await api('/api/jobs/observe',{jobs:[job(1),job(2)]},false);const {plan}=await api('/api/greetings',{requestId:'resume-safe',instruction:'两位新HR',count:2});await api('/api/operations/cancel',{kind:'greeting',id:plan.id});
 const p=app.state.greetingPlans[0];p.targets[0].status='sent';p.targets[0].taskId='already-sent';app.state.tasks.push({id:'already-sent',kind:'greeting',status:'sent',reservedAt:1});
 assert.equal((await api('/api/greetings/resume',{planId:p.id},false)).http,403);assert.equal((await api('/api/greetings/resume',{planId:p.id})).plan.sent,1);assert.equal(p.targets[0].status,'sent');assert.equal(p.targets[1].status,'queued');
 p.status='uncertain';assert.throws(()=>resumeGreeting(app.state,p),/未执行/);
});
