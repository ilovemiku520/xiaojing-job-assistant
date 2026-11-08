import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const decision={action:'send_text',text:'你好呀，主人目前仍在寻找游戏策划实习，方便了解一下这个岗位的工作内容吗？',reason:'正常求职问答',score:85};
const incoming=(peerId='boss:fixture-a',id='mid-a',text='您好，现在还在找实习吗？')=>({kind:'reply',trigger:'new_hr_message',peerId,header:'测试HR · 虚构游戏公司',job:{title:'游戏策划实习',company:'虚构游戏公司',city:'北京'},messages:[{id,role:'hr',text}]});
async function fixture(t,{inference=async()=>({...decision}),ownerInference=async()=>({text:'虚构主人任务完成'})}={}){
 const local=mkdtempSync(join(tmpdir(),'whale-autonomy-workflow-')),port=await testPort();
 const app=createApplication({local,port,key:'fixture-key',inference,ownerInference});await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const session=await(await fetch(`http://127.0.0.1:${port}/api/session`)).json();
 async function api(path,data,role='owner'){
  const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':role==='owner'?session.token:session.extensionToken},...(data?{body:JSON.stringify(data)}:{})});
  return {http:response.status,...await response.json()};
 }
 const configured=await api('/api/config',{mode:'auto',browserCalibrated:true,autoResume:true,allowSiteDefaultResume:true,learningEnabled:false,limits:{hoursStart:0,hoursEnd:24,intervalSeconds:30},profile:{name:'虚构求职者',titles:['游戏策划'],cities:['北京'],facts:'虚构的2027届学生求职测试资料',resumeName:'指定简历.pdf'}});assert.equal(configured.http,200);assert.equal((await api('/api/run',{running:true})).http,200);
 return {app,api,local,claim:task=>api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},'browser')};
}
async function finishRequestedResume({api,claim},peerId){
 const request=incoming(peerId,'resume-with-question','请发一下简历，另外方便介绍一下主人的游戏项目经历吗？');request.messages.push({id:'self-before-resume',role:'self',text:'好的，稍等一下。'});request.resumeUI={requestPending:true,requestHandled:false,agreeEnabled:true,requestMessageId:'resume-with-question',defaultResumeName:'',receipts:[]};
 const prepared=await api('/api/prepare',request,'browser');assert.equal(prepared.task?.action,'send_resume');const execution=await claim(prepared.task);assert(execution.lease,execution.blocked);const completed=await api('/api/complete',{id:prepared.task.id,lease:execution.lease,success:true,evidence:'您的附件简历 指定简历.pdf 已发送给Boss'},'browser');assert.equal(completed.http,200);return request;
}

test('主人长任务运行中，新的普通 HR 消息仍可生成并领取自动回复',async t=>{
 let started,finishOwner;const ownerStarted=new Promise(r=>started=r);
 const {app,api,claim}=await fixture(t,{ownerInference:async(payload,signal)=>{started();return await new Promise((resolve,reject)=>{finishOwner=resolve;signal.addEventListener('abort',()=>reject(Error('fixture cancelled')),{once:true});});}});
 const owner=await api('/api/owner-task',{requestId:'long-owner-turn',prompt:'整理主人提供的工作资料并继续分析'});assert.equal(owner.http,200);await ownerStarted;assert.equal(app.state.ownerBusy,true);
 const reply=await api('/api/prepare',incoming(),'browser');assert.equal(reply.http,200);assert.equal(reply.task?.action,'send_text');assert.equal(app.state.ownerBusy,true);assert.equal(app.state.config.running,true);
 const execution=await claim(reply.task);assert(execution.lease,execution.blocked);assert.equal(execution.task.status,'executing');
 const receipt=await api('/api/complete',{id:reply.task.id,lease:execution.lease,success:true,evidence:'虚构测试中同一会话出现了相同文本'},'browser');assert.equal(receipt.http,200);assert.equal(app.state.config.running,true);finishOwner({text:'主人资料整理完成'});
});

test('单个 HR 生成失败只对该会话退避，其他 HR 可以继续生成和发送',async t=>{
 const calls=[];const {app,api,claim}=await fixture(t,{inference:async(config,key,context)=>{calls.push(context.memory.peerId);if(context.memory.peerId==='boss:failing')throw Object.assign(Error('模拟模型暂时超时'),{code:'HARNESS_TIMEOUT'});return {...decision};}});
 const failing=incoming('boss:failing','mid-fail');const first=await api('/api/prepare',failing,'browser');assert(first.skipped);assert(first.retryAt>Date.now());assert.equal(app.state.config.running,true);assert.equal(app.state.tasks.length,0);
 const cooling=await api('/api/prepare',failing,'browser');assert(cooling.skipped);assert.equal(calls.length,1);
 const other=await api('/api/prepare',incoming('boss:healthy','mid-healthy'),'browser');assert.equal(other.task?.action,'send_text');assert.deepEqual(calls,['boss:failing','boss:healthy']);const execution=await claim(other.task);assert(execution.lease,execution.blocked);assert.equal(app.state.config.running,true);
});

test('HR 索要简历卡片仍待同意时，即使消息末尾为我方消息，也优先生成附件任务',async t=>{
 let modelCalls=0;const {app,api,claim}=await fixture(t,{inference:async()=>{modelCalls++;return {...decision};}});
 const request=incoming('boss:resume','request-1','请发一下简历');request.messages.push({id:'self-after-request',role:'me',text:'好的，稍等一下。'});request.resumeUI={requestPending:true,requestHandled:false,agreeEnabled:true,requestMessageId:'request-1',toolbarPresent:true,toolbarEnabled:false,defaultResumeName:'',receipts:[]};
 const prepared=await api('/api/prepare',request,'browser');assert.equal(prepared.http,200);assert.equal(prepared.task?.action,'send_resume');assert.equal(modelCalls,0);assert.equal(app.state.memories['boss:resume'].resume.workflow,'resume_requested');
 const execution=await claim(prepared.task);assert(execution.lease,execution.blocked);assert.equal(execution.task.action,'send_resume');
 const completed=await api('/api/complete',{id:prepared.task.id,lease:execution.lease,success:true,evidence:'您的附件简历 指定简历.pdf 已发送给Boss'},'browser');assert.equal(completed.http,200);
 // The old request card can remain in history after BOSS sends the attachment.
 const alreadySent=structuredClone(request);alreadySent.resumeUI.receipts=[{text:'您的附件简历 指定简历.pdf 已发送给Boss',source:'chat_notice'}];alreadySent.resumeUI.requestHandled=true;
 const repeat=await api('/api/prepare',alreadySent,'browser');assert(repeat.skipped||repeat.task?.action!=='send_resume');assert.equal(app.state.memories['boss:resume'].resume.status,'sent');assert.equal(app.state.tasks.filter(t=>t.action==='send_resume').length,1);assert.equal(modelCalls,0);
});

test('发送结果不明只隔离对应 HR，不重复发送，也不关闭其他会话自动回复',async t=>{
 const calls=[];const {app,api,claim}=await fixture(t,{inference:async(config,key,context)=>{calls.push(context.memory.peerId);return {...decision};}});
 const first=await api('/api/prepare',incoming('boss:uncertain','uncertain-1'),'browser');const execution=await claim(first.task);assert(execution.lease,execution.blocked);
 const completed=await api('/api/complete',{id:first.task.id,lease:execution.lease,success:false,evidence:'虚构页面回显未确认'},'browser');assert.equal(completed.http,200);assert.equal(app.state.tasks.find(task=>task.id===first.task.id).status,'uncertain');assert.equal(app.state.config.running,true);
 const repeated=await api('/api/prepare',incoming('boss:uncertain','uncertain-2','补充一条新的消息'),'browser');assert(repeated.skipped);assert.match(repeated.reason,/待核对/);assert.equal(calls.filter(peer=>peer==='boss:uncertain').length,1);
 const next=await api('/api/prepare',incoming('boss:other','other-1'),'browser');assert.equal(next.task?.action,'send_text');assert.equal(app.state.config.running,true);
 // Simulate the normal inter-message interval having elapsed; there is no
 // need to make this isolated workflow test wait on a real 30-second timer.
 app.state.lastAction=0;const nextExecution=await claim(next.task);assert(nextExecution.lease,nextExecution.blocked);assert.equal(app.state.tasks.filter(task=>task.peerId==='boss:uncertain').length,1);
});

test('简历发送成功后保存未答问题，并在最后一条为我方消息时续答；收到新回显或暂未更新DOM均可处理',async t=>{
 for(const freshReceipt of [true,false]){
  const contexts=[],f=await fixture(t,{inference:async(config,key,context)=>{contexts.push(context);return {...decision,text:'主人做过游戏原型，也整理了开发学习笔记，方便继续聊项目细节。'};}}),peerId='boss:resume-continue-'+freshReceipt;
  const request=await finishRequestedResume(f,peerId),pending=f.app.state.memories[peerId].pendingReplyAfterResume;assert.equal(pending?.messageId,'resume-with-question');assert(Number.isFinite(pending.at));
  const saved=JSON.parse(readFileSync(join(f.local,'state.json'),'utf8'));assert.equal(saved.memories[peerId].pendingReplyAfterResume.messageId,pending.messageId);
  const queued=await f.api('/api/tasks',{peerId},'browser');assert.deepEqual(queued.continuation,pending);assert.equal(contexts.length,0);
  const continuation={...structuredClone(request),trigger:'resume_sent_reply'};
  if(freshReceipt)continuation.resumeUI={...continuation.resumeUI,requestHandled:true,agreeEnabled:false,receipts:[{text:'您的附件简历 指定简历.pdf 已发送给Boss',source:'chat_notice'}]};
  else delete continuation.resumeUI; // The server receipt alone already proves attachment success.
  const reply=await f.api('/api/prepare',continuation,'browser');assert.equal(reply.task?.action,'send_text',reply.reason||reply.error);assert.equal(reply.task.resumeReplyAnchor,'resume-with-question');assert.equal(contexts.length,1);assert(contexts[0].after_resume);assert.equal(contexts[0].memory.resume.status,'sent');assert.equal(contexts[0].messages.at(-1).role,'self');assert.equal(f.app.state.memories[peerId].pendingReplyAfterResume,undefined);assert.equal((await f.api('/api/tasks',{peerId},'browser')).continuation,null);
  const duplicate=await f.api('/api/prepare',continuation,'browser');assert(duplicate.skipped);assert.equal(contexts.length,1);assert.equal(f.app.state.tasks.filter(task=>task.peerId===peerId&&task.action==='send_resume').length,1);
 }
});

test('简历后的旧问题编号已变化时，清理旧续答，由新的 HR 消息事件处理一次',async t=>{
 const contexts=[],f=await fixture(t,{inference:async(config,key,context)=>{contexts.push(context);return {...decision};}}),peerId='boss:resume-new-message';const request=await finishRequestedResume(f,peerId);
 const newer={...structuredClone(request),trigger:'resume_sent_reply'};newer.messages.push({id:'new-question-after-resume',role:'hr',text:'补充问一下，你主人平时用哪些游戏引擎？'});newer.resumeUI={...newer.resumeUI,requestHandled:true,agreeEnabled:false,receipts:[{text:'您的附件简历 指定简历.pdf 已发送给Boss',source:'chat_notice'}]};
 const oldContinuation=await f.api('/api/prepare',newer,'browser');assert(oldContinuation.skipped);assert.match(oldContinuation.reason,/问题已变化/);assert.equal(f.app.state.memories[peerId].pendingReplyAfterResume,undefined);assert.equal((await f.api('/api/tasks',{peerId},'browser')).continuation,null);assert.equal(contexts.length,0);
 const current=await f.api('/api/prepare',{...newer,trigger:'new_hr_message'},'browser');assert.equal(current.task?.action,'send_text',current.reason||current.error);assert.equal(current.task.resumeReplyAnchor,undefined);assert.equal(contexts.length,1);assert.equal(contexts[0].messages.at(-1).id,'new-question-after-resume');assert.equal(f.app.state.tasks.filter(task=>task.peerId===peerId&&task.action==='send_resume').length,1);
});
