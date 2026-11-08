import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {testPort} from './port.mjs';

const fixtureCli=String.raw`
 import {appendFileSync,existsSync} from 'node:fs';
 import {join} from 'node:path';
 let input='';for await(const chunk of process.stdin)input+=chunk;
 const payload=JSON.parse(input),peer=payload.memory?.peerId;
 const idAt=process.argv.indexOf('--session-id'),prior=idAt>=0?process.argv[idAt+1]:null;
 const name=peer||'owner',gone=existsSync(join(process.env.BOSS_DATA_DIR,name+'-missing'));
 const out=value=>process.stdout.write(JSON.stringify(value)+'\n');
 appendFileSync(join(process.env.BOSS_DATA_DIR,'attempts.jsonl'),JSON.stringify({
  name,prior,history:payload.memory?.observed_history.map(message=>message.id),
  sends:payload.memory?.verified_sends.map(send=>send.status),latest:payload.messages?.at(-1)?.id,
  corrections:payload.memory?.observed_history.filter(message=>message.supersedes_prior_observation).map(({id,text,author})=>({id,text,author:author?.kind})),
  ownerHistory:payload.conversation_history
 })+'\n');
 if(prior&&gone&&prior.endsWith('-initial')){
  out({type:'error',message:'session "'+prior+'" does not exist; omit --session-id to start a new Session'});
  process.exitCode=1;
 }else{
  out({type:'session',sessionId:prior||'session-'+name+(gone?'-restored':'-initial')});
  const text=peer?JSON.stringify({action:'send_text',text:'合成回复 '+payload.messages.at(-1).id,reason:'合成测试',score:90}):'合成报告 '+payload.owner_instruction;
  out({type:'final',text,reason:{kind:'completed'}});
 }
`;

test('缺失 Harness 会话后 HR 保留发送事实并继续，主人只在下一次指令重建上下文',async t=>{
 const temp=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temp,'xiaojing-harness-recovery-')));
 const data=join(local,'runtime'),knowledge=join(local,'knowledge'),cli=join(local,'fixture-cli.mjs');
 const previous={BOSS_HARNESS_CLI:process.env.BOSS_HARNESS_CLI,BOSS_KNOWLEDGE_DIR:process.env.BOSS_KNOWLEDGE_DIR};
 let app;
 t.after(async()=>{
  if(app?.server.listening){const closed=once(app.server,'close');app.shutdown();await closed;}
  for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
  assert.equal(dirname(local),temp);rmSync(local,{recursive:true,force:true});
 });
 mkdirSync(knowledge);
 for(const name of ['12_人格与主人权限.txt','01_系统规则.txt'])writeFileSync(join(knowledge,name),'合成测试规则');
 for(const name of ['13_机器人与主人记忆.json','02_个人事实.json','03_求职偏好.json','04_项目与游戏记忆.json'])writeFileSync(join(knowledge,name),'{}');
 writeFileSync(cli,fixtureCli);
 process.env.BOSS_HARNESS_CLI=cli;process.env.BOSS_KNOWLEDGE_DIR=knowledge;
 const realNow=Date.now;let advance=0;t.mock.method(Date,'now',()=>realNow()+advance);
 const {createApplication}=await import('../server/app.mjs');
 const port=await testPort(),origin=`http://127.0.0.1:${port}`;
 app=createApplication({port,local:data,workspace:local,key:'fixture-only',replyIntervalMs:10,providerFetcher:async()=>{throw Error('Unexpected network request');}});
 app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
 const session=await(await fetch(origin+'/api/session')).json();
 async function api(path,body,owner=false){
  const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(body?{body:JSON.stringify(body)}:{})});
  const value=await response.json();assert(response.ok,value.error);return value;
 }
 async function until(check){
  for(let attempt=0;attempt<200;attempt++){
   const value=await check();if(value)return value;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('测试状态未到达');
 }
 const message=id=>({id,role:'hr',text:'合成消息 '+id});
 const enqueue=(peerId,messages)=>api('/api/replies/enqueue',{peerId,kind:'reply',trigger:'new_hr_message',messages});
 const row=(id,status)=>until(async()=>(await api('/api/replies/state')).items.find(item=>item.id===id&&item.status===status));
 const ownerTurn=(id,status)=>until(()=>app.state.ownerTasks.find(task=>task.id===id&&task.status===status));
 const attempts=()=>readFileSync(join(data,'attempts.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const record=peerId=>Object.values(JSON.parse(readFileSync(join(data,'agent-context','hr-index.json'),'utf8')).records).find(item=>item.peerId===peerId);
 await api('/api/config',{mode:'auto',browserCalibrated:true,learningEnabled:false,limits:{hoursStart:0,hoursEnd:24,intervalSeconds:0},profile:{name:'合成主人',facts:'合成资料',titles:['游戏策划'],cities:['北京']}},true);
 await api('/api/channels',{hrInbox:true},true);
 const peerA='fixture-a',peerB='fixture-b';
 const oldMessages=Array.from({length:8},(_,index)=>message('old-'+index));
 oldMessages[1].role='self';
 const first=await enqueue(peerA,[...oldMessages,message('initial')]);
 const ready=await row(first.reply.id,'ready');
 const task=app.state.tasks.find(item=>item.id===ready.taskId);
 const claim=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint});
 assert(claim.lease,claim.blocked);
 await api('/api/complete',{id:task.id,lease:claim.lease,success:true,evidence:'合成发送回显'});
 assert.equal(task.status,'sent');
 const recommendation=record(peerA).lastRecommendation;
 writeFileSync(join(data,peerA+'-missing'),'fixture');
 const current=await enqueue(peerA,[message('current')]);
 assert.equal((await row(current.reply.id,'failed')).retryScheduled,true);
 const retired=record(peerA);
 assert.equal(retired.sessionId,undefined);
 assert.equal(retired.generation,2);
 assert.deepEqual(retired.messageKeys,[]);
 assert.deepEqual(retired.lastRecommendation,recommendation);
 const other=await enqueue(peerB,[message('unrelated')]);
 await row(other.reply.id,'ready');
 advance=16000;
 const recovered=await row(current.reply.id,'ready');
 assert.equal(app.state.tasks.find(item=>item.id===recovered.taskId).replyAnchor,'current');
 assert.equal(task.status,'sent');
 assert.equal(record(peerA).sessionId,'session-fixture-a-restored');
 assert.equal(record(peerB).sessionId,'session-fixture-b-initial');
 const hrAttempts=attempts().filter(item=>item.name===peerA);
 assert.deepEqual(hrAttempts.map(item=>item.prior),[null,'session-fixture-a-initial',null]);
 assert(!hrAttempts[1].history.includes('old-0'));
 assert.deepEqual(hrAttempts[2].history,[...oldMessages.map(item=>item.id),'initial','current']);
 assert.deepEqual(hrAttempts[2].sends,['sent']);
 assert.equal(hrAttempts[2].latest,'current');

 await api('/api/chat/author-confirm',{peerId:peerA,messageId:'old-1',kind:'owner_confirmed'},true);
 const editedMessages=structuredClone(oldMessages);editedMessages[0].text='已修正的合成岗位地点';
 const edited=await enqueue(peerA,[...editedMessages,message('edited')]);
 await row(edited.reply.id,'ready');
 const correction=attempts().findLast(item=>item.name===peerA);
 assert.equal(correction.prior,'session-fixture-a-restored');
 assert.equal(correction.latest,'edited');
 assert.deepEqual(correction.corrections,[
  {id:'old-0',text:editedMessages[0].text,author:'hr'},
  {id:'old-1',text:oldMessages[1].text,author:'owner_confirmed'}
 ]);
 const reverted=await enqueue(peerA,[...oldMessages,message('reverted')]);
 await row(reverted.reply.id,'ready');
 const revert=attempts().findLast(item=>item.name===peerA);
 assert.deepEqual(revert.corrections,[{id:'old-0',text:oldMessages[0].text,author:'hr'}]);
 assert(!revert.history.includes('unrelated'));
 assert.deepEqual(revert.sends,['sent']);
 assert.equal(task.status,'sent');

 const initial=(await api('/api/owner-task',{requestId:'initial',prompt:'合成主人第一轮'},true)).task;
 await ownerTurn(initial.id,'done');
 writeFileSync(join(data,'owner-missing'),'fixture');
 const lostRequest={requestId:'lost',conversationId:initial.conversationId,prompt:'会话丢失测试轮'};
 const lost=(await api('/api/owner-task',lostRequest,true)).task;
 const failed=await ownerTurn(lost.id,'error');
 assert.equal(failed.errorCode,'HARNESS_SESSION_NOT_FOUND');
 assert.match(failed.result,/同一对话继续/);
 assert.equal(app.state.ownerConversations.find(item=>item.id===initial.conversationId).harnessSessionId,undefined);
 assert.equal((await api('/api/owner-task',lostRequest,true)).task.id,lost.id);
 assert.equal(attempts().filter(item=>item.name==='owner').length,2);
 const next=(await api('/api/owner-task',{...lostRequest,requestId:'next',prompt:'主动继续已保存对话'},true)).task;
 await ownerTurn(next.id,'done');
 const ownerAttempts=attempts().filter(item=>item.name==='owner');
 assert.deepEqual(ownerAttempts.map(item=>item.prior),[null,'session-owner-initial',null]);
 assert.equal(ownerAttempts[2].ownerHistory[0].assistant,'合成报告 合成主人第一轮');
 assert.equal(ownerAttempts[2].ownerHistory[1].status,'error');
});
