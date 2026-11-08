import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
import {channelRunning} from '../server/channels.mjs';
import {claimJob} from '../server/jobs.mjs';
const answer={action:'send_text',text:'你好，小鲸帮主人了解一下岗位。',reason:'隔离测试',score:90};
const message=(peer='boss:lane-a',id='hr1')=>({kind:'reply',trigger:'new_hr_message',peerId:peer,label:{name:'测试HR',company:'测试公司'},header:'测试HR 测试公司',messages:[{id,role:'hr',text:'你好，想了解主人的项目。'}]});
const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('状态等待超时');};
async function fixture(t,options={}){
 const local=options.local||mkdtempSync(join(tmpdir(),'whale-channels-')),port=await testPort(),app=createApplication({port,local,key:'fixture',inference:async()=>({...answer}),autonomyIntervalMs:10000000,...options});await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 let closed=false;const close=async()=>{if(closed)return;closed=true;await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});};t.after(close);
 const base=`http://127.0.0.1:${port}`,s=await(await fetch(base+'/api/session')).json();const api=async(path,data,owner=true)=>{const r=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?s.token:s.extensionToken},...(data?{body:JSON.stringify(data)}:{})});return {http:r.status,...await r.json()};};
 await api('/api/config',{mode:'auto',browserCalibrated:true,learningEnabled:false,autoGreet:false,limits:{hoursStart:0,hoursEnd:24,intervalSeconds:0},profile:{name:'虚构主人',facts:'2027届测试资料',titles:['游戏策划'],cities:['北京']}});return {app,api,local,close};
}
test('两个运行通道四种组合独立生效，扩展不能修改开关或发主人对话',async t=>{
 const {app,api}=await fixture(t);assert.equal((await api('/api/channels',{hrInbox:true},false)).http,403);assert.equal((await api('/api/channels/turn',{channel:'hrInbox',prompt:'hi',requestId:'x'},false)).http,403);
 for(const [jobSearch,hrInbox] of [[false,false],[true,false],[true,true],[false,true]]){
  const r=await api('/api/channels',{jobSearch,hrInbox});assert.equal(r.http,200);assert.equal(r.channels.jobSearch.running,jobSearch);assert.equal(r.channels.hrInbox.running,hrInbox);assert.equal(app.state.config.running,jobSearch||hrInbox);
  const browser=await api('/api/browser-state',undefined,false);assert.equal(browser.config.jobSearchRunning,jobSearch);assert.equal(browser.config.hrInboxRunning,hrInbox);
  app.state.jobs={j:{id:'j',url:'https://www.zhipin.com/job_detail/lane-job.html',title:'游戏策划实习',company:'虚构公司',city:'北京',status:'listed'}};app.state.lastCrawlAt=0;assert.equal(!!claimJob(app.state),jobSearch);
  const reply=await api('/api/prepare',message('boss:mode-'+jobSearch+'-'+hrInbox),false);assert.equal(reply.http,hrInbox?200:400);
 }
 assert.equal((await api('/api/channels',{unknown:true})).http,400);assert.equal((await api('/api/channels',{hrInbox:'yes'})).http,400);
});
test('关闭自主求职不会撤销已领取HR回复，关闭HR不会撤销自主招呼的执行',async t=>{
 const {app,api}=await fixture(t);await api('/api/channels',{jobSearch:true,hrInbox:true});const {task}=await api('/api/prepare',message(),false);const lease=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false);assert(lease.lease);
 const epoch=(await api('/api/browser-state',undefined,false)).config.watchEpoch;await api('/api/channels',{jobSearch:false});assert((await api('/api/check',{id:task.id,lease:lease.lease},false)).allowed);assert.equal((await api('/api/browser-state',undefined,false)).config.watchEpoch,epoch);
 await api('/api/complete',{id:task.id,lease:lease.lease,success:true,evidence:'隔离测试，HR回复回显'},false);assert.equal(app.state.tasks[0].status,'sent');
 await api('/api/channels',{jobSearch:true});app.state.tasks.unshift({id:'job-task',kind:'greeting',action:'send_text',status:'approved',sourceChannel:'jobSearch',job:{url:'https://www.zhipin.com/job_detail/lane-job.html',title:'游戏策划实习',company:'虚构公司',city:'北京'},text:'帮主人了解这个游戏策划实习。',fingerprint:'job-fp'});
 const jobLease=await api('/api/claim',{id:'job-task',url:'https://www.zhipin.com/job_detail/lane-job.html'},false);assert(jobLease.lease);await api('/api/channels',{hrInbox:false});assert((await api('/api/check',{id:'job-task',lease:jobLease.lease},false)).allowed);
 await api('/api/complete',{id:'job-task',lease:jobLease.lease,success:true,evidence:'隔离测试，招呼回显'},false);assert.equal(app.state.tasks[0].status,'sent');
});
test('本通道关闭撤销发送权限，重开不复活旧lease；迟到的真实回执仍可保存',async t=>{
 const {app,api}=await fixture(t);await api('/api/channels',{hrInbox:true});const {task}=await api('/api/prepare',message(),false),lease=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false);assert(lease.lease);
 await api('/api/channels',{hrInbox:false});assert.equal((await api('/api/check',{id:task.id,lease:lease.lease},false)).allowed,false);await api('/api/channels',{hrInbox:true});assert.equal((await api('/api/check',{id:task.id,lease:lease.lease},false)).allowed,false);
 assert.equal((await api('/api/complete',{id:task.id,lease:lease.lease,success:true,evidence:'关闭时已点发送，之后才出现本次真实回显'},false)).http,200);assert.equal(app.state.tasks[0].status,'sent');assert((await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false)).blocked);
});
test('关一方只取消该方生成与草稿，另一方生成保持；新HR事件重新观察仍可恢复',async t=>{
 const pending=[];const {app,api}=await fixture(t,{inference:async(c,k,context,signal)=>new Promise(resolve=>pending.push({context,signal,resolve}))});await api('/api/channels',{jobSearch:true,hrInbox:true});
 const hr=api('/api/prepare',message(),false);await wait(()=>pending.length===1);const job=api('/api/prepare',{kind:'greeting',job:{url:'https://www.zhipin.com/job_detail/parallel-lane.html',title:'游戏策划实习',company:'虚构公司',city:'北京'}},false);await wait(()=>pending.length===2);
 await api('/api/channels',{jobSearch:false});assert.equal(pending[0].signal.aborted,false);assert.equal(pending[1].signal.aborted,true);pending[1].resolve(answer);pending[0].resolve(answer);assert((await job).skipped);assert((await hr).task);
 await api('/api/channels',{hrInbox:false});assert.equal(app.state.tasks[0].status,'stale');assert.equal((await api('/api/replies/enqueue',message(),false)).http,400);await api('/api/channels',{hrInbox:true});
 const next=api('/api/prepare',message(),false);await wait(()=>pending.length===3);pending[2].resolve(answer);assert((await next).task);assert.equal(app.state.tasks.filter(t=>t.status==='pending').length,1);
});
test('专属对话持久隔离：不互喂prompt/结果，原生session ID与多轮上下文独立',async t=>{
 const calls=[];const {app,api}=await fixture(t,{ownerInference:async(payload,signal,options)=>{calls.push({payload,options});return {text:payload.runtime.sourceChannel==='jobSearch'?JSON.stringify({summary:'JOB_PRIVATE_RESULT',nextSteps:[]}):'HR_PRIVATE_RESULT',sessionId:'session-'+payload.runtime.sourceChannel};}});
 const channels=(await api('/api/channels')).channels;assert.notEqual(channels.jobSearch.conversationId,channels.hrInbox.conversationId);
 await api('/api/autonomy',{goal:'JOB_PRIVATE_GOAL：优先收藏中的游戏策划岗位'});
 const first=await api('/api/channels/turn',{channel:'jobSearch',prompt:'JOB_PRIVATE_PROMPT',requestId:'job-one'});await wait(()=>app.state.ownerTasks.find(t=>t.id===first.task.id).status==='done');
 const second=await api('/api/channels/turn',{channel:'hrInbox',prompt:'HR_PRIVATE_PROMPT',requestId:'hr-one'});await wait(()=>app.state.ownerTasks.find(t=>t.id===second.task.id).status==='done');assert(!JSON.stringify(calls[1].payload).includes('JOB_PRIVATE_'));
 const count=app.state.ownerTasks.length;
 const mismatch=await api('/api/channels/turn',{channel:'hrInbox',conversationId:first.conversationId,prompt:'错配的合成指令',requestId:'mismatch'});
 assert.equal(mismatch.http,400);assert.match(mismatch.error,/对话已变化/);assert.equal(app.state.ownerTasks.length,count);
 const retry=await api('/api/channels/turn',{channel:'hrInbox',conversationId:second.conversationId,prompt:'HR_PRIVATE_PROMPT',requestId:'hr-one'});
 assert.equal(retry.http,200);assert.equal(retry.task.id,second.task.id);assert.equal(app.state.ownerTasks.length,count);
 const third=await api('/api/owner-task',{conversationId:first.conversationId,prompt:'继续求职',requestId:'job-two'});await wait(()=>app.state.ownerTasks.find(t=>t.id===third.task.id).status==='done');assert.equal(app.state.ownerTasks.find(t=>t.id===third.task.id).sourceChannel,'jobSearch');assert.equal(calls[2].options.sessionId,'session-jobSearch');assert(!JSON.stringify(calls[2].payload).includes('HR_PRIVATE_'));assert.notEqual(first.conversationId,second.conversationId);
 assert.equal((await api('/api/channels/turn',{channel:'hrInbox',prompt:'JOB_PRIVATE_PROMPT',requestId:'job-one'})).http,400);assert.equal(channelRunning(app.state.config,'jobSearch'),false);assert.equal(channelRunning(app.state.config,'hrInbox'),false);
});
test('开启已有目标真正启用规划，重启保持两路暂停且对话归属不丢，旧总停仍撤销全部',async t=>{
 const f=await fixture(t);await f.api('/api/autonomy',{goal:'优先收藏并寻找游戏策划实习',enabled:false});await f.api('/api/channels',{jobSearch:true});assert.equal(f.app.state.autonomy.enabled,true);await f.api('/api/channels',{hrInbox:true});const ids=(await f.api('/api/channels')).channels;await f.close();
 const next=await fixture(t,{local:f.local});const channels=(await next.api('/api/channels')).channels;assert.equal(channels.jobSearch.running,false);assert.equal(channels.hrInbox.running,false);assert.equal(channels.jobSearch.conversationId,ids.jobSearch.conversationId);assert.equal(channels.hrInbox.conversationId,ids.hrInbox.conversationId);
 await next.api('/api/run',{running:true});assert.equal((await next.api('/api/channels')).channels.hrInbox.running,true);await next.api('/api/stop',{reason:'主人总停'});assert.equal(next.app.state.config.channels.jobSearch,false);assert.equal(next.app.state.config.channels.hrInbox,false);
});
