import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const port=await testPort();
const app=createApplication({port,local:mkdtempSync(join(tmpdir(),'xiaojing-control-focus-')),inference:()=>{throw Error('界面测试无需模型');}});
const now=Date.now(),base=`http://127.0.0.1:${port}`;
const makeTask=(id,company,status)=>({id,kind:'greeting',job:{title:'虚构实习岗位',company},status,action:'send_text',text:'您好，想了解这个实习岗位。',reason:'模拟审核记录',createdAt:now,updatedAt:now});
const pending=makeTask('pending','待审游戏公司','pending');
const sent=makeTask('sent','已送达游戏公司','sent');
const decision={id:'decision-a',status:'needs_owner_decision',header:'模拟 HR',summary:'请确认面试时间',at:now};
app.state.tasks.push(pending,sent);
for(let index=0;index<40;index++){
  const record=makeTask('archive-'+index,'历史岗位 '+index,'sent');
  record.updatedAt=now-(index+1)*60000;
  app.state.tasks.push(record);
}
app.state.ownerDecisions=[decision];
app.server.listen(port,'127.0.0.1');
await once(app.server,'listening');

const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
  const page=await browser.newPage({viewport:{width:1440,height:950}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://www.zhipin.com/**',route=>route.abort());
  await page.goto(base);
  await page.locator('[data-panel="control"]').click();
  await page.locator('#operation-board .op-card').first().waitFor();
  await page.waitForFunction(()=>document.querySelector('#operation-page').textContent==='1 / 2');
  assert.equal(await page.locator('#operation-board .op-card').count(),30);
  await page.locator('#operation-next').click();
  await page.waitForFunction(()=>document.querySelector('#operation-page').textContent==='2 / 2');
  assert.equal(await page.locator('#operation-board .op-card').count(),12);
  await page.locator('#operation-query').fill('历史岗位 39');
  await page.waitForFunction(()=>document.querySelector('#operation-summary').textContent.includes('匹配 1 项'));
  assert.match(await page.locator('#operation-board').innerText(),/历史岗位 39/);
  await page.locator('#operation-query').fill('');
  await page.waitForFunction(()=>document.querySelector('#operation-page').textContent==='1 / 2');
  await page.locator('#operation-filter').selectOption('attention');
  const rows=page.locator('#operation-board .op-card');
  await page.waitForFunction(()=>document.querySelector('#operation-board .op-card')?.textContent.includes('待审核')&&document.querySelectorAll('#operation-board .op-card').length===1);
  assert.equal(await rows.count(),1);
  assert.match(await rows.first().innerText(),/待审核/);
  assert.match(await page.locator('#operation-decisions').innerText(),/模拟 HR.*\n[\s\S]*请确认面试时间/);
  assert.equal(decision.status,'needs_owner_decision');

  await page.locator('#operation-filter').selectOption('all');
  await page.waitForFunction(()=>document.querySelectorAll('#operation-board .op-card').length===30);
  await page.evaluate(()=>{window.firstCard=document.querySelector('#operation-board .op-card');});
  await page.evaluate(()=>window.refreshControl());
  assert.equal(await page.evaluate(()=>window.firstCard===document.querySelector('#operation-board .op-card')),true);

  const pendingCard=rows.filter({hasText:'待审游戏公司'}),details=pendingCard.getByRole('button',{name:'查看详情',exact:true});
  await details.focus();
  pending.reason='模拟更新：刚复核了岗位';
  await page.evaluate(()=>window.refreshControl());
  assert.equal(await details.evaluate(button=>button===document.activeElement),true);
  assert.doesNotMatch(await pendingCard.innerText(),/刚复核了岗位/);
  await page.locator('#operation-query').focus();
  await page.waitForFunction(()=>document.querySelector('#operation-board').textContent.includes('刚复核了岗位'));

  await details.click();
  const detail=page.locator('#operation-detail');
  await detail.waitFor({state:'visible'});
  assert.equal(await detail.evaluate(node=>node===document.activeElement),true);
  const review=detail.getByRole('button',{name:'到工作台审核',exact:true});
  await review.focus();
  await page.evaluate(()=>window.refreshControl());
  assert.equal(await review.evaluate(button=>button===document.activeElement),true);
  await review.click();
  assert.equal(await page.locator('#overview').isVisible(),true);
  assert.equal(pending.status,'pending','进入审核界面不改变待审核状态');
  await page.locator('#tasks .task').filter({hasText:'待审游戏公司'}).getByRole('button',{name:'批准发送',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#tasks').textContent.includes('已批准，待执行'));
  assert.equal(pending.status,'approved','继续走原有人工批准流程');
  assert.equal(app.state.config.running,false);

  await page.locator('[data-panel="control"]').click();
  await page.locator('#operation-filter').selectOption('attention');
  await page.waitForFunction(()=>!document.querySelector('#operation-board').textContent.includes('待审游戏公司'));
  const complete=page.getByRole('button',{name:'标为已处理',exact:true});
  await complete.click();
  await page.locator('#operation-decisions').waitFor({state:'hidden'});
  assert.equal(decision.status,'resolved');
  assert.equal(pending.status,'approved','处理个人决定不修改发送任务');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({pagedHistory:true,globalSearch:true,pendingInAttention:true,decisionsVisible:true,unchangedDom:true,focusPreserved:true,manualReviewPreserved:true,realMessagesSent:0}));
}finally{
  await browser.close();
  await app.shutdown();
}
