import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../server/app.mjs';
import {validateDecision} from '../server/core.mjs';
import {testPort} from './port.mjs';

test('主人结束旧待核对后，重启仍只接收连续观察到的新来信',async t=>{
 const temp=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temp,'owner-reply-recovery-'))),modelCalls=[];
 const peerId='boss:legacy-owner-close',taskId='old-unknown-task',text='您好，小鲸帮主人回复。';
 const original={id:'old-original',role:'hr',text:'您好，还在看实习机会吗？'};
 const blocked={id:'old-pending',role:'hr',text:'可以继续沟通吗？'};
 const tail={id:'old-tail',role:'self',text:'我看到了。'};
 const input=(...messages)=>({kind:'reply',trigger:'new_hr_message',peerId,header:'模拟招聘者 模拟游戏公司',label:{name:'模拟招聘者',company:'模拟游戏公司'},messages});
 let app;
 t.after(async()=>{if(app)await app.shutdown();assert.equal(dirname(realpathSync(local)),temp);rmSync(local,{recursive:true,force:true});});
 async function start(){
  const port=await testPort();
  app=createApplication({local,workspace:local,desktop:true,port,key:'fixture-only',inference:async(config,_key,context)=>{
   modelCalls.push(context.messages.at(-1)?.id);return validateDecision({action:'send_text',text,reason:'模拟回复',score:95},config,context);
  }});
  app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
  const base='http://127.0.0.1:'+port,{token}=await(await fetch(base+'/api/session')).json();
  const api=async(path,data,actor='owner')=>{
   const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':actor==='browser'?app.embeddedToken:token},...(data?{body:JSON.stringify(data)}:{})});
   return {http:response.status,...await response.json()};
  };
  assert.equal((await api('/api/config',{mode:'auto',autoBrowse:false,browserCalibrated:true,learningEnabled:false,autoResume:true,
   limits:{hoursStart:0,hoursEnd:24,intervalSeconds:0},profile:{name:'模拟求职者',facts:'模拟应届实习经历',titles:['游戏策划'],cities:['北京'],resumeName:'合成简历.pdf'}})).http,200);
  assert.equal((await api('/api/channels',{hrInbox:true})).http,200);
  return api;
 }
 let api=await start();
 assert.equal((await api('/api/observe',input(original,blocked,tail),'browser')).http,200);
 const conversation=app.state.memories[peerId];
 const task={id:taskId,kind:'reply',action:'send_text',sourceChannel:'hrInbox',peerId,status:'uncertain',reservedAt:Date.now()-10,replyAnchor:original.id,text:'未核对的原回复',evidence:'未看到原回执'};
 app.state.tasks.unshift(task);conversation.sends.push({taskId,status:'uncertain',text:task.text,evidence:task.evidence});
 assert.equal((await api('/api/chat/author-confirm',{peerId,messageId:tail.id,kind:'owner_confirmed'})).http,200);
 const sends=structuredClone(conversation.sends),authors=structuredClone(conversation.authorConfirmations);
 const detail=await api('/api/operations/detail',{kind:'message',id:taskId});
 assert.deepEqual(detail.replyRecovery,{eligible:true});
 assert.equal((await api('/api/replies/close-uncertain',{taskId},'browser')).http,403);
 const closed=await api('/api/replies/close-uncertain',{taskId});
 assert.equal(closed.http,200);assert.equal(closed.status,'skip');assert(closed.closedAt>0);assert.equal(task.receipt,undefined);
 assert.deepEqual(conversation.sends,sends);assert.deepEqual(conversation.authorConfirmations,authors);assert.deepEqual(modelCalls,[]);
 assert.deepEqual((await api('/api/operations/detail',{kind:'message',id:taskId})).replyRecovery,{eligible:false,closedAt:closed.closedAt});
 const persisted=JSON.parse(readFileSync(join(local,'state.json'),'utf8'));
 assert.equal(persisted.memories[peerId].ownerReplyRecovery.boundary.id,tail.id);
 assert.equal(persisted.tasks.find(row=>row.id===taskId).ownerClosure.outcome,'unknown');
 await app.shutdown();api=await start();
 assert.deepEqual(await api('/api/replies/close-uncertain',{taskId}),closed);
 const oldReplay=await api('/api/prepare',input({...original,time:'20:13'}),'browser');
 assert.equal(oldReplay.skipped,true);assert.match(oldReplay.reason,/原回复已结束/);
 const disconnected={id:'disconnected',role:'hr',text:'缺少重叠的记录'};
 assert.equal((await api('/api/prepare',input(disconnected),'browser')).skipped,true);
 assert.equal((await api('/api/prepare',input(tail,disconnected),'browser')).skipped,true);
 const ownerOnly={id:'not-observed-in-browser',role:'hr',text:'只有控制台提交过的记录'};
 assert.equal((await api('/api/prepare',input(disconnected,ownerOnly))).skipped,true);
 assert.equal((await api('/api/prepare',input(disconnected,ownerOnly),'browser')).skipped,true);
 assert.deepEqual(modelCalls,[]);
 const fresh={id:'new-message',role:'hr',text:'您好，能分享一下作品集吗？'};
 const admitted=await api('/api/replies/enqueue',input(ownerOnly,fresh),'browser');assert.equal(admitted.http,202);
 for(let attempt=0;attempt<80&&!app.state.tasks.some(row=>row.id!==taskId);attempt++)await delay(10);
 const current=app.state.tasks.find(row=>row.id!==taskId);assert(current);assert.deepEqual(modelCalls,[fresh.id]);
 const lease=await api('/api/claim',{id:current.id,peerId,fingerprint:current.fingerprint},'browser');assert(lease.lease,lease.error||lease.blocked);
 assert.equal((await api('/api/complete',{id:current.id,lease:lease.lease,success:true,evidence:'模拟独立新回复回执'},'browser')).executionStatus,'sent');
 assert.equal((await api('/api/prepare',input(ownerOnly,{...fresh,time:'20:15'}),'browser')).skipped,true);
 assert.deepEqual(modelCalls,[fresh.id]);
 const request={id:'new-attachment-request',role:'hr',text:'想要一份附件简历，您是否同意？'},ack={id:'new-ack',role:'self',text:'好的。'};
 const resume=await api('/api/prepare',{...input(fresh,request,ack),resumeUI:{requestPending:true,agreeEnabled:true,requestMessageId:request.id,defaultResumeName:'合成简历.pdf'}},'browser');
 assert.equal(resume.task?.action,'send_resume',resume.error||resume.reason);
 assert.equal(app.state.memories[peerId].sends.find(row=>row.taskId===taskId).status,'uncertain');
});
