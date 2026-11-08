// Uses the real Electron console and native download lifecycle, with a disposable profile.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {_electron as electron} from '../tools/node/node_modules/playwright-core/index.mjs';
import {defaults} from '../server/core.mjs';
import {exportJobRows,projectJobRows} from '../server/job-exports.mjs';
import {testPort} from './port.mjs';

const temporary=realpathSync(tmpdir());
const home=realpathSync(mkdtempSync(join(temporary,'xiaojing-job-export-test-')));
assert.equal(dirname(home),temporary);
const local=join(home,'profile'),port=await testPort(),origin='http://127.0.0.1:'+port;
const fixture={id:'job-fixture',url:'https://www.zhipin.com/job_detail/export-fixture.html',title:'合成岗位',company:'合成工作室',city:'北京',lastSeenAt:Date.now(),status:'listed'};
const peerId='fixture:job-keyboard',memory={peerId,header:'模拟招聘者',job:{url:fixture.url},revision:1,lastSeenAt:Date.now(),
  history:[{id:'fixture-message',role:'hr',text:'合成会话正文。'}],decisions:[],sends:[]};
mkdirSync(local);
writeFileSync(join(local,'state.json'),JSON.stringify({config:structuredClone(defaults),tasks:[],events:[],snapshots:{},jobs:{[fixture.id]:fixture},memories:{[peerId]:memory}}));
const packaged=process.argv[2];
let app;
try {
  app=await electron.launch({executablePath:packaged||resolve('tools/cache/electron/runtime/electron.exe'),args:packaged?[]:[resolve('.')],
    env:{...process.env,XIAOJING_DESKTOP_HOME:home,XIAOJING_DESKTOP_PORT:String(port)},timeout:20000});
  const window=await app.firstWindow();
  const destinations=Object.fromEntries(['xlsx','csv','json'].map(format=>[format,join(home,'export.'+format)]));
  await app.evaluate(({session,shell},{destinations,origin})=>{
    const fixture=globalThis.jobExportFixture={downloads:[],opened:[],cancel:false};
    session.defaultSession.webRequest.onBeforeRequest({urls:['https://*/*']},(_details,callback)=>callback({cancel:true}));
    shell.openPath=async path=>{fixture.opened.push(path);return '';};
    session.defaultSession.on('will-download',(_event,item)=>{
      if(!item.getURL().startsWith('blob:'+origin+'/'))return;
      const extension=item.getFilename().split('.').at(-1);
      const download={extension};fixture.downloads.push(download);
      if(!fixture.cancel)item.setSavePath(destinations[extension]);
      item.once('done',(_event,state)=>{download.state=state;});
      queueMicrotask(()=>{download.options=item.getSaveDialogOptions();if(fixture.cancel)item.cancel();});
    });
  },{destinations,origin});

  let workbookOverride='writing';
  await window.route('**/api/jobs/table?*',async route=>{
    if(!workbookOverride){await route.continue();return;}
    const response=await route.fetch({headers:{...route.request().headers(),'if-none-match':''}});
    const body=await response.json();
    await route.fulfill({status:response.status(),headers:{'cache-control':'no-store'},json:{...body,workbook:{...body.workbook,state:workbookOverride,ready:false,pending:true}}});
  });
  await window.locator('.nav[data-panel="jobs"]').click();
  const workbook=window.locator('#jobs-live-workbook');
  await window.getByRole('button',{name:'正在生成工作簿…'}).waitFor();
  assert(await workbook.isDisabled());
  workbookOverride='error';
  await window.locator('#jobs-refresh').click();
  await window.getByRole('button',{name:'重试生成工作簿'}).waitFor();
  assert(await workbook.isEnabled());
  workbookOverride='';
  await window.locator('#jobs-refresh').click();
  await window.getByRole('button',{name:'打开实时工作簿 ↗'}).waitFor({timeout:10000});
  await workbook.click();
  await window.getByText('已打开实时工作簿。',{exact:true}).waitFor();
  assert.equal((await app.evaluate(()=>globalThis.jobExportFixture.opened)).length,1);

  const path=join(local,'exports','岗位实时.xlsx');
  const stale=exportJobRows(projectJobRows({jobs:{[fixture.id]:{...fixture,title:'已过时的合成岗位'}}}),'xlsx').body;
  writeFileSync(path,stale);
  const untouched=await window.evaluate(()=>window.xiaojingDesktop.openJobsWorkbook());
  assert.deepEqual(untouched,{ok:false,externallyChanged:true});
  assert.deepEqual(readFileSync(path),stale);
  await window.locator('#jobs-refresh').click();
  const rebuild=window.getByRole('button',{name:'重新生成实时工作簿',exact:true});
  await rebuild.waitFor();
  assert.match(await window.locator('#jobs-workbook-status').textContent(),/文件已被外部更改/);
  assert.deepEqual(readFileSync(path),stale);
  await rebuild.click();
  await window.getByText('已安排生成实时工作簿。',{exact:true}).waitFor();
  await window.getByRole('button',{name:'打开实时工作簿 ↗'}).waitFor({timeout:10000});
  assert.notDeepEqual(readFileSync(path),stale);
  unlinkSync(path);
  await window.locator('#jobs-refresh').click();
  await window.getByRole('button',{name:'生成实时工作簿',exact:true}).click();
  await window.getByText('已安排生成实时工作簿。',{exact:true}).waitFor();
  await window.getByRole('button',{name:'打开实时工作簿 ↗'}).waitFor({timeout:10000});
  assert(existsSync(path));

  const exportButton=window.locator('#jobs-export');
  await app.evaluate(()=>{globalThis.jobExportFixture.cancel=true;});
  await exportButton.click();
  await window.getByText('已取消保存岗位表。',{exact:true}).waitFor();
  assert(!existsSync(join(home,'export.xlsx')));
  await app.evaluate(()=>{globalThis.jobExportFixture.cancel=false;});
  for(const format of ['xlsx','csv','json']) {
    await window.locator('#jobs-format').selectOption(format);
    await exportButton.click();
    await window.waitForFunction(()=>!document.querySelector('#jobs-export').hasAttribute('aria-busy'));
    assert.equal(await window.locator('#notice').textContent(),'岗位表已保存。',format);
    const data=readFileSync(join(home,'export.'+format));
    if(format==='xlsx')assert.equal(data.subarray(0,2).toString(),'PK');
    if(format==='csv')assert.match(data.toString(),/合成工作室/);
    if(format==='json')assert.equal(JSON.parse(data).jobs[0].id,fixture.id);
  }
  const events=await app.evaluate(()=>globalThis.jobExportFixture.downloads);
  assert.deepEqual(events.map(event=>event.state),['cancelled','completed','completed','completed']);
  for(const event of events) {
    assert.deepEqual(event.options.filters[0].extensions,[event.extension]);
    assert.match(event.options.defaultPath,new RegExp('小鲸岗位_\\d{4}-\\d{2}-\\d{2}\\.'+event.extension+'$'));
  }
  const blocked=await window.evaluate(()=>window.xiaojingDesktop.saveJobsExport({url:'https://example.invalid/secret.xlsx',format:'xlsx',stamp:'2026-11-08'}).catch(error=>error.message));
  assert.match(blocked,/岗位导出文件无效/);

  const target=window.locator('[data-job-id="'+fixture.id+'"]'),jobDialog=window.locator('#jobs-detail');
  const focusedJob=()=>window.evaluate(()=>document.activeElement.dataset.jobId);
  const openDetail=async()=>{await target.focus();await window.keyboard.press('Enter');await jobDialog.waitFor();};
  const closeDetail=async()=>{await window.keyboard.press('Escape');await jobDialog.waitFor({state:'hidden'});};
  const addJobs=async(suffix,count=1)=>{
    const jobs=Array.from({length:count},(_,i)=>({url:`https://www.zhipin.com/job_detail/focus-${suffix}-${i}.html`,title:`合成岗位 ${suffix} ${i}`,company:'合成工作室',city:'北京'}));
    const {ids}=await window.evaluate(jobs=>api('/api/jobs/observe',{jobs}),jobs);
    assert.equal(ids.length,count);
    await window.evaluate(()=>window.renderJobsTable());
    await window.locator('[data-job-id="'+ids[0]+'"]').waitFor({state:'attached'});
    return ids;
  };
  await openDetail();await closeDetail();
  assert.equal(await focusedJob(),fixture.id,'保留原按钮时使用原生焦点恢复');
  await target.evaluate(node=>{node.dataset.fixtureFocus='old';});
  await openDetail();await addJobs('refresh');
  assert.equal(await target.getAttribute('data-fixture-focus'),null);
  await closeDetail();
  await window.waitForFunction(id=>document.activeElement.dataset.jobId===id,fixture.id);

  await openDetail();await addJobs('overlay');
  await window.evaluate(()=>{
    const dialog=document.createElement('dialog'),button=document.createElement('button');
    dialog.id='fixture-secondary-overlay';button.textContent='合成对话框';dialog.append(button);document.body.append(dialog);
    document.getElementById('jobs-detail').close();dialog.showModal();
  });
  await addJobs('overlay-refresh');
  await window.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await window.evaluate(()=>document.activeElement.parentElement?.id),'fixture-secondary-overlay');
  await window.evaluate(()=>{const dialog=document.getElementById('fixture-secondary-overlay');dialog.close();dialog.remove();});

  await openDetail();await addJobs('related');
  await jobDialog.getByRole('button',{name:'打开 模拟招聘者 的会话',exact:true}).click();
  await window.locator('#memory-thread-title').filter({hasText:'模拟招聘者'}).waitFor();
  assert.equal(await window.evaluate(()=>document.activeElement.id),'memory-thread-title');
  await window.locator('.nav[data-panel="jobs"]').click();await target.waitFor();

  await openDetail();await addJobs('evicted',Number(await window.locator('#jobs-page-size').inputValue()));
  await target.waitFor({state:'detached'});await closeDetail();
  await window.waitForFunction(()=>document.activeElement.id==='jobs-query');

  const visibleRows=window.locator('#jobs-table-body .jobs-detail-trigger');
  const surviving=visibleRows.nth(4),survivingId=await surviving.getAttribute('data-job-id');
  await surviving.focus();await addJobs('keyboard-survives');
  assert.equal(await focusedJob(),survivingId,'岗位还在本页时优先恢复同一岗位');
  const oldLast=await visibleRows.last().getAttribute('data-job-id');
  await visibleRows.last().focus();assert.equal(await focusedJob(),oldLast);
  await addJobs('keyboard-displaced');
  await window.locator('[data-job-id="'+oldLast+'"]').waitFor({state:'detached'});
  assert.equal(await focusedJob(),await visibleRows.last().getAttribute('data-job-id'),'岗位移出本页时留在原位置附近');
  await window.keyboard.press('Tab');
  assert.equal(await window.evaluate(()=>document.activeElement.id),'jobs-page-size');

  const [only]=await addJobs('keyboard-empty');
  const query=window.locator('#jobs-query'),onlyRow=window.locator('[data-job-id="'+only+'"]');
  await query.fill('keyboard-empty');
  await window.waitForFunction(()=>document.getElementById('jobs-page-summary').textContent.includes('共 1 条'));
  await onlyRow.focus();
  await window.evaluate(()=>api('/api/jobs/observe',{jobs:[{url:'https://www.zhipin.com/job_detail/focus-keyboard-empty-0.html',title:'合成岗位已改名',company:'合成工作室',city:'北京'}]}));
  await window.evaluate(()=>window.renderJobsTable());
  await onlyRow.waitFor({state:'detached'});
  assert.equal(await window.evaluate(()=>document.activeElement.id),'jobs-query','没有可聚焦行时回到岗位搜索');

  await query.fill('keyboard-visibility');
  await window.getByText('没有符合当前筛选的岗位',{exact:true}).waitFor();
  const [anchorId]=await addJobs('keyboard-visibility-anchor');
  const anchor=window.locator('[data-job-id="'+anchorId+'"]');
  const measureAnchor=()=>anchor.evaluate(node=>{
    const viewport=document.getElementById('jobs-table-scroll'),clip=viewport.getBoundingClientRect(),row=node.getBoundingClientRect();
    const header=document.querySelector('#jobs-table-head th').getBoundingClientRect();
    return {focused:node===document.activeElement,index:node.closest('tr').sectionRowIndex+1,
      visible:row.bottom>Math.max(0,clip.top,header.bottom)&&row.top<Math.min(innerHeight,clip.bottom),
      scroll:viewport.scrollTop,pageScroll:window.scrollY};
  });
  await anchor.focus();
  const beforeReorder=await measureAnchor();
  assert.equal(beforeReorder.index,1);assert.equal(beforeReorder.visible,true);
  await addJobs('keyboard-visibility-newer',24);
  const afterReorder=await measureAnchor();
  assert.equal(afterReorder.index,25);assert.equal(afterReorder.focused,true);assert.equal(afterReorder.visible,true);
  assert.ok(afterReorder.scroll>beforeReorder.scroll,'同一岗位重排到屏幕外时需要滚动使焦点可见');

  const refreshAnchor=async()=>{
    await anchor.evaluate(node=>{node.dataset.fixtureVisibility='before';});
    await window.evaluate(()=>api('/api/jobs/observe',{jobs:[{url:'https://www.zhipin.com/job_detail/focus-keyboard-visibility-newer-0.html',title:'合成岗位 keyboard-visibility-newer 0',company:'合成工作室',city:'北京'}]}));
    await window.evaluate(()=>window.renderJobsTable());
    await window.waitForFunction(id=>!document.querySelector('[data-job-id="'+id+'"]').hasAttribute('data-fixture-visibility'),anchorId);
    return measureAnchor();
  };
  assert.deepEqual(await refreshAnchor(),afterReorder,'焦点仍可见时保留滚动位置');
  await window.evaluate(()=>{document.getElementById('jobs-table-scroll').scrollTop=0;window.scrollTo(0,0);});
  const intentional=await measureAnchor();
  assert.equal(intentional.focused,true);assert.equal(intentional.visible,false);
  assert.deepEqual(await refreshAnchor(),intentional,'用户主动滚离焦点后，刷新不拉回');
  console.log(JSON.stringify({nativeDownloads:['cancelled','xlsx','csv','json'],workbookFirstWrite:true,workbookRecreated:true,workbookExternalRebuild:true,dialogFocusRestoredByJobId:true,dialogFocusFallsBackToSearch:true,relatedAndOverlayKeepFocus:true,rowFocusExactOrNearest:true,emptyPageFocusesSearch:true,reorderedFocusVisible:true,visibleAndOffscreenScrollPreserved:true}));
} finally {
  await app?.close();
  rmSync(home,{recursive:true,force:true,maxRetries:3,retryDelay:150});
}
