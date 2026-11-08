// Synthetic website and mocked model only. No real BOSS account or HR traffic.
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');
let models=0,ownerModels=0;const port=await testPort(),app=createApplication({port,local:mkdtempSync(join(tmpdir(),'whale-greet-browser-')),key:'fixture',greetingIntervalMs:3600000,inference:async(config,key,context)=>{models++;assert.equal(context.kind,'greeting');assert(context.job.description.length>=40);assert(context.job.company);assert.equal(context.job.city,'北京');return {action:'send_text',text:'你好，我是小鲸，帮主人了解游戏策划实习，想问问目前是否还在招聘？',reason:'虚构完整JD匹配',score:90};},ownerInference:async()=>{ownerModels++;throw Error('简单命令不应空等主人模型');}});
await new Promise(r=>app.server.listen(port,'127.0.0.1',r));const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
const api=async(path,data,owner=true)=>{const r=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(data?{body:JSON.stringify(data)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const browser=await chromium.launch({headless:true,channel:'msedge'});
let worker=null,crawler=null;const sent=[],provisional=[];
const opensInline=i=>[2,3,5].includes(i);
const inlineDialog=i=>`<template id="fixture-dialog"><div class="startchat-dialog"><div class="startchat-title"><div class="boss-info"><div class="name">${i===5?'其他招聘方':`测试${i}女士`}</div><div class="position">虚构游戏${i}·招聘者</div></div></div><div class="startchat-content"><div class="message"><ul class="message-list">${i===2?'<li class="message-item"><span class="status success">已发送</span><p class="text">网站已自动发出默认招呼</p></li>':''}</ul></div><div class="edit-area"><textarea class="input-area"></textarea><div class="send-message disable">发送</div></div></div></div></template>
<script>function openFixtureDialog(){
 document.body.append(document.querySelector('#fixture-dialog').content.cloneNode(true));
 const dialog=document.querySelector('.startchat-dialog'),editor=dialog.querySelector('.input-area'),button=dialog.querySelector('.send-message');
 editor.addEventListener('input',()=>button.classList.toggle('disable',!editor.value));
 button.onclick=async()=>{
  const row=document.createElement('li');row.className='message-item';
  const status=document.createElement('span');status.className='status sending';status.textContent='发送中';
  const text=document.createElement('p');text.className='text';text.textContent=editor.value;
  row.append(status,text);dialog.querySelector('.message-list').append(row);
  row.id='new-sent-${i}';
  await window.fixtureProvisional(${i});await window.fixtureSent(${i});
  setTimeout(()=>{status.className='status success';status.textContent='已发送';},150);
 };
}</script>`;
const detail=i=>`<!doctype html><meta charset="utf-8"><div class="job-banner"><div class="name"><h1>游戏策划实习生</h1></div><span class="text-city">北京</span><span class="salary">面议</span><button class="btn-startchat" onclick="${opensInline(i)?'openFixtureDialog()':`location.href='/web/geek/chat?fixture=${i}'`}">立即沟通</button></div><div class="job-boss-info"><h2 class="name">测试${i}女士<i></i><span>刚刚在线</span></h2></div><div class="job-detail-company"><span class="company-name">虚构游戏${i}</span></div><div class="job-detail-container"><div class="job-sec-text">岗位面向2027届校招生和在校实习生，负责游戏玩法原型、系统规则和设计文档，参与统计分析和体验测试，并与程序协作完善项目。</div></div>${opensInline(i)?inlineDialog(i):''}`;
const chat=i=>`<!doctype html><meta charset="utf-8"><div class="friend-list"><div class="friend-content selected"><div class="title-box"><span class="name-box"><span class="name-text">测试${i}女士</span></span><span>虚构游戏${i}</span></div></div></div><div class="chat-conversation"><div class="top-info-content">测试${i}女士 虚构游戏${i}</div><div id="messages"><div class="message-item item-friend" data-mid="hr-${i}"><span class="text">欢迎了解游戏策划实习</span></div></div></div><div class="chat-editor"><textarea id="chat-input"></textarea><button class="btn-send" disabled>发送</button></div><script>const editor=document.querySelector('textarea'),button=document.querySelector('.btn-send');editor.addEventListener('input',()=>button.disabled=!editor.value);button.onclick=()=>{const m=document.createElement('div');m.className='message-item item-myself';m.dataset.mid='new-sent-${i}';const text=document.createElement('span');text.className='text';text.textContent=editor.value;m.append(text);document.querySelector('#messages').append(m);window.fixtureSent(${i});editor.value='';button.disabled=true;};</script>`;
try{
 await api('/api/config',{browserCalibrated:true,learningEnabled:false,mode:'auto',limits:{hoursStart:0,hoursEnd:24},profile:{name:'测试主人',titles:['游戏策划'],cities:['北京'],facts:'2027届在校生，虚构资料',earlyCareerOnly:true}});
 const jobs=[1,2,3,4,5].map(i=>({title:'游戏策划实习生',url:`https://www.zhipin.com/job_detail/fixtureg${i}.html`}));await api('/api/jobs/observe',{jobs},false);
 const {task:owner}=await api('/api/owner-task',{requestId:'greet-browser-three',prompt:'小鲸帮我向三位hr打招呼'});assert.equal(owner.status,'done');assert.match(owner.result,/0\/3/);assert.equal(ownerModels,0);
 const ownerGreetingPlanId=owner.greetingPlanId;assert(ownerGreetingPlanId);
 assert.equal((await api('/api/browser-state',undefined,false)).config.jobSearchRunning,false);
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://www.zhipin.com/**',route=>{const u=new URL(route.request().url()),i=Number(u.searchParams.get('fixture')||u.pathname.match(/fixtureg(\d+)/)?.[1]);return route.fulfill({contentType:'text/html',body:u.pathname.startsWith('/job_detail/')?detail(i):chat(i)});});
 await page.exposeFunction('fixtureSent',i=>sent.push(i));
 await page.exposeFunction('fixtureProvisional',i=>provisional.push([i,app.state.tasks.find(task=>task.id===worker?.taskId)?.status]));
 await page.exposeFunction('fixtureMessage',async m=>{
  if(m.type==='chatMonitor')return {ok:true,result:{monitor:true}};if(m.type==='worker')return {ok:true,result:worker};if(m.type==='crawlWorker')return {ok:true,result:crawler};
  if(m.type==='saveClaim'){worker.claimed=m.claimed;return {ok:true,result:{}};}
  if(m.type==='crawlDone'){crawler=null;return {ok:true,result:{}};}
  if(m.type==='workerDone'){worker=null;return {ok:true,result:{}};}
  if(m.type==='api'){if(m.path==='/api/heartbeat')m.data.diagnostics.extensionVersion='0.10.0';return {ok:true,result:await api(m.path,m.data,false)};}
  return {ok:true,result:null};
 });
 await page.addInitScript(()=>{const fixtureValues={};window.chrome={storage:{local:{get:async key=>({[key]:fixtureValues[key]}),set:async patch=>Object.assign(fixtureValues,patch)}},runtime:{id:'fixture',sendMessage:m=>window.fixtureMessage(m),onMessage:{addListener:fn=>window.wake=fn}}};});
 await page.addInitScript({content:['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')).join('\n')});
 // Warm up the authenticated extension heartbeat without reading a real page.
 await api('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/jobs',diagnostics:{extensionVersion:'0.10.0',adapter:'0.10.0'}},false);
 async function runJob(planId,i,expected){
  app.state.lastAction=0;app.state.lastCrawlAt=0;
  const {job}=await api('/api/crawl/next',{ownerGreetingPlanId:planId},false);assert.equal(job?.url,jobs[i-1].url);crawler={jobId:job.id,lease:job.lease};worker=null;
  await page.goto(job.url);for(let n=0;n<40&&crawler;n++)await page.waitForTimeout(100);assert.equal(crawler,null,'实际DOM应完成详情采集');
  const {task:description}=await api('/api/work',undefined,false);assert(description);const task=app.state.tasks.find(t=>t.id===description.id);worker={taskId:task.id,job:task.job,greetingPlanId:task.greetingPlanId};
  await page.goto(task.job.url);
  if(opensInline(i)){
   await page.locator('.startchat-dialog').waitFor({timeout:5000});
   await page.evaluate(()=>new Promise(resolve=>window.wake({type:'assistant-read',command:'tick'},{id:'fixture'},resolve)));
  }
  for(let n=0;n<100&&!['sent','skip','uncertain'].includes(task.status);n++)await page.waitForTimeout(100);
  assert.equal(task.status,expected,JSON.stringify({task,status:app.state.greetingPlans[0],url:page.url()}));
  if(expected==='sent'){assert(task.greetingPeerKey);assert(task.evidence.includes('new-sent-'+i));}
  return task;
 }
 await runJob(ownerGreetingPlanId,1,'sent');
 await runJob(ownerGreetingPlanId,2,'skip');
 await runJob(ownerGreetingPlanId,3,'sent');
 await runJob(ownerGreetingPlanId,4,'sent');
 assert.deepEqual(sent,[1,3,4]);assert.deepEqual(provisional,[[3,'executing']]);assert.equal(app.state.greetingPlans[0].sent,3);assert.equal(app.state.greetingPlans[0].status,'done');assert.equal((await api('/api/work',undefined,false)).task,null);
 const nextJob=Object.values(app.state.jobs).find(job=>job.url===jobs[4].url);
 const {plan}=await api('/api/greetings',{requestId:'inline-wrong-recipient',instruction:'测试向选定的一位招聘方打招呼',count:1,jobIds:[nextJob.id]});
 const blocked=await runJob(plan.id,5,'uncertain');
 assert.match(blocked.evidence,/招聘方与岗位不一致/);assert.deepEqual(sent,[1,3,4]);assert.equal(models,5);
 const ui=await browser.newPage();ui.on('pageerror',e=>errors.push(e.message));await ui.goto(base+'/#control');await ui.locator('.op-card').filter({hasText:'向 3 位新HR打招呼'}).waitFor();assert((await ui.locator('.op-card').filter({hasText:'向 3 位新HR打招呼'}).innerText()).includes('3/3 位HR已确认发送'));assert.deepEqual(errors,[]);
 console.log(JSON.stringify({greetingsConfirmed:3,inlineReceipt:true,inlineDefaultGreetingSkipped:true,inlineWrongRecipientBlocked:true,duplicateSends:0,jobSearchEnabled:false,missingCardFieldsResolvedFromRealFixtureDom:true,stoppedAtRequestedCount:true,ownerModelCalls:0,hrModelCalls:models,taskCenterShowsActualReceipts:true,realHRsContacted:0}));
}finally{await browser.close();await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});}
