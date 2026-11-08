import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const temp=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temp,'xiaojing-review-drafts-')));
assert.equal(dirname(local),temp);
const port=await testPort(),base=`http://127.0.0.1:${port}`,now=Date.now();
const app=createApplication({local,port,desktop:true,key:'fixture'});
for(const id of ['a','b'])app.state.tasks.push({id,status:'pending',kind:'reply',action:'send_text',text:`合成原稿 ${id}`,
  createdAt:now,job:{title:`岗位 ${id}`,company:'虚构企业',description:'合成岗位正文'}});
app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://www.zhipin.com/**',route=>route.abort());
  await page.addInitScript(()=>{window.xiaojingDesktop={onBrowserProgress(){},onEmbeddedState(){},onJobLink(){}};});
  await page.goto(base+'/');
  const card=id=>page.locator(`[data-review-task="${id}"]`);
  const draft=id=>card(id).locator('textarea');
  await draft('a').fill('保留尚未提交的 A 草稿');
  await page.locator('#filter').focus();
  await page.evaluate(()=>refresh());
  assert.equal(await draft('a').inputValue(),'保留尚未提交的 A 草稿');
  await draft('a').focus();
  await draft('a').evaluate(node=>node.setSelectionRange(2,4));
  app.state.tasks.find(task=>task.id==='b').reason='其他任务已更新';
  await page.evaluate(()=>refresh());
  assert.deepEqual(await draft('a').evaluate(node=>[document.activeElement===node,node.selectionStart,node.selectionEnd]),[true,2,4]);

  await page.locator('#main-nav [data-panel="jobs"]').click();
  await page.waitForFunction(()=>state.ownerTaskScope==='jobs');
  assert.deepEqual(await page.evaluate(()=>({tasks:state.tasks.length,attention:state.taskStats.attention})),{tasks:0,attention:2});
  await page.locator('#main-nav [data-panel="overview"]').click();
  await page.waitForFunction(()=>state.ownerTaskScope==='overview');
  assert.equal(await draft('a').inputValue(),'保留尚未提交的 A 草稿');
  assert.equal(await page.evaluate(()=>Object.hasOwn(state.tasks[0].job,'description')),false);

  for(const staleError of [true,false]){
    const jobsState=url=>url.pathname==='/api/state'&&url.searchParams.get('panel')==='jobs';
    const started=Promise.withResolvers(),held=Promise.withResolvers();
    await page.route(jobsState,async route=>{
      started.resolve();await held.promise;
      if(staleError)await route.fulfill({status:503,json:{error:'已离开的岗位页未连接'}});
      else await route.fulfill({response:await route.fetch()});
    },{times:1});
    const response=page.waitForResponse(result=>jobsState(new URL(result.url())));
    await page.locator('#main-nav [data-panel="jobs"]').click();await started.promise;
    await page.locator('#main-nav [data-panel="overview"]').click();held.resolve();
    await response;await page.waitForTimeout(50);
    assert.equal(await page.evaluate(()=>state.ownerTaskScope),'overview');
    assert.notEqual(await page.locator('#notice').textContent(),'已离开的岗位页未连接');
    assert.equal(await draft('a').inputValue(),'保留尚未提交的 A 草稿');
  }

  await page.route('**/api/review',route=>route.fulfill({status:503,json:{error:'模拟连接中断'}}),{times:1});
  await card('a').getByRole('button',{name:'批准发送'}).click();
  await page.getByText('模拟连接中断',{exact:true}).waitFor();
  assert.equal(await draft('a').inputValue(),'保留尚未提交的 A 草稿');
  assert.equal(app.state.tasks[0].status,'pending');
  await card('a').getByRole('button',{name:'批准发送'}).click();
  await card('a').getByText('已批准，待执行',{exact:true}).waitFor();
  assert.equal(await page.locator('#notice').textContent(),'已批准发送。');
  assert.equal(app.state.tasks[0].text,'保留尚未提交的 A 草稿');

  await draft('b').fill('这份编辑依赖旧会话');
  app.state.tasks.find(task=>task.id==='b').status='stale';
  await page.locator('#filter').selectOption('all');
  await page.evaluate(()=>refresh());
  assert.equal(await draft('b').inputValue(),'合成原稿 b');
  assert(await draft('b').evaluate(node=>node.readOnly));
  assert.deepEqual(errors,[]);
  console.log('Review drafts survive polling, navigation and failed saves; stale drafts never carry forward.');
}finally{
  await browser.close();await app.shutdown();rmSync(local,{recursive:true,force:true});
}
