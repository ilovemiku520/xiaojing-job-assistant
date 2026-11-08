import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {testPort} from './port.mjs';

const resources=resolve(process.argv[2]||fileURLToPath(new URL('../',import.meta.url)));
process.env.BOSS_KNOWLEDGE_DIR=join(resources,'desktop','starter');
const {createApplication}=await import(pathToFileURL(join(resources,'server','app.mjs')));
const temp=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temp,'xiaojing-reply-recovery-ui-')));
assert.equal(dirname(local),temp);
const port=await testPort(),base=`http://127.0.0.1:${port}`;
let modelCalls=0,browser,releaseDetail;
const app=createApplication({local,workspace:local,desktop:true,port,key:'fixture-only',inference:async()=>{modelCalls++;throw Error('界面验证不调用模型');}});

try{
  app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
  const {token}=await(await fetch(base+'/api/session')).json();
  async function post(path,data,adapter=false){
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Boss-Token':adapter?app.embeddedToken:token},body:JSON.stringify(data)});
    const result=await response.json();assert(response.ok,result.error);return result;
  }
  await post('/api/config',{chatRead:true,learningEnabled:false,profile:{name:'模拟主人',facts:'合成求职资料',titles:['游戏策划'],cities:['北京']}});
  const peerId='boss:fixture-recovery-ui',anchor='original-hr-mid',body='您好，主人想了解策划实习机会。';
  const {revision,fingerprint}=await post('/api/observe',{peerId,header:'模拟 HR',messages:[{id:anchor,role:'hr',text:'是否还在看实习？'},{id:'observed-self',role:'self',text:'我方另一条已观察消息'}]},true);
  const now=Date.now(),task={id:'legacy-uncertain',kind:'reply',sourceChannel:'hrInbox',action:'send_text',status:'uncertain',peerId,replyAnchor:anchor,stableMessageIds:true,memoryRevision:revision,fingerprint,text:body,job:{title:'模拟可关闭岗位',company:'模拟甲公司'},createdAt:now,reservedAt:now,updatedAt:now,evidence:'模拟原发送结果待核对'};
  const priorSend={taskId:task.id,at:now,action:'send_text',text:body,status:'uncertain',evidence:task.evidence};
  app.state.memories[peerId].sends.push({...priorSend});
  app.state.tasks.push(task,{...task,id:'missing-stable-conversation',peerId:'boss:unread-recovery-ui',job:{title:'模拟待读取岗位',company:'模拟乙公司'}});

  browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),requests=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST')requests.push({path:new URL(request.url()).pathname,data:request.postDataJSON()});});
  await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await page.goto(base);
  await page.locator('[data-panel="control"]').click();
  await page.locator('#operation-filter').selectOption('attention');
  const board=page.locator('#operation-board'),detail=page.locator('#operation-detail');
  const inspect=title=>board.locator('.op-card').filter({hasText:title}).getByRole('button',{name:'查看详情',exact:true}).click();
  const close=detail.getByRole('button',{name:'结束本次待核对',exact:true});
  await inspect('模拟待读取岗位');
  await detail.getByText(/需要先读取此会话/).waitFor();
  assert.equal(await close.count(),0);
  await inspect('模拟可关闭岗位');
  await detail.getByText(/只处理之后确认的新来信/).waitFor();
  const staleClose=await close.elementHandle();
  const held=Promise.withResolvers(),entered=Promise.withResolvers();
  releaseDetail=held.resolve;
  const holdDetail=async route=>{
    if(route.request().postDataJSON().id!=='missing-stable-conversation'){await route.continue();return;}
    entered.resolve();await held.promise;await route.continue();
  };
  await page.route('**/api/operations/detail',holdDetail);
  await inspect('模拟待读取岗位');
  await entered.promise;
  await staleClose.evaluate(button=>button.click());
  const wasVisible=await detail.isVisible();
  releaseDetail();await page.unroute('**/api/operations/detail',holdDetail);
  await detail.getByText(/需要先读取此会话/).waitFor();
  assert.equal(wasVisible,false,'the previous task detail must hide while a different task loads');
  assert.equal(task.status,'uncertain','a stale detail must not close the previous task');
  assert.equal(requests.some(request=>request.path==='/api/replies/close-uncertain'),false);

  const failed=Promise.withResolvers(),failedEntered=Promise.withResolvers(),staleError='模拟旧详情请求失败';
  releaseDetail=failed.resolve;
  const failOldDetail=async route=>{
    if(route.request().postDataJSON().id!==task.id){await route.continue();return;}
    failedEntered.resolve();await failed.promise;
    await route.fulfill({status:503,json:{error:staleError}});
  };
  await page.route('**/api/operations/detail',failOldDetail);
  await inspect('模拟可关闭岗位');await failedEntered.promise;
  await inspect('模拟待读取岗位');await detail.getByText(/需要先读取此会话/).waitFor();
  const rejected=page.waitForResponse(response=>response.url().endsWith('/api/operations/detail')&&response.status()===503);
  releaseDetail();await (await rejected).finished();await page.unroute('**/api/operations/detail',failOldDetail);
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal((await page.locator('#notice').textContent()).includes(staleError),false,'a stale detail error must not reach the new selection');

  await inspect('模拟可关闭岗位');
  await close.waitFor();
  await close.focus();await close.press('Enter');
  await detail.getByText('已结束本次待核对',{exact:true}).waitFor();
  await detail.getByText('原发送结果仍未核实。',{exact:true}).waitFor();
  assert.equal(await close.count(),0);
  assert.equal(await detail.evaluate(node=>document.activeElement===node),true);
  await board.locator('.op-card').filter({hasText:'模拟可关闭岗位'}).waitFor({state:'detached'});
  assert.deepEqual(requests.filter(request=>request.path==='/api/replies/close-uncertain'),[{path:'/api/replies/close-uncertain',data:{taskId:task.id}}]);
  assert.equal(requests.some(request=>['/api/claim','/api/replies/enqueue','/api/prepare','/api/complete'].includes(request.path)),false);
  assert.deepEqual(app.state.memories[peerId].sends,[priorSend]);
  assert.equal(app.state.tasks.find(row=>row.id==='missing-stable-conversation').status,'uncertain');
  assert.equal(modelCalls,0);assert.deepEqual(errors,[]);
  console.log('Task Center closed one legacy uncertain reply by keyboard, preserved its outcome and made no send.');
}finally{
  releaseDetail?.();
  if(browser)await browser.close();
  if(app.server.listening){const closed=once(app.server,'close');app.shutdown();await closed;}
  rmSync(local,{recursive:true,force:true,maxRetries:3,retryDelay:150});
}
