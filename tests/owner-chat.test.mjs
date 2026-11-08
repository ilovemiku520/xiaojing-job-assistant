import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {canRun} from '../server/core.mjs';
import {testPort} from './port.mjs';
import {followupReadOnlyIntent,verifyOwnerChatReceipt} from '../server/owner-chat.mjs';
const decision={action:'send_text',text:'你好，我是DeepSeek小鲸，帮主人跟进之前沟通过的游戏策划岗位，想问一下目前筛选进展如何？',reason:'按主人要求追问进度',score:90};
const request=(patch={})=>({kind:'followup',requestId:'test-owner-followup',instruction:'追问既有求职进度',targets:[{name:'甲女士',company:'测试游戏'}],...patch});
async function fixture(t,options={}){
 const port=await testPort(),app=createApplication({local:mkdtempSync(join(tmpdir(),'owner-chat-')),port,key:'test',inference:async()=>({...decision}),...options});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
 const api=async(path,data,owner=true)=>{const r=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(data?{body:JSON.stringify(data)}:{})});return {httpStatus:r.status,...await r.json()};};
 await api('/api/config',{mode:'auto',browserCalibrated:true,learningEnabled:false,limits:{hoursStart:0,hoursEnd:24},profile:{name:'测试主人',facts:'2027届统计学本科生',titles:['游戏策划'],cities:['北京']}});
 return {app,api};
}
const selection=p=>({planId:p.id,targetId:p.targets[0].id,...p.targets[0],uniquePeer:true,header:'甲女士 测试游戏 HR',job:{title:'游戏策划实习',company:'测试游戏',city:'北京'},messages:[{id:'oldhr',role:'hr',text:'请发一下简历'},{id:'oldself',role:'self',text:'之前已发附件简历'}]});

test('追问权限识别草稿、只读和等待确认，允许明确询问及不补发简历',()=>{
 for(const prompt of [
  '只写一版问简历筛选进度的草稿，先不要发送任何消息。',
  '帮我拟一条向计先生追问进度的消息。',
  '把追问草稿发给我看看。',
  '准备好追问文案，等我审核后再发。',
  '先核对过去跟这位HR的聊天历史。',
  '帮我选三位最近未回复的HR。',
  '暂时不要联系对方。',
  '先不要回复任何消息。',
  '不要发任何消息。',
  '不要给三位 HR 发消息。',
  '不要给这些 HR 发消息。',
  '不要向这位HR发送消息。',
  '本轮不要发给这个HR。',
  '不要替我回复任何消息。',
  '先别在BOSS上给这位HR发消息。',
  '先核对聊天历史，再主动跟进筛选进度，但先不要发送消息。',
  '先读记录，然后跟进这位 HR 的进度，等我确认后再发。',
  '写一版用于主动跟进筛选进度的草稿。',
  '请写一版“然后跟进这位 HR 的进度”的文案。',
  '仅起草一条合适的回复。'
 ])assert.equal(followupReadOnlyIntent(prompt),true,prompt);
 for(const prompt of [
  '先选三位有过沟通的HR，然后向他们询问简历筛选进度。',
  '筛选三位HR问问目前的筛选进展。',
  '先写一条跟进草稿，再发给对方。',
  '把刚才的追问文案发给对方。',
  '先查看这位HR的历史，不用等我确认，直接问问进度。',
  '不要再发送简历，只向她询问当前进展。',
  '不要再发送原来的附件简历，直接问问筛选进度。',
  '不要给这些 HR 发送任何附件简历，先问问筛选进度。',
  '不要联系其他人，只追问这位HR。',
  '先核对这位HR的历史，再主动跟进筛选进度。',
  '先查看沟通历史，然后跟进这位 HR 的进度。',
  '先核对聊天记录再问现在进展如何。'
 ])assert.equal(followupReadOnlyIntent(prompt),false,prompt);
});

test('只读主人轮次不能创建或恢复发送追问，明确授权仍可领取文字追问',async t=>{
 let api,cancelled;
 const outcomes=new Map();
 const authorized='先核对这位 HR 的聊天历史，再主动跟进筛选进度，不用再发附件简历。';
 const setup=await fixture(t,{ownerInference:async payload=>{
  const requestId='fixture-tool-'+payload.ownerTaskId;
  const followup=await api('/api/owner-chat',request({requestId}));
  if(payload.owner_instruction===authorized)outcomes.set(payload.ownerTaskId,{followup});
  else{
   const resume=await api('/api/owner-chat/resume',{planId:cancelled.id});
   const read=await api('/api/owner-chat',request({kind:'read',requestId:requestId+'-read'}));
   outcomes.set(payload.ownerTaskId,{followup,resume,read});
  }
  return {text:'合成工具结果'};
 }});
 ({api}=setup);const {app}=setup;
 const old=await api('/api/owner-chat',request({requestId:'fixture-authorized-earlier'}));
 cancelled=old.plan;
 assert.equal((await api('/api/operations/cancel',{kind:'plan',id:cancelled.id})).httpStatus,200);
 async function turn(prompt,requestId){
  const response=await api('/api/owner-task',{prompt,requestId});assert.equal(response.httpStatus,200);
  for(let attempt=0;attempt<150;attempt++){
   if(app.state.ownerTasks.find(task=>task.id===response.task.id)?.status==='done')return outcomes.get(response.task.id);
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('测试主人任务未完成');
 }
 for(const [mode,prompt] of [
  ['review','只写一版问简历筛选进度的草稿，先不要发送任何消息。'],
  ['auto','不要给三位 HR 发任何消息。']
 ]){
  assert.equal((await api('/api/config',{mode})).httpStatus,200);
  const {followup,resume,read}=await turn(prompt,'fixture-readonly-'+mode);
  assert.equal(followup.httpStatus,400);assert.match(followup.error,/未授权发送/);
  assert.equal(resume.httpStatus,400);assert.match(resume.error,/未授权发送/);
  assert.equal(app.state.ownerChats.find(plan=>plan.id===cancelled.id).targets[0].status,'cancelled');
  assert.equal((await api('/api/owner-chat/prepare',selection(cancelled),false)).task,undefined);
  assert.equal(read.httpStatus,200);
  assert.equal((await api('/api/owner-chat/prepare',selection(read.plan),false)).read,true);
  assert.equal((await api('/api/work',undefined,false)).task,null);
  assert.equal(app.state.tasks.length,0);
 }
 const resumed=await api('/api/owner-chat/resume',{planId:cancelled.id});
 assert.equal(resumed.httpStatus,200);assert.equal(resumed.plan.status,'queued');
 assert.equal((await api('/api/operations/cancel',{kind:'plan',id:cancelled.id})).httpStatus,200);
 const contact=Object.values(app.state.memories).find(item=>item.domIdentity?.name==='甲女士');
 const receipt=await api('/api/chat/resume-confirm',{peerId:contact.peerId,name:'甲女士',company:'测试游戏',evidence:'合成资料已发'});
 assert.equal(receipt.status,'resume_sent_followup');
 const {followup}=await turn(authorized,'fixture-explicit-followup');
 assert.equal(followup.httpStatus,200);
 const {task}=await api('/api/owner-chat/prepare',selection(followup.plan),false);
 assert.equal(task.action,'send_text');
 assert.equal(app.state.memories[contact.peerId].resume.status,'sent');
 const claim=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false);
 assert(claim.lease,claim.blocked);
});

test('旧HR提到通过后面试不会覆盖进度目的；跨委托与自己的回显变化不重复发同一句',async t=>{
 const {app,api}=await fixture(t,{inference:async()=>({...decision,text:'收到，我会把具体安排转给主人确认，确认后再回复你。'})});app.state.config.limits.intervalSeconds=0;
 const {plan:a}=await api('/api/owner-chat',request({requestId:'progress-a'}));
 const firstInput={...selection(a),messages:[{id:'screening-hr',role:'hr',text:'我先把您简历给负责人看下 通过后会邀请来公司面试'},{id:'owner-ok',role:'self',text:'好的'}]};
 const first=await api('/api/owner-chat/prepare',firstInput,false);assert(first.task);assert.match(first.task.text,/进展|进度|怎么样|如何/);assert(!/转给主人确认/.test(first.task.text));assert.equal(first.task.followupGoal.repaired,true);
 const claim=await api('/api/claim',{id:first.task.id,peerId:first.task.peerId,fingerprint:first.task.fingerprint},false);assert(claim.lease);
 await api('/api/complete',{id:first.task.id,lease:claim.lease,success:true,evidence:'隔离模拟回显，第一条进度已发'},false);
 const {plan:b}=await api('/api/owner-chat',request({requestId:'progress-b'}));
 const second=await api('/api/owner-chat/prepare',{...firstInput,planId:b.id,targetId:b.targets[0].id,messages:[...firstInput.messages,{id:'actual-first-self',role:'self',text:'19:12\n已读\n'+first.task.text}]},false);
 assert.equal(second.task.status,'skip');assert.match(second.task.reason,/重复/);assert.equal(app.state.tasks.filter(x=>x.status==='sent').length,1);assert.equal(app.state.ownerChats.at(-1).targets[0].status,'skip');
});

test('审核把后续草稿改成已发同句时，领取端仍拦截并结束目标而非永远排队',async t=>{
 let text=decision.text;const {app,api}=await fixture(t,{inference:async()=>({...decision,text})});app.state.config.limits.intervalSeconds=0;
 const {plan:a}=await api('/api/owner-chat',request({requestId:'claim-first'}));const {task:first}=await api('/api/owner-chat/prepare',selection(a),false);
 const lease=await api('/api/claim',{id:first.id,peerId:first.peerId,fingerprint:first.fingerprint},false);await api('/api/complete',{id:first.id,lease:lease.lease,success:true,evidence:'第一条模拟送达'},false);
 text='想帮主人了解一下，目前筛选结果如何，还需要补充什么材料？';const {plan:b}=await api('/api/owner-chat',request({requestId:'claim-second'}));const {task:second}=await api('/api/owner-chat/prepare',selection(b),false);assert.equal(second.status,'approved');
 assert.equal((await api('/api/review',{id:second.id,approve:true,text:first.text})).httpStatus,200);
 const blocked=await api('/api/claim',{id:second.id,peerId:second.peerId,fingerprint:second.fingerprint},false);assert(blocked.skipped);assert.match(blocked.blocked,/重复/);assert.equal(app.state.ownerChats.at(-1).targets[0].status,'skip');assert.equal(app.state.tasks.find(x=>x.id===second.id).status,'skip');assert.equal(app.state.tasks.filter(x=>x.reservedAt).length,1);
});

test('只有认证主人能确认我方消息作者；确认进入模型记忆并废弃已有旧稿',async t=>{
 const {app,api}=await fixture(t);const {plan}=await api('/api/owner-chat',request({requestId:'authorship-test'}));const {task}=await api('/api/owner-chat/prepare',selection(plan),false);
 const input={peerId:task.peerId,messageId:'oldself',kind:'owner_confirmed'};
 assert.equal((await api('/api/chat/author-confirm',input,false)).httpStatus,403);
 assert.equal((await api('/api/state')).memories[task.peerId].history.find(m=>m.id==='oldself').author.kind,'account_self_unknown');
 const confirmed=await api('/api/chat/author-confirm',input);assert.equal(confirmed.httpStatus,200);assert.equal(confirmed.message.author.kind,'owner_confirmed');assert.equal(app.state.tasks[0].status,'stale');
 const updated=(await api('/api/state')).memories[task.peerId];assert.equal(updated.history.find(m=>m.id==='oldself').author.kind,'owner_confirmed');assert.equal(updated.history.find(m=>m.id==='oldhr').author.kind,'hr');
 assert.equal((await api('/api/chat/author-confirm',{...input,messageId:'oldhr'})).httpStatus,400);
});
test('自主跟进以真实HR锚点去重，读过或拟稿不算发过，领取后不重复催问',async t=>{
 const {app,api}=await fixture(t,{inference:async()=>({...decision})});app.state.config.running=true;app.state.config.limits.intervalSeconds=0;app.state.ownerTasks.push({id:'auto-cycle',source:'autonomy',goalId:'goal',status:'running',prompt:'自主测试',at:Date.now()});
 const {plan:a}=await api('/api/owner-chat',request({requestId:'auto-first'}));assert.equal(app.state.ownerChats[0].origin,'autonomy');const {task}=await api('/api/owner-chat/prepare',selection(a),false);assert(task.autonomyAnchor);assert.equal(Object.keys(app.state.autonomy.contactAnchors||{}).length,0);
 const claim=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false);assert(claim.lease);await api('/api/complete',{id:task.id,lease:claim.lease,success:true,evidence:'模拟同一会话的新MID与完整正文'},false);assert(app.state.autonomy.contactAnchors[task.autonomyAnchor]);
 const {plan:b}=await api('/api/owner-chat',request({requestId:'auto-second'}));const prepared=await api('/api/owner-chat/prepare',selection(b),false);assert(prepared.skipped);assert.match(app.state.ownerChats.at(-1).targets[0].reason,/重复催问/);assert.equal(app.state.tasks.length,1);app.state.ownerTasks[0].status='done';
});
test('主人任务不关闭运行与读取，主动追问能在主人任务中发送我方末尾会话',async t=>{
 let finishOwner;const {app,api}=await fixture(t,{ownerInference:async()=>new Promise(r=>finishOwner=r)});await api('/api/run',{running:true});
 const owner=await api('/api/owner-task',{prompt:'帮我跟进这位HR'});assert.equal(owner.task.status,'running');assert.equal(app.state.config.running,true);
 const bs=await api('/api/browser-state',undefined,false);assert.equal(bs.config.readingEnabled,true);assert.equal(bs.config.ownerBusy,true);
 const {plan}=await api('/api/owner-chat',request());const {task}=await api('/api/owner-chat/prepare',selection(plan),false);assert.equal(task.kind,'followup');assert.equal(task.status,'approved');
 const claim=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false);assert(claim.lease);assert((await api('/api/check',{id:task.id,lease:claim.lease},false)).allowed);
 await api('/api/complete',{id:task.id,lease:claim.lease,success:true,evidence:'同一会话稳定新MID和完整正文'},false);assert.equal(plan.targets[0].status,'queued');assert.equal(app.state.ownerChats[0].targets[0].status,'sent');
 finishOwner({text:'已经确认发送一条'});await new Promise(r=>setTimeout(r,10));assert.equal(app.state.ownerBusy,false);assert.equal(app.state.config.running,true);
});
test('明确委托可在后台暂停时执行，幂等、鉴权、最新会话检查及间隔限额保持有效',async t=>{
 const {app,api}=await fixture(t);assert.equal((await api('/api/owner-chat',request(),false)).httpStatus,403);
 const {plan}=await api('/api/owner-chat',request());assert.equal((await api('/api/owner-chat',request())).plan.id,plan.id);assert.equal(app.state.ownerChats.length,1);
 const bad=await api('/api/owner-chat/prepare',{...selection(plan),company:'另一家'},false);assert.equal(bad.httpStatus,400);
 const {task}=await api('/api/owner-chat/prepare',selection(plan),false);assert.equal(app.state.config.running,false);assert.equal(canRun(app.state,task),'');
 const now=Date.now();app.state.lastAction=now;assert.match(canRun(app.state,task),/间隔/);app.state.lastAction=0;
 assert.equal((await api('/api/claim',{id:task.id,peerId:'wrong',fingerprint:task.fingerprint},false)).httpStatus,400);
 await api('/api/observe',{peerId:task.peerId,header:'甲女士 测试游戏',messages:[...selection(plan).messages,{id:'newhr',role:'hr',text:'补充一些说明'}]},false);
 assert((await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false)).blocked);
 await api('/api/stop',{reason:'主人明确停止'},false);assert.equal(app.state.ownerChats[0].targets[0].status,'cancelled');assert.equal((await api('/api/browser-state',undefined,false)).config.ownerChat,null);
});
test('只读委托不生成发送；真实拒绝不追问；不明发送不能因重复提交而重发',async t=>{
 const {app,api}=await fixture(t);const {plan:read}=await api('/api/owner-chat',request({kind:'read'}));assert((await api('/api/owner-chat/prepare',selection(read),false)).read);assert.equal(app.state.tasks.length,0);
 const {plan:skip}=await api('/api/owner-chat',request({requestId:'declined'}));assert((await api('/api/owner-chat/prepare',{...selection(skip),messages:[{id:'decline',role:'hr',text:'暂不考虑，请勿打扰'}]},false)).skipped);
 const {plan}=await api('/api/owner-chat',request({requestId:'uncertain'})),{task}=await api('/api/owner-chat/prepare',selection(plan),false),lease=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false);
 await api('/api/complete',{id:task.id,lease:lease.lease,success:false,evidence:'没有稳定回显'},false);assert.equal(app.state.ownerChats.at(-1).targets[0].status,'uncertain');
 assert.equal((await api('/api/owner-chat',request({requestId:'must-not-duplicate-uncertain'}))).httpStatus,400);
 assert((await api('/api/owner-chat/prepare',selection(plan),false)).blocked);assert.equal((await api('/api/owner-chat',request({requestId:'uncertain'}))).plan.targets[0].status,'uncertain');assert.equal(app.state.tasks.length,1);
});
test('明确暂停立即撤销已领取的主人发送权限，重新运行也不能复活旧凭据',async t=>{
 const {app,api}=await fixture(t);const {plan}=await api('/api/owner-chat',request()),{task}=await api('/api/owner-chat/prepare',selection(plan),false),lease=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false);
 assert((await api('/api/check',{id:task.id,lease:lease.lease},false)).allowed);await api('/api/stop',{reason:'主人要求停止'},false);assert.equal((await api('/api/check',{id:task.id,lease:lease.lease},false)).allowed,false);await api('/api/run',{running:true});assert.equal((await api('/api/check',{id:task.id,lease:lease.lease},false)).allowed,false);assert.equal(app.state.ownerChats[0].targets[0].status,'uncertain');
});
test('结果修复只接受同目标发送后新增的完整正文，不能把旧消息或别的HR当成送达',async t=>{
 const {app,api}=await fixture(t);const {plan}=await api('/api/owner-chat',request()),{task}=await api('/api/owner-chat/prepare',selection(plan),false),lease=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false);
 await api('/api/complete',{id:task.id,lease:lease.lease,success:false,evidence:'页面重绘，未捕获结果'},false);const c=app.state.memories[task.peerId],real=app.state.tasks[0];assert.throws(()=>verifyOwnerChatReceipt(app.state,real));
 const messages=[...selection(plan).messages,{id:'unrelated-new-mid',role:'self',text:'20:30 送达 '+task.text+'，另外还需要确认。'}];
 await api('/api/observe',{peerId:task.peerId,header:c.header,job:c.job,messages},false);assert.throws(()=>verifyOwnerChatReceipt(app.state,real));
 await api('/api/observe',{peerId:task.peerId,header:c.header,job:c.job,messages:[...messages,{id:'actual-new-mid',role:'self',text:'20:30 送达 '+task.text}]},false);
 const proof=verifyOwnerChatReceipt(app.state,real);assert.equal(proof.messageId,'actual-new-mid');const old=c.domIdentity.name;c.domIdentity.name='另一个HR';assert.throws(()=>verifyOwnerChatReceipt(app.state,real));c.domIdentity.name=old;
 assert.equal((await api('/api/owner-chat/resolve',{taskId:task.id},false)).httpStatus,403);assert.equal((await api('/api/owner-chat/resolve',{taskId:task.id})).status,'sent');assert.equal(real.status,'sent');assert.equal(c.sends[0].status,'sent');assert.equal(app.state.tasks.length,1);
});
