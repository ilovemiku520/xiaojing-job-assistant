import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {createReplyQueue} from '../server/reply-queue.mjs';
import {testPort} from './port.mjs';

const result={action:'send_text',text:'你好，小鲸帮主人确认收到这条消息。',reason:'日常求职确认',score:90};
const input=(peer='boss:queue-a',id='hr-1',text='您好，还在看实习机会吗？')=>({kind:'reply',trigger:'new_hr_message',peerId:peer,label:{name:peer==='boss:queue-a'?'甲女士':'乙先生',company:'虚构游戏公司'},header:'虚构游戏公司 招聘者',job:{title:'游戏策划实习',company:'虚构游戏公司',city:'北京'},messages:[{id,role:'hr',text}]});
async function until(fn){for(let i=0;i<100;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('测试状态未到达');}
async function fixture(t,{providerFetcher}={}){
 const port=await testPort(),local=mkdtempSync(join(tmpdir(),'whale-reply-queue-')),calls=[];
 const app=createApplication({port,local,key:'fixture',replyIntervalMs:10,...(providerFetcher?{providerFetcher}:{inference:async(config,key,context,signal)=>new Promise((resolve,reject)=>{const call={context,signal,resolve};calls.push(call);signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});})})});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const base=`http://127.0.0.1:${port}`,{token,extensionToken}=await(await fetch(base+'/api/session')).json();
 async function api(path,data,browser=true){const r=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':browser?extensionToken:token},...(data?{body:JSON.stringify(data)}:{})});return {http:r.status,...await r.json()};}
 await api('/api/config',{...(providerFetcher?{backend:'api'}:{}),mode:'auto',browserCalibrated:true,learningEnabled:false,autoResume:false,limits:{hoursStart:0,hoursEnd:24,intervalSeconds:0},profile:{name:'虚构主人',facts:'已核实的虚构2027届测试资料',titles:['游戏策划'],cities:['北京']}},false);await api('/api/run',{running:true},false);
 return {app,api,calls,local};
}

test('新消息入队立即返回；另一HR可并行生成，同消息重复入队不重复调用模型',async t=>{
 const {api,calls,app,local}=await fixture(t),a=await api('/api/replies/enqueue',input());assert.equal(a.http,202);assert(['queued','generating'].includes(a.reply.status));assert.equal(app.state.tasks.length,0);assert.equal(calls.length,1);
 const duplicate=await api('/api/replies/enqueue',input());assert.equal(duplicate.reply.id,a.reply.id);assert.equal(calls.length,1);
 const b=await api('/api/replies/enqueue',input('boss:queue-b'));assert.equal(b.http,202);assert.equal(calls.length,2);assert.notEqual(a.reply.peerId,b.reply.peerId);
 const status=await api('/api/replies/state');assert.equal(status.items.filter(r=>r.status==='generating').length,2);assert(!JSON.stringify(status).includes('还在看实习'));assert(!JSON.stringify(app.state.replyQueue).includes('还在看实习'));assert.equal(JSON.parse(readFileSync(join(local,'state.json'),'utf8')).memories['boss:queue-a'].window[0].id,'hr-1');
 for(const call of calls)call.resolve(result);
 await until(()=>app.state.tasks.length===2);const final=await api('/api/replies/state');assert.equal(final.items.filter(r=>r.status==='ready').length,2);assert(final.items.every(r=>r.taskId&&r.timing.generationMs>=0));
});

test('两路生成已满时第三个新消息保留排队；空出后自动生成，不当作已处理丢失',async t=>{
 const {api,calls,app}=await fixture(t);await api('/api/replies/enqueue',input());await api('/api/replies/enqueue',input('boss:queue-b'));const third=await api('/api/replies/enqueue',input('boss:queue-c'));assert.equal(third.reply.status,'queued');assert.equal(calls.length,2);
 calls[0].resolve(result);await until(()=>calls.length===3);assert.equal(calls[2].context.memory.peerId,'boss:queue-c');calls[1].resolve(result);calls[2].resolve(result);await until(()=>app.state.tasks.length===3);
});

test('生成期间HR发来新消息，旧模型输出作废；新消息生成后只有最新草稿',async t=>{
 const {api,calls,app}=await fixture(t);const first=await api('/api/replies/enqueue',input());const second=await api('/api/replies/enqueue',input('boss:queue-a','hr-2','补充说明一下工作内容。'));assert.notEqual(first.reply.id,second.reply.id);assert.equal(calls[0].signal.aborted,true);calls[0].resolve(result);
 await until(()=>calls.length===2);calls[1].resolve(result);await until(()=>app.state.tasks.length===1);assert.equal(app.state.tasks[0].fingerprint,app.state.memories['boss:queue-a'].fingerprint);
 const rows=(await api('/api/replies/state')).items;assert.equal(rows.find(r=>r.id===first.reply.id).status,'stale');assert.equal(rows.find(r=>r.id===second.reply.id).status,'ready');
});

test('暂停取消生成和排队；恢复不重放，重新观察同一消息才重新入队',async t=>{
 const {api,calls,app}=await fixture(t);await api('/api/replies/enqueue',input());await api('/api/replies/enqueue',input('boss:queue-b'));await api('/api/replies/enqueue',input('boss:queue-c'));await api('/api/run',{running:false},false);assert(calls.every(c=>c.signal.aborted));assert((await api('/api/replies/state')).items.every(r=>r.status==='stale'));assert.equal(app.state.tasks.length,0);
 await api('/api/run',{running:true},false);await new Promise(r=>setTimeout(r,35));assert.equal(calls.length,2);const fresh=await api('/api/replies/enqueue',input());assert.equal(fresh.http,202);await until(()=>calls.length===3);calls[2].resolve(result);await until(()=>app.state.tasks.length===1);
});

test('队列发送仍走原接收人/指纹/单执行lease，结果不明归档且不重发',async t=>{
 const {api,calls,app}=await fixture(t);await api('/api/replies/enqueue',input());calls[0].resolve(result);await until(()=>app.state.tasks.length===1);const task=app.state.tasks[0];assert.equal((await api('/api/claim',{id:task.id,peerId:'boss:other',fingerprint:task.fingerprint})).http,400);
 const lease=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint});assert(lease.lease);assert.equal((await api('/api/replies/state')).items[0].status,'ready');
 await api('/api/complete',{id:task.id,lease:lease.lease,success:false,evidence:'测试未确认，不重发'});const row=(await api('/api/replies/state')).items[0];assert.equal(row.status,'done');assert.match(row.reason,/不自动重发/);const duplicate=await api('/api/replies/enqueue',input());assert.equal(duplicate.reply.id,row.id);assert.equal(calls.length,1);
});

test('人工接手输入只跳过原自动回复并持久化锚点，后续确实新的HR消息仍可处理',async t=>{
 const {api,calls,app,local}=await fixture(t);
 const original=input(),earlier={id:'earlier-hr',role:'hr',text:'较早的虚构来信'};
 original.messages.unshift(earlier);
 const queued=(await api('/api/replies/enqueue',original)).reply;
 await until(()=>calls.length===1);calls[0].resolve(result);
 const task=await until(()=>app.state.tasks.find(t=>t.peerId===original.peerId));
 const claimed=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint});
 assert.equal(claimed.task.autoReplyClaim.tailId,'hr-1');
 const outcome={id:task.id,lease:claimed.lease,success:false,outcome:'manual_editor_takeover',evidence:'此字段不决定人工接手证明'};
 assert.equal((await api('/api/complete',{...outcome,lease:'incorrect'})).http,400);
 assert.equal((await api('/api/complete',outcome)).executionStatus,'skip');
 const row=(await api('/api/replies/state')).items.find(r=>r.id===queued.id);
 assert.equal(row.status,'skip');assert.match(row.reason,/人工接手聊天输入/);
 const persisted=JSON.parse(readFileSync(join(local,'state.json'),'utf8')).tasks.find(t=>t.id===task.id);
 assert.equal(persisted.replyOutcome,'manual_editor_takeover');assert.equal(persisted.autoReplyClaim.tailId,'hr-1');
 assert.equal(persisted.receipt,undefined);
 const conversation=app.state.memories[task.peerId],send=conversation.sends.find(s=>s.taskId===task.id);
 assert.equal(send.status,'skip');assert.equal(send.receipt,undefined);
 assert.equal(conversation.decisions.find(d=>d.taskId===task.id).status,'skip');
 const decorated=structuredClone(original);decorated.messages.at(-1).time='10:00';
 const same=(await api('/api/replies/enqueue',decorated)).reply;
 assert.notEqual(same.id,queued.id);
 const sameTerminal=await until(async()=>{const row=(await api('/api/replies/state')).items.find(r=>r.id===same.id);return row?.status==='skip'&&row;});
 assert.match(sameTerminal.reason,/更新的HR来信/);
 const old=(await api('/api/prepare',{...original,messages:[earlier]}));
 assert.equal(old.skipped,true);assert.equal(calls.length,1);
 // An exact account-side message remains unattributed, even if the user sends
 // the preserved draft manually after taking over.
 const outgoing={id:'site-self',role:'self',text:result.text};
 await api('/api/observe',{...original,messages:[...original.messages,outgoing]});
 assert.equal(task.receipt,undefined);
 const next=input(task.peerId,'hr-next','这条虚构消息是稍后收到的新问题。');
 next.messages.unshift(...original.messages,outgoing);
 const fresh=(await api('/api/replies/enqueue',next)).reply;
 await until(()=>calls.length===2);calls[1].resolve(result);
 const newTask=await until(()=>app.state.tasks.find(t=>t.id!==task.id&&t.peerId===task.peerId));
 assert.equal(newTask.replyAnchor,'hr-next');assert.equal(newTask.action,'send_text');
 assert.equal((await api('/api/replies/state')).items.find(r=>r.id===fresh.id).status,'ready');
});

test('人工接手结论要求浏览器完成、正常自动回复捕获和仍有效的租约',async t=>{
 const {api,calls,app}=await fixture(t);
 for(const [i,scenario] of ['owner-completion','missing-browser-capture','stale-snapshot'].entries()){
  const request=input('boss:'+scenario),queued=(await api('/api/replies/enqueue',request)).reply;
  await until(()=>calls.length===i+1);calls[i].resolve(result);
  const task=await until(()=>app.state.tasks.find(t=>t.peerId===request.peerId));
  const claimed=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},scenario!=='missing-browser-capture');
  assert(claimed.lease);assert.equal(!!claimed.task.autoReplyClaim,scenario!=='missing-browser-capture');
  if(scenario==='stale-snapshot')await api('/api/observe',{...request,messages:[...request.messages,{id:'changed-hr',role:'hr',text:'会话已变化'}]});
  const reply=await api('/api/complete',{id:task.id,lease:claimed.lease,success:false,outcome:'manual_editor_takeover',evidence:'虚构的待核对证据'},scenario!=='owner-completion');
  assert.equal(reply.executionStatus,'uncertain');
  const row=(await api('/api/replies/state')).items.find(r=>r.id===queued.id);
  assert.equal(row.status,'done');assert.match(row.reason,/待核对/);
 }
});

test('模型失败按退避保留请求，旧入口兼容，队列不能接收招呼或无触发的历史',async t=>{
 const {api,calls,app}=await fixture(t);assert.equal((await api('/api/replies/enqueue',{...input(),kind:'greeting'})).http,400);assert.equal((await api('/api/replies/enqueue',{...input(),trigger:'history'})).http,400);
 const queued=await api('/api/replies/enqueue',input());calls[0].resolve(Promise.reject(Error('fixture model failed')));const failed=await until(async()=>{const row=(await api('/api/replies/state')).items.find(r=>r.id===queued.reply.id);return row.status==='failed'&&row;});assert(failed.retryAt>Date.now());await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,1);assert.equal(app.state.config.running,true);
 assert.equal(failed.retryScheduled,true);
 const oldRequest=api('/api/prepare',input('boss:legacy'));await until(()=>calls.length===2);calls[1].resolve(result);assert.equal((await oldRequest).task.status,'pending');
});

const completion=value=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]})});
const modelRequest=body=>{
 const request=JSON.parse(body),payload=JSON.parse(request.messages.at(-1).content);
 return {model:request.model,peerId:payload.memory?.peerId,messageId:payload.messages?.at(-1)?.id};
};
const queueRow=async(api,id,status)=>until(async()=>{
 const row=(await api('/api/replies/state')).items.find(row=>row.id===id);
 return row?.status===status&&row;
});

test('HTTP 401 保留当前回复、停止同凭据重试；换密钥直接恢复，简历与 429 行为独立',async t=>{
 const realNow=Date.now;
 let advance=0,privateBodyReads=0;
 t.mock.method(Date,'now',()=>realNow()+advance);
 const calls=[],oldKey='fixture-rejected-openai-key',newKey='fixture-repaired-openai-key';
 const {app,api,local}=await fixture(t,{providerFetcher:async(_url,{body,headers})=>{
  const request=modelRequest(body),oldCredential=headers.Authorization===`Bearer ${oldKey}`;
  const previous=calls.find(row=>row.peerId===request.peerId);
  calls.push({...request,oldCredential});
  if(!request.peerId)return completion({ok:true});
  if(oldCredential)return {ok:false,status:401,json:async()=>{privateBodyReads++;throw Error('fixture-private-upstream-body');}};
  if(request.peerId==='boss:transient'&&!previous)return {ok:false,status:429};
  return completion(result);
 }});
 const updateKey=key=>api('/api/provider-key',{provider:'openai',key},false);
 assert.equal((await updateKey(oldKey)).http,200);
 assert.equal((await api('/api/config',{autoResume:true,allowSiteDefaultResume:true,profile:{resumeName:'fixture-resume.pdf'},modelRoutes:{reply:{provider:'openai',model:'fixture-reply'}}},false)).http,200);
 const first=(await api('/api/replies/enqueue',input())).reply;
 const blocked=await queueRow(api,first.id,'auth_blocked');
 assert.equal(Object.hasOwn(blocked,'retryAt'),false);
 assert.equal(Object.hasOwn(blocked,'retryScheduled'),false);
 assert.match(blocked.reason,/401.*模型与联网.*API 密钥/);
 const second=(await api('/api/replies/enqueue',input('boss:queue-b'))).reply;
 await queueRow(api,second.id,'auth_blocked');
 const latestInput=input('boss:queue-a','hr-latest','您好，能继续了解下策划实习吗？');
 const latest=(await api('/api/replies/enqueue',latestInput)).reply;
 await queueRow(api,latest.id,'auth_blocked');
 await queueRow(api,first.id,'stale');
 assert.equal((await api('/api/replies/enqueue',latestInput)).reply.id,latest.id);
 advance=600000;
 await new Promise(resolve=>setTimeout(resolve,40));
 assert.equal(calls.length,1);
 assert.equal((await updateKey(oldKey)).http,200);
 await queueRow(api,latest.id,'auth_blocked');
 assert.equal(calls.length,1);
 assert.equal((await api('/api/test',{stage:'greeting'},false)).http,200);
 const resume={...input('boss:resume','hr-resume','请发一下简历'),resumeUI:{requestPending:true,agreeEnabled:true,requestMessageId:'hr-resume'}};
 const resumeRow=(await api('/api/replies/enqueue',resume)).reply;
 const readyResume=await queueRow(api,resumeRow.id,'ready');
 assert.equal(app.state.tasks.find(task=>task.id===readyResume.taskId).action,'send_resume');
 assert.equal(calls.filter(call=>call.peerId).length,1);

 assert.equal((await updateKey(newKey)).http,200);
 await queueRow(api,latest.id,'ready');
 await queueRow(api,second.id,'ready');
 assert.equal(calls.filter(call=>call.peerId==='boss:queue-a'&&call.messageId==='hr-1').length,1);
 assert(calls.some(call=>call.peerId==='boss:queue-a'&&call.messageId==='hr-latest'&&!call.oldCredential));
 assert.equal(calls.filter(call=>call.peerId==='boss:queue-b').length,1);
 const transient=(await api('/api/replies/enqueue',input('boss:transient'))).reply;
 const waiting=await queueRow(api,transient.id,'failed');
 assert.equal(waiting.retryScheduled,true);
 assert(waiting.retryAt>Date.now());
 advance+=16000;
 await queueRow(api,transient.id,'ready');
 assert.equal(calls.filter(call=>call.peerId==='boss:transient').length,2);
 assert.equal(app.state.config.channels.hrInbox,true);
 assert.equal(privateBodyReads,0);
 const serialized=readFileSync(join(local,'state.json'),'utf8');
 for(const privateValue of [oldKey,newKey,'fixture-private-upstream-body'])assert(!serialized.includes(privateValue));
});

test('改回复模型或成功测试同一个模型可恢复保留消息；关闭通道清除旧输入',async t=>{
 const calls=[];let confirmed=false;
 const {api}=await fixture(t,{providerFetcher:async(_url,{body})=>{
  const request=modelRequest(body);calls.push(request);
  return confirmed||request.model==='fixture-healthy'?completion(request.peerId?result:{ok:true}):{ok:false,status:401};
 }});
 const changeModel=model=>api('/api/config',{modelRoutes:{reply:{provider:'deepseek',model}}},false);
 assert.equal((await changeModel('fixture-rejected')).http,200);
 const first=(await api('/api/replies/enqueue',input())).reply;
 await queueRow(api,first.id,'auth_blocked');
 assert.equal((await changeModel('fixture-healthy')).http,200);
 await queueRow(api,first.id,'ready');

 assert.equal((await changeModel('fixture-rejected')).http,200);
 const stopped=(await api('/api/replies/enqueue',input('boss:stopped'))).reply;
 await queueRow(api,stopped.id,'auth_blocked');
 assert.equal((await api('/api/channels',{hrInbox:false},false)).http,200);
 await queueRow(api,stopped.id,'stale');
 assert.equal((await api('/api/channels',{hrInbox:true},false)).http,200);
 const second=(await api('/api/replies/enqueue',input('boss:queue-b'))).reply;
 await queueRow(api,second.id,'auth_blocked');
 confirmed=true;
 assert.equal((await api('/api/test',{stage:'reply'},false)).http,200);
 await queueRow(api,second.id,'ready');
 assert.deepEqual(calls.map(call=>[call.model,call.peerId]),[
  ['fixture-rejected','boss:queue-a'],['fixture-healthy','boss:queue-a'],['fixture-rejected',undefined],['fixture-rejected','boss:queue-b']
 ]);
});

test('重启丢失退避或模型认证等待的输入后，仅凭新的会话观察重新入队',()=>{
 const peerId='fixture-restart';
 const memory={peerId,revision:1,fingerprint:'fixture'};
 const state={config:{running:true,chatRead:true},tasks:[],memories:{[peerId]:memory},
  replyQueue:[{id:'old',peerId,status:'failed',revision:1,fingerprint:'fixture',retryAt:Date.now()+10000,
   signature:JSON.stringify([peerId,1,'fixture','new_hr_message',''])},{id:'parked',peerId,status:'auth_blocked',revision:1,fingerprint:'fixture'}]};
 const queue=createReplyQueue({state,persist(){},capacity:()=>false});
 const [row]=queue.rows();
 assert.equal(row.status,'stale');
 assert.equal(Object.hasOwn(row,'retryScheduled'),false);
 assert.equal(Object.hasOwn(row,'retryAt'),false);
 assert.equal(queue.rows()[1].status,'stale');
 const fresh=queue.enqueue(input(peerId),memory);
 assert.notEqual(fresh.id,row.id);
 assert.equal(fresh.status,'queued');
});

test('回复导航按实际发送条件筛选，审核、时段、配额和全局执行锁仍生效',async t=>{
 const {api,calls,app}=await fixture(t);
 const request=input(),queued=await api('/api/replies/enqueue',request);
 calls[0].resolve(result);await until(()=>app.state.tasks.length===1);
 const task=app.state.tasks[0],{config}=app.state;
 const eligible=async()=>(await api('/api/replies/state')).items.find(row=>row.id===queued.reply.id).sendEligible;
 assert.equal(await eligible(),true);
 assert.equal((await api('/api/replies/enqueue',request)).reply.sendEligible,true);
 config.mode='review';assert.equal(await eligible(),false);
 await api('/api/review',{id:task.id,approve:true},false);assert.equal(await eligible(),true);
 config.browserCalibrated=false;assert.equal(await eligible(),false);config.browserCalibrated=true;
 config.chatInput=false;assert.equal(await eligible(),false);config.chatInput=true;
 const otherHour=(new Date(Date.now()+8*3600000).getUTCHours()+1)%24;
 Object.assign(config.limits,{hoursStart:otherHour,hoursEnd:otherHour+1});assert.equal(await eligible(),false);
 Object.assign(config.limits,{hoursStart:0,hoursEnd:24,intervalSeconds:60});app.state.lastAction=Date.now();assert.equal(await eligible(),false);
 config.limits.intervalSeconds=0;config.limits.dailyMessages=1;
 app.state.tasks.push({id:'another-reply',status:'sent',reservedAt:Date.now()});assert.equal(await eligible(),false);
 config.limits.dailyMessages=30;app.state.tasks.at(-1).status='executing';assert.equal(await eligible(),false);
 app.state.tasks.pop();assert.equal(await eligible(),true);
 const lease=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint});assert(lease.lease);
 assert.equal(await eligible(),false);
});

test('旧同步入口已生成的同一草稿被队列复用，不把“已处理”当生成失败反复重试',async t=>{
 const {api,calls,app}=await fixture(t);const legacy=api('/api/prepare',input());await until(()=>calls.length===1);calls[0].resolve(result);const task=(await legacy).task;
 const queued=await api('/api/replies/enqueue',input());const ready=await until(async()=>{const row=(await api('/api/replies/state')).items.find(r=>r.id===queued.reply.id);return row.status==='ready'&&row;});assert.equal(ready.taskId,task.id);assert.equal(app.state.tasks.length,1);assert.equal(calls.length,1);
});

test('非限额配置变更作废生成中及排队消息；不得沿用旧资料自动继续',async t=>{
 const {api,calls,app}=await fixture(t);await api('/api/replies/enqueue',input());await api('/api/replies/enqueue',input('boss:queue-b'));await api('/api/replies/enqueue',input('boss:queue-c'));
 const update=await api('/api/config',{minScore:65},false);assert.equal(update.http,200);assert(calls.every(c=>c.signal.aborted));await new Promise(r=>setTimeout(r,30));assert((await api('/api/replies/state')).items.every(r=>r.status==='stale'));assert.equal(calls.length,2);assert.equal(app.state.tasks.length,0);assert.equal(app.state.config.running,true);
});
