// The console uses local synthetic records only. Browser routes block all other origins.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {testPort} from './port.mjs';

const temp=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temp,'xiaojing-channel-retry-')));
const port=await testPort(),origin=`http://127.0.0.1:${port}`,knowledge=join(local,'knowledge');
let app,browser,ownerToken;
async function api(path,data,token=ownerToken){
 const response=await fetch(origin+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':token},...(data?{body:JSON.stringify(data)}:{})});
 const result=await response.json();assert(response.ok,result.error);return result;
}
async function until(check){
 for(let attempt=0;attempt<100;attempt++){
  const value=await check();if(value)return value;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw Error('测试状态未到达');
}
const job={title:'游戏策划实习生',company:'模拟游戏公司',city:'北京',experience:'在校/应届',url:'https://www.zhipin.com/job_detail/fixture.html',description:'面向在校实习生，负责游戏玩法设计、规则原型、系统文档和测试，结合基础技能完成跨团队项目协作。'};
const decision={action:'send_text',text:'你好，想了解一下合成的游戏策划实习。',reason:'合成测试',score:90};
const previousKnowledge=process.env.BOSS_KNOWLEDGE_DIR;
try{
 mkdirSync(knowledge);
 for(const name of ['12_人格与主人权限.txt','01_系统规则.txt'])writeFileSync(join(knowledge,name),'合成测试规则');
 for(const name of ['13_机器人与主人记忆.json','02_个人事实.json','03_求职偏好.json','04_项目与游戏记忆.json'])writeFileSync(join(knowledge,name),'{}');
 process.env.BOSS_KNOWLEDGE_DIR=knowledge;
 const {createApplication}=await import('../server/app.mjs');
 app=createApplication({port,local,workspace:local,desktop:true,key:'fixture',greetingIntervalMs:3600000,autonomyIntervalMs:3600000,
  inference:async()=>decision,ownerInference:async payload=>{
   assert.equal(payload.runtime.sourceChannel,'hrInbox');
   await api('/api/owner-chat',{kind:'read',requestId:'fixture-tool:'+payload.ownerTaskId,instruction:'合成读取任务',targets:[{name:'测试HR',company:job.company}]});
   return {text:'已安排读取合成会话。'};
  }});
 app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
 ownerToken=(await(await fetch(origin+'/api/session')).json()).token;
 const bapi=(path,data)=>api(path,data,app.embeddedToken);
 await api('/api/config',{mode:'auto',browserCalibrated:true,learningEnabled:false,profile:{name:'合成主人',facts:'合成经历',cities:['北京'],titles:['游戏策划']},limits:{hoursStart:0,hoursEnd:24,intervalSeconds:0}});
 await api('/api/channels',{jobSearch:true,hrInbox:true});
 await bapi('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/jobs',diagnostics:{extensionVersion:'0.13.3',adapter:'0.13.3'}});
 await bapi('/api/jobs/observe',{jobs:[job]});
 browser=await chromium.launch({headless:true,channel:'msedge'});
 const context=await browser.newContext();
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await context.addInitScript(()=>window.xiaojingDesktop={onEmbeddedState(){},onBrowserProgress(){},onVersionMismatch(){},embedded:async()=>({})});

 async function retryAfterReload(channel,panel,prompt,plans,finishFirst){
  const page=await context.newPage(),errors=[],posts=[];
  page.on('pageerror',error=>errors.push(error.message));
  const isTurn=request=>request.url()===origin+'/api/channels/turn'&&request.method()==='POST';
  page.on('request',request=>{if(isTurn(request))posts.push(request.postDataJSON());});
  await page.goto(origin+'/#'+panel);
  const input=page.locator('#channel-prompt-'+channel),send=page.locator('#channel-submit-'+channel);
  await input.waitFor();
  let first;
  await page.route(origin+'/api/channels/turn',async route=>{
   const response=await route.fetch();assert.equal(response.status(),200);first=await response.json();
   await route.abort('failed');
  },{times:1});
  await input.fill(prompt);await send.click();await page.locator('#notice.error').waitFor();
  assert(first?.task.id);assert.equal(posts[0].conversationId,first.conversationId);
  const raw=await page.evaluate(()=>sessionStorage.getItem('xiaojing-channel-pending-requests'));
  const digest=createHash('sha256').update(JSON.stringify(['channel:'+channel,first.conversationId,prompt])).digest('hex');
  assert.deepEqual(JSON.parse(raw),[{id:posts[0].requestId,digest}]);assert(!raw.includes(prompt));
  await finishFirst(first.task);

  await page.reload();await input.waitFor();
  await page.locator('#channel-log-'+channel).getByText(prompt,{exact:true}).waitFor();
  assert.equal(posts.length,1);assert.equal(await input.inputValue(),'');
  async function sendSamePrompt(){
   const pending=page.waitForResponse(response=>isTurn(response.request()));
   await input.fill(prompt);await send.click();
   const response=await pending;assert.equal(response.status(),200);
   const result=await response.json();
   await page.waitForFunction(key=>!document.getElementById('channel-submit-'+key).disabled&&document.getElementById('channel-prompt-'+key).value==='',channel);
   return result;
  }
  const retry=await sendSamePrompt();
  assert.equal(retry.task.id,first.task.id);assert.equal(retry.conversationId,first.conversationId);
  assert.equal(posts[1].requestId,posts[0].requestId);
  assert.deepEqual(plans().map(plan=>plan.ownerTaskId),[first.task.id]);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('xiaojing-channel-pending-requests'))),[]);
  const next=await sendSamePrompt();
  assert.notEqual(next.task.id,first.task.id);assert.equal(next.conversationId,first.conversationId);
  assert.notEqual(posts[2].requestId,posts[0].requestId);
  await until(()=>plans().length===2);
  assert.deepEqual(plans().map(plan=>plan.ownerTaskId),[first.task.id,next.task.id]);
  assert.deepEqual(errors,[]);await page.close();
 }

 await retryAfterReload('jobSearch','job-channel','请向一位HR打招呼',()=>app.state.greetingPlans,async ownerTask=>{
  const plan=app.state.greetingPlans.find(item=>item.ownerTaskId===ownerTask.id);assert(plan);
  const {job:reading}=await bapi('/api/crawl/next',{});assert(reading);
  await bapi('/api/crawl/complete',{id:reading.id,lease:reading.lease,url:reading.url,success:true,job});
  const task=await until(async()=>(await bapi('/api/work')).task);assert.equal(task.greetingPlanId,plan.id);
  const {lease,blocked}=await bapi('/api/claim',{id:task.id,url:task.job.url});assert(lease,blocked);
  const binding=await bapi('/api/greetings/target',{id:task.id,lease,name:'测试HR',company:job.company,messages:[]});assert(binding.allowed,binding.blocked);
  await bapi('/api/complete',{id:task.id,lease,success:true,evidence:'合成回执'});
  assert.equal(plan.status,'done');assert.equal(plan.sent,1);
 });
 await retryAfterReload('hrInbox','hr-channel','请读取合成会话记录',()=>app.state.ownerChats,async ownerTask=>{
  const plan=await until(()=>app.state.ownerChats.find(item=>item.ownerTaskId===ownerTask.id));
  const {id:targetId,name,company}=plan.targets[0];
  const result=await bapi('/api/owner-chat/prepare',{planId:plan.id,targetId,name,company,uniquePeer:true,header:'测试HR 模拟游戏公司 HR',job,messages:[{id:'fixture-read',role:'hr',text:'合成对话内容'}]});
  assert.equal(result.read,true);assert.equal(plan.status,'done');
 });
 console.log('Both dedicated channels reuse acknowledged task identity after a lost response and reload. Explicit repeats after acknowledgement remain new.');
}finally{
 if(browser)await browser.close();
 if(app?.server.listening){const closed=once(app.server,'close');app.shutdown();await closed;}
 if(previousKnowledge===undefined)delete process.env.BOSS_KNOWLEDGE_DIR;else process.env.BOSS_KNOWLEDGE_DIR=previousKnowledge;
 assert.equal(dirname(local),temp);rmSync(local,{recursive:true,force:true});
}
