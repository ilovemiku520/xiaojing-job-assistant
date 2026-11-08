import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const port = await testPort();
const local = mkdtempSync(join(tmpdir(),'xiaojing-jobs-ui-'));
const app = createApplication({port,local,desktop:true,inference:()=>{throw Error('岗位表无需调用模型');}});
const base = `http://127.0.0.1:${port}`;
const current = Date.now();
const samples = [
  ['系统策划实习生','逐浪工作室','北京','250–300 元/天','在校 / 应届','favorite','ready'],
  ['关卡策划实习生','白帆游戏','广州','220–280 元/天','在校','favorite','ready'],
  ['游戏策划（2027 届）','松林互娱','深圳','12–18K','应届','search','listed'],
  ['数值策划实习生','远山互动','北京','200–250 元/天','在校','search','reading'],
  ['游戏玩法策划','晚潮游戏','杭州','20–32K','3–5 年','search','ready'],
  ['关卡设计实习生','北岸工作室','广州','面议','','search','needs_adaptation'],
];
const makeJob = (index,sample) => {
  const [title,company,city,salary,experience,source,status] = sample;
  return {id:`fixture-${index}`,title,company,city,salary,experience,source,status,
    sources:index===1?['favorite','search']:[source],firstSeenAt:current-86400000,lastSeenAt:current-index*60000,
    description:status==='ready'?'参与原型设计、文档维护和关卡数据整理。和美术及程序一起核对玩法表现，记录每次测试的改动。':'',
    url:`https://www.zhipin.com/job_detail/fixture-${index}.html`,
    lease:'private-test-lease',hrName:'private-test-hr',chatHistory:['private-test-chat']};
};
app.state.config.profile = {...app.state.config.profile,titles:['策划'],cities:['北京','广州','深圳'],earlyCareerOnly:true};
app.state.jobs = Object.fromEntries(Array.from({length:31},(_,index) => {
  const row=makeJob(index,samples[index%samples.length]);
  return [row.id,row];
}));
app.state.tasks.push({id:'fixture-resume',kind:'reply',action:'send_resume',status:'sent',updatedAt:current,
  job:{url:app.state.jobs['fixture-0'].url},evidence:'同一HR会话出现新的附件发送结果：您的附件简历 测试... 已发送给Boss'});
app.state.memories['fixture-job-chat']={peerId:'fixture-job-chat',header:'样例招聘者 · 招聘方',domIdentity:{name:'样例招聘者'},
  job:{...app.state.jobs['fixture-0']},lastSeenAt:current,updatedAt:current,revision:1,
  history:[{id:'fixture-mid',eventId:'fixture-event',role:'hr',text:'这是合成的岗位沟通记录。',observedAt:current}],sends:[],decisions:[]};
app.jobWorkbook.refresh();
app.server.listen(port,'127.0.0.1');
await once(app.server,'listening');
assert.equal((await fetch(base+'/api/jobs/observe',{
  method:'POST',headers:{'X-Boss-Token':app.embeddedToken,'Content-Type':'application/json'},body:'{"jobs":[]}'
})).status,200);

const browser = await chromium.launch({channel:'msedge',headless:true});
try {
  const page = await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://www.zhipin.com/**',route=>route.abort());
  await page.addInitScript(() => {
    window.openedWorkbooks=0;
    window.xiaojingDesktop={onBrowserProgress(){},onEmbeddedState(){},openJobsWorkbook(){window.openedWorkbooks++;return Promise.resolve({ok:true});}};
  });
  await page.goto(base);
  await page.locator('.nav[data-panel="jobs"]').click();
  await page.waitForFunction(()=>document.querySelector('#jobs-page-summary').textContent.includes('共 31 条'));
  assert.equal(await page.locator('#jobs-table-body tr').count(),25);
  assert.equal(await page.locator('#jobs-table-scroll').evaluate(viewport=>viewport.scrollWidth<=viewport.clientWidth+1),true,'常用桌面尺寸下应完整显示日期列');
  assert.match(await page.locator('[data-jobs-source="favorite"]').textContent(),/收藏来源\s*11$/);
  assert.match(await page.locator('[data-jobs-source="search"]').textContent(),/21$/);
  const sync=page.locator('#jobs-sync-status'),announcement=page.locator('#jobs-sync-announcement');
  assert.equal(await sync.getAttribute('role'),null);
  assert.equal(await announcement.getAttribute('role'),'status');
  assert.match(await announcement.textContent(),/岗位表已更新。.*共 31 条/);
  await page.getByRole('button',{name:'打开实时工作簿 ↗',exact:true}).waitFor();
  await page.evaluate(()=>{
    const nodes=[document.getElementById('jobs-sync-status'),document.getElementById('jobs-sync-announcement')];
    const changes=[[],[]];
    const observers=nodes.map((node,index)=>{
      const observer=new MutationObserver(()=>changes[index].push(node.textContent));
      observer.observe(node,{childList:true,characterData:true,subtree:true});return observer;
    });
    window.jobsSyncFixture={realNow:Date.now,changes,observers};
  });
  let syncOverride;
  const syncRoute=async route=>{
    if(syncOverride==='error'){await route.fulfill({status:503,body:'fixture error'});return;}
    if(syncOverride==='full'){
      const response=await route.fetch({headers:{...route.request().headers(),'if-none-match':''}});
      await route.fulfill({response});return;
    }
    await route.continue();
  };
  const tablePattern='**/api/jobs/table?*';
  await page.route(tablePattern,syncRoute);
  async function syncOnce(offset,expected){
    const received=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/jobs/table'&&response.status()===expected);
    await page.evaluate(offset=>{Date.now=()=>window.jobsSyncFixture.realNow()+offset;return window.renderJobsTable();},offset);
    await received;
  }
  try{
    await syncOnce(2000,304);await syncOnce(4000,304);
    syncOverride='full';await syncOnce(6000,200);
    const [clock,speech]=await page.evaluate(()=>window.jobsSyncFixture.changes);
    assert.equal(new Set(clock).size,3,'每次成功检查仍更新可见时间');
    assert.deepEqual(speech,[],'缓存命中和内容相同的完整响应都不更新朗读区域');
    syncOverride='error';await syncOnce(8000,503);await syncOnce(10000,503);
    syncOverride='';await syncOnce(12000,304);
    assert.deepEqual(await page.evaluate(()=>window.jobsSyncFixture.changes[1]),['暂时无法更新岗位表','岗位表已恢复更新。']);
  }finally{
    await page.unroute(tablePattern,syncRoute);
    await page.evaluate(()=>{
      const {realNow,observers}=window.jobsSyncFixture;
      for(const observer of observers)observer.disconnect();
      Date.now=realNow;delete window.jobsSyncFixture;
    });
  }

  let releaseFavorite,releaseDetail;
  const favoriteGate=new Promise(resolve=>{releaseFavorite=resolve;});
  const detailGate=new Promise(resolve=>{releaseDetail=resolve;});
  const tableRequests=[],exportRequests=[];
  page.on('request',request=>{
    const url=new URL(request.url());
    if(url.pathname==='/api/jobs/export')exportRequests.push(Object.fromEntries(url.searchParams));
  });
  const tableRoute=async route=>{
    const {source,page}=Object.fromEntries(new URL(route.request().url()).searchParams);
    tableRequests.push({source,page});
    if(source==='favorite')await favoriteGate;
    if(source==='search')await route.fulfill({status:503,body:'fixture error'});
    else await route.continue();
  };
  const detailRoute=async route=>{await detailGate;await route.continue();};
  await page.route('**/api/jobs/table?*',tableRoute);
  await page.route('**/api/jobs/detail?*',detailRoute);
  try {
    const detailRequest=page.waitForRequest('**/api/jobs/detail?*');
    await page.evaluate(()=>{window.delayedJobDetail=document.querySelector('.jobs-detail-trigger').onclick();});
    await detailRequest;
    await page.locator('[data-jobs-source="favorite"]').click();
    assert.match(await page.locator('#jobs-page-summary').textContent(),/^上次结果/);
    assert(await page.locator('#jobs-next').isDisabled());
    assert(await page.locator('#jobs-export').isDisabled());
    assert(await page.locator('.jobs-detail-trigger').first().isDisabled());
    await page.evaluate(()=>{document.querySelector('#jobs-next').click();document.querySelector('#jobs-export').click();});
    releaseFavorite();
    await page.waitForFunction(()=>document.querySelector('#jobs-page-summary').textContent.startsWith('第 1–11 条'));
    assert(!tableRequests.some(request=>request.source==='favorite'&&request.page!=='1'));
    assert.deepEqual(exportRequests,[]);
    await page.locator('[data-jobs-source="search"]').click();
    await page.waitForFunction(()=>document.querySelector('#jobs-sync-status').dataset.kind==='error');
    assert.match(await page.locator('#jobs-page-summary').textContent(),/^上次结果/);
    assert.match(await page.locator('#jobs-sync-status').textContent(),/暂显示上次结果/);
    assert(await page.locator('#jobs-clear').isVisible());
    assert(await page.locator('#jobs-export').isDisabled());
    assert(await page.locator('.jobs-detail-trigger').first().isDisabled());
    releaseDetail();
    await page.evaluate(()=>window.delayedJobDetail);
    assert.equal(await page.locator('#jobs-detail').isVisible(),false);
  } finally {
    releaseFavorite();releaseDetail();
    await page.unroute('**/api/jobs/table?*',tableRoute);
    await page.unroute('**/api/jobs/detail?*',detailRoute);
  }
  await page.locator('#jobs-clear').click();
  await page.waitForFunction(()=>document.querySelector('#jobs-page-summary').textContent.startsWith('第 1–25 条')&&!document.querySelector('#jobs-next').disabled);
  await page.locator('#jobs-stage').selectOption('resume_sent');
  await page.waitForFunction(()=>document.querySelector('#jobs-page-summary').textContent.includes('共 1 条'));
  assert.match(await page.locator('#jobs-table-body .jobs-row-stage').textContent(),/简历已确认发送/);
  await page.locator('#jobs-clear').click();
  await page.waitForFunction(()=>document.querySelector('#jobs-page-summary').textContent.includes('共 31 条'));

  if (process.env.XIAOJING_JOBS_SCREENSHOTS) {
    const folder=process.env.XIAOJING_JOBS_SCREENSHOTS;
    mkdirSync(folder,{recursive:true});
    for (const width of [1440,768,390]) {
      await page.setViewportSize({width,height:900});
      await page.screenshot({path:join(folder,`jobs-${width}.png`),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:900});
  }
  await page.locator('#jobs-next').click();
  await page.waitForFunction(()=>document.querySelector('#jobs-page-label').textContent==='2 / 2');
  assert.equal(await page.locator('#jobs-table-body tr').count(),6);
  assert.match(await page.locator('#jobs-page-label').textContent(),/2 \/ 2/);
  await page.locator('#jobs-prev').click();
  const company = page.getByRole('button',{name:'公司',exact:true});
  await company.click();
  await page.waitForFunction(()=>document.querySelector('th[aria-sort="ascending"]')?.textContent.includes('公司'));
  assert.equal(await page.locator('th[aria-sort]').getAttribute('aria-sort'),'ascending');
  await company.click();
  await page.waitForFunction(()=>document.querySelector('th[aria-sort="descending"]')?.textContent.includes('公司'));
  assert.equal(await page.locator('th[aria-sort]').getAttribute('aria-sort'),'descending');

  await page.locator('[data-jobs-source="favorite"]').click();
  await page.locator('#jobs-query').fill('逐浪 北京');
  await page.locator('#jobs-fit').selectOption('matched');
  await page.waitForFunction(()=>document.querySelector('#jobs-page-summary').textContent.includes('共 6 条'));
  const row = page.locator('#jobs-table-body .jobs-detail-trigger').first();
  await row.click();
  await page.locator('#jobs-detail').waitFor({state:'visible'});
  assert.equal(await page.locator('#jobs-detail').isVisible(),true);
  assert.match(await page.locator('#jobs-detail-body').innerText(),/原型设计/);
  assert.match(await page.locator('#jobs-original').getAttribute('href'),/^https:\/\/www\.zhipin\.com\/job_detail\/fixture-\d+\.html$/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#jobs-detail').isVisible(),false);

  for (const format of ['xlsx','csv','json']) {
    await page.locator('#jobs-format').selectOption(format);
    const awaited = page.waitForEvent('download');
    await page.locator('#jobs-export').click();
    const download = await awaited;
    assert.match(download.suggestedFilename(),new RegExp(`^小鲸岗位_\\d{4}-\\d{2}-\\d{2}\\.${format}$`));
    const data=readFileSync(await download.path());
    if(format==='xlsx')assert.equal(data.subarray(0,2).toString(),'PK');
    if(format==='csv') {
      assert.equal(data.subarray(0,3).toString('hex'),'efbbbf');
      assert.match(data.toString(),/逐浪工作室/);
      assert.doesNotMatch(data.toString(),/白帆游戏|private-test/);
    }
    if(format==='json') {
      const snapshot=JSON.parse(data);
      assert.equal(snapshot.total,6);
      assert(snapshot.jobs.every(job=>job.company==='逐浪工作室'&&job.fit==='matched'));
      assert.doesNotMatch(data.toString(),/private-test/);
    }
  }
  assert.deepEqual(exportRequests.map(({q,source,fit,format})=>({q,source,fit,format})),['xlsx','csv','json'].map(format=>({q:'逐浪 北京',source:'favorite',fit:'matched',format})));
  assert(exportRequests.every(request=>!Object.hasOwn(request,'page')&&!Object.hasOwn(request,'pageSize')));
  let releaseExport;
  const exportGate=new Promise(resolve=>{releaseExport=resolve;});
  const exportRoute=async route=>{await exportGate;await route.continue();};
  await page.route('**/api/jobs/export?*',exportRoute);
  try {
    const requested=page.waitForRequest('**/api/jobs/export?*');
    const downloaded=page.waitForEvent('download');
    await page.locator('#jobs-export').click();await requested;
    await page.locator('#jobs-query').fill('没有这个合成岗位');
    await page.getByText('没有符合当前筛选的岗位',{exact:true}).waitFor();
    releaseExport();
    const data=JSON.parse(readFileSync(await (await downloaded).path()));
    assert.equal(data.total,6);assert(data.jobs.every(job=>job.company==='逐浪工作室'));
    assert.equal(exportRequests.at(-1).q,'逐浪 北京');
    assert(await page.locator('#jobs-export').isDisabled());
    assert.equal(await page.evaluate(()=>document.activeElement.id),'jobs-query');
    const placeholder=await page.evaluate(()=>{
      const input=document.querySelector('#jobs-query');input.value='逐浪 北京';input.dispatchEvent(new Event('input'));
      return document.querySelector('.jobs-empty-row strong').textContent;
    });
    assert.equal(placeholder,'上次结果为空');
  } finally {
    releaseExport();
    await page.unroute('**/api/jobs/export?*',exportRoute);
  }
  await page.locator('#jobs-live-workbook').click();
  assert.equal(await page.evaluate(()=>window.openedWorkbooks),1);
  await page.locator('#jobs-clear').click();
  const observed = await fetch(base+'/api/jobs/observe',{
    method:'POST',headers:{'X-Boss-Token':app.embeddedToken,'Content-Type':'application/json'},
    body:JSON.stringify({jobs:[makeJob(32,samples[0])]})
  });
  assert.equal(observed.status,200);
  await page.waitForFunction(()=>document.querySelector('#jobs-page-summary').textContent.includes('共 32 条'),{},{timeout:12000});
  assert.match(await announcement.textContent(),/岗位表已更新。.*共 32 条/);

  await page.setViewportSize({width:390,height:850});
  const layout = await page.locator('#jobs-table-scroll').evaluate(viewport=>{
    const title = viewport.querySelector('tbody .jobs-row-title');
    const start=title.getBoundingClientRect().left;
    viewport.scrollLeft=300;
    return {viewport:viewport.clientWidth,scroll:viewport.scrollWidth,start,end:title.getBoundingClientRect().left,titleWidth:title.getBoundingClientRect().width,page:document.documentElement.scrollWidth};
  });
  assert(layout.scroll>layout.viewport,'窄窗口使用表格内部滚动');
  assert.equal(layout.page,390,'窄窗口没有整页水平溢出');
  assert(layout.titleWidth>=130,'窄窗口保留可读的职位列');
  assert(Math.abs(layout.end-layout.start)<=1,'横向滚动时职位列保持冻结');
  await page.setViewportSize({width:1440,height:900});
  await page.locator('[data-jobs-source="favorite"]').click();
  await page.locator('#jobs-stage').selectOption('resume_sent');
  await page.locator('#jobs-page-size').selectOption('50');
  await page.locator('#jobs-format').selectOption('csv');
  await page.reload();
  await page.locator('.nav[data-panel="jobs"]').click();
  await page.waitForFunction(()=>document.querySelector('#jobs-page-summary').textContent.includes('共 1 条'));
  assert.equal(await page.locator('[data-jobs-source="favorite"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#jobs-stage').inputValue(),'resume_sent');
  assert.equal(await page.locator('#jobs-page-size').inputValue(),'50');
  assert.equal(await page.locator('#jobs-format').inputValue(),'csv');
  assert.equal(await page.locator('#jobs-query').inputValue(),'');
  await page.locator('#jobs-table-body .jobs-detail-trigger').click();
  await page.getByRole('button',{name:'打开 样例招聘者 的会话'}).click();
  await page.locator('#memory-messages').getByText('这是合成的岗位沟通记录。').waitFor();
  assert.equal(await page.locator('#memory-thread-title').textContent(),'样例招聘者');
  assert.equal(await page.locator('#jobs-detail').isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({pageSize:25,filters:true,staleActionsDisabled:true,downloads:['xlsx','csv','json'],liveWorkbook:true,liveRefresh:true,unchangedPollsQuiet:true,errorAndRecoveryAnnounced:true,newCountAnnounced:true,mobileFrozenTitle:true,realBOSSRequests:0}));
} finally {
  await browser.close();
  await app.shutdown();
}
