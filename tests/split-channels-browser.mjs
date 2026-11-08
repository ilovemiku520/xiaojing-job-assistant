// Isolated console only. No BOSS navigation, real model or HR messages.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.BOSS_PLAYWRIGHT||'../tools/node/node_modules/playwright');
const port=await testPort(),pending=[],calls=[];
const desktop=process.env.XIAOJING_CHANNELS_DESKTOP==='1';
const app=createApplication({port,desktop,local:mkdtempSync(join(tmpdir(),'whale-channels-ui-')),key:'fixture',inference:async()=>{throw Error('No background model calls expected');},ownerInference:async(payload)=>{
 const summary=`**已记录这条专属指令：${payload.owner_instruction}**\n\n1. 检查当前状态\n2. 保留任务队列\n\n<img src=x onerror="window.fixtureInjected=true">`;
 calls.push(payload);return new Promise(resolve=>pending.push(()=>resolve({text:JSON.stringify({summary,nextSteps:[]})})));
}});
if(desktop){
 app.state.config.backend='harness';
 for(const stage of ['owner','autonomy'])app.state.config.modelRoutes[stage]={provider:'harness',model:app.state.config.model};
}
await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
async function api(path,data){const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':session.token},...(data?{body:JSON.stringify(data)}:{})});const value=await response.json();if(!response.ok)throw Error(value.error);return value;}
async function until(check){for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('Console state did not settle');}
const browser=await chromium.launch({headless:true,channel:'msedge'}),output=join(process.cwd(),'work','split-channels-ui');mkdirSync(output,{recursive:true});
try{
 await api('/api/config',{mode:'auto',browserCalibrated:true,learningEnabled:false,profile:{name:'测试主人',titles:['游戏策划'],cities:['北京'],facts:'仅隔离测试使用的虚构资料'}});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 if(desktop)await page.addInitScript(()=>{window.xiaojingDesktop={onEmbeddedState(){},onBrowserProgress(){}};});
 await page.goto(base);await page.locator('[data-channel-toggle="jobSearch"]').first().waitFor();
 const overviewSwitch=key=>page.locator('#overview [data-channel-toggle="'+key+'"]');
 await until(async()=>await overviewSwitch('hrInbox').getAttribute('aria-checked')==='false');
 await api('/api/worker-health',{phase:'两个自动通道均已关闭',extensionVersion:'0.13.0',lastWorkAt:Date.now()});await page.evaluate(()=>refresh());
 assert.equal(await page.locator('#m-browser').innerText(),desktop?'桥接在线':'扩展在线');assert.equal(app.state.config.running,false);
 await overviewSwitch('hrInbox').click();await until(()=>app.state.config.channels?.hrInbox===true);assert.equal(app.state.config.channels.jobSearch,false);
 await overviewSwitch('jobSearch').click();await until(()=>app.state.config.channels?.jobSearch===true);assert.equal(app.state.config.channels.hrInbox,true);
 await overviewSwitch('hrInbox').click();await until(()=>app.state.config.channels?.hrInbox===false);assert.equal(app.state.config.channels.jobSearch,true);
 await overviewSwitch('jobSearch').click();await until(()=>app.state.config.channels?.jobSearch===false);assert.equal(app.state.config.channels.hrInbox,false);
 await page.getByRole('button',{name:'自主求职',exact:true}).click();await page.locator('#autonomy-form').locator('..').locator('summary').click();
 const goal=page.locator('#autonomy-goal'),saveGoal=page.locator('#autonomy-form button');
 const acceptedGoal=Promise.withResolvers(),releaseGoal=Promise.withResolvers();
 await page.route('**/api/autonomy',async route=>{
  const response=await route.fetch();acceptedGoal.resolve();await releaseGoal.promise;await route.fulfill({response});
 },{times:1});
 await goal.fill('寻找合适的游戏策划实习岗位');await saveGoal.click();await acceptedGoal.promise;
 await goal.fill('保存期间新增的后续目标');await page.locator('#autonomy-toggle').focus();
 assert(await saveGoal.isDisabled());releaseGoal.resolve();
 await page.getByText('已保存提交时的目标，之后的编辑仍保留。',{exact:true}).waitFor();
 assert.equal(await goal.inputValue(),'保存期间新增的后续目标');
 assert.equal(app.state.autonomy.goal,'寻找合适的游戏策划实习岗位');
 await saveGoal.click();await until(()=>app.state.autonomy.goal==='保存期间新增的后续目标');assert.equal(app.state.config.running,false);
 await page.locator('#channel-prompt-jobSearch').fill('只在自主求职对话记住这条要求');
 await page.getByRole('button',{name:'HR 实时回复',exact:true}).click();await page.locator('#channel-prompt-hrInbox').fill('只在 HR 对话记住回复要求');
 await page.getByRole('button',{name:'自主求职',exact:true}).click();assert.equal(await page.locator('#channel-prompt-jobSearch').inputValue(),'只在自主求职对话记住这条要求');
 await page.locator('#channel-submit-jobSearch').click();await until(()=>calls.length===1);
 await page.getByRole('button',{name:'HR 实时回复',exact:true}).click();assert.equal(await page.locator('#channel-prompt-hrInbox').inputValue(),'只在 HR 对话记住回复要求');await page.locator('#channel-submit-hrInbox').click();
 await until(()=>app.state.ownerTasks.filter(t=>t.sourceChannel).length===2);pending.shift()();await until(()=>calls.length===2);pending.shift()();await until(()=>app.state.ownerTasks.filter(t=>t.sourceChannel&&t.status==='done').length===2);
 await page.evaluate(()=>refresh());const jobId=app.state.channelConversations.jobSearch,hrId=app.state.channelConversations.hrInbox;assert(jobId&&hrId&&jobId!==hrId);
 if(desktop){
  await page.getByRole('button',{name:'自主求职',exact:true}).click();
  await page.locator('#channel-log-jobSearch').getByText('已记录这条专属指令：只在自主求职对话记住这条要求').waitFor();
  await page.getByRole('button',{name:'HR 实时回复',exact:true}).click();
  await page.locator('#channel-log-hrInbox').getByText('已记录这条专属指令：只在 HR 对话记住回复要求').waitFor();
 }
 assert((await page.locator('#channel-log-jobSearch').innerText()).includes('只在自主求职对话记住这条要求'));assert(!(await page.locator('#channel-log-jobSearch').innerText()).includes('只在 HR 对话记住回复要求'));
 assert((await page.locator('#channel-log-hrInbox').innerText()).includes('只在 HR 对话记住回复要求'));assert(!(await page.locator('#channel-log-hrInbox').innerText()).includes('只在自主求职对话记住这条要求'));assert.equal(app.state.config.running,false);
 const answer=page.locator('#channel-log-hrInbox .owner-answer');
 assert.equal(await answer.locator('strong').count(),1);
 assert.equal(await answer.locator('ol > li').count(),2);
 assert.equal(await answer.locator('img').count(),0);
 assert.match(await answer.textContent(),/<img src=x onerror=/);
 assert.equal(await page.evaluate(()=>window.fixtureInjected),undefined);
 const screenshots=[];for(const width of [1440,768,390]){await page.setViewportSize({width,height:1000});for(const name of ['overview','job-channel','hr-channel']){await page.evaluate(name=>panel(name),name);await page.screenshot({path:join(output,`${name}-${width}.png`),fullPage:true});screenshots.push(`${name}-${width}.png`);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal page overflow');}}
 assert.deepEqual(errors,[]);assert.equal(app.state.tasks.length,0);assert.equal(calls.length,2);
 writeFileSync(join(output,'result.json'),JSON.stringify({fourCombinations:true,independentDrafts:true,independentConversations:true,goalSaveDoesNotStart:true,onlyOwnerFixtures:2,realHRsContacted:0,screenshots},null,2));
 if(process.env.BOSS_CHANNELS_INSPECT_SCRIPT){
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),run=promisify(execFile);
  for(const name of ['job-channel','hr-channel']){
   try{const report=await run(process.execPath,[process.env.BOSS_CHANNELS_INSPECT_SCRIPT,base+'/#'+name,'--app','--out',join(output,'inspect-'+name)],{cwd:process.cwd(),maxBuffer:200000});writeFileSync(join(output,'inspect-'+name+'.log'),report.stdout+report.stderr);}
   catch(error){writeFileSync(join(output,'inspect-'+name+'.log'),(error.stdout||'')+(error.stderr||'')+error.message);console.log('Inspect report recorded for '+name);}
  }
 }
 console.log('四种开关组合、独立草稿/对话、目标保存不启动、三宽无横向溢出均通过；没有真实模型或 HR 消息。');
}finally{for(const finish of pending)finish();await browser.close();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});}
