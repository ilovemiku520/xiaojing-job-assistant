import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync} from 'node:fs';
import {rename} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {inflateRawSync} from 'node:zlib';
import {createApplication} from '../server/app.mjs';
import {setChannelFlags} from '../server/channels.mjs';
import {createJobWorkbook} from '../server/job-workbook.mjs';
import {exportJobRows,projectJobRows} from '../server/job-exports.mjs';
import {testPort} from './port.mjs';

const sample = {
  id:'fixture-job',
  url:'https://www.zhipin.com/job_detail/fixture.html',
  title:'测试岗位',
  company:'示例工作室',
  city:'测试城市',
  salary:'10–12K',
  lastSeenAt:1794000000000,
  status:'listed'
};

async function until(check, timeout=4500) {
  const deadline = Date.now()+timeout;
  while (!check() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,30));
  assert(check(), '工作簿未在期限内更新');
}

function workbookPart(zip,part) {
  for(let offset=0;zip.readUInt32LE(offset)===0x04034b50;){
    const length=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extraLength=zip.readUInt16LE(offset+28);
    const name=zip.subarray(offset+30,offset+30+nameLength).toString();
    const start=offset+30+nameLength+extraLength;
    if(name===part)return inflateRawSync(zip.subarray(start,start+length)).toString();
    offset=start+length;
  }
  assert.fail('未找到工作簿部件 '+part);
}
const workbookSheet=file=>workbookPart(readFileSync(file),'xl/worksheets/sheet1.xml');

function quitWorkbook(t,options={}) {
  const temporary=realpathSync(tmpdir());
  const directory=realpathSync(mkdtempSync(join(temporary,'xiaojing-workbook-quit-')));
  assert.equal(dirname(directory),temporary);
  let title=sample.title;
  const workbook=createJobWorkbook({directory,rows:()=>projectJobRows({jobs:{id:{...sample,title}}}),delayMs:5,...options});
  t.after(()=>{workbook.close();rmSync(directory,{recursive:true,force:true});});
  return {workbook,change(next){title=next;workbook.refresh();}};
}

test('退出时接续正在生成的工作簿，只写最新岗位版本',async t=>{
  const release=Promise.withResolvers(),written=[];
  let generating=false;
  const {workbook,change}=quitWorkbook(t,{
    async generate(rows){
      if(rows[0].title==='过时写入'){generating=true;await release.promise;}
      return exportJobRows(rows,'xlsx');
    },
    async replace(from,to){await rename(from,to);written.push(workbookSheet(to));}
  });
  workbook.refresh();
  await until(()=>workbook.status().ready&&!workbook.status().pending);
  change('过时写入');
  await until(()=>generating);
  change('退出前最新岗位');
  const finished=workbook.flushAndClose();
  assert.equal(workbook.flushAndClose(),finished);
  release.resolve();
  await finished;
  assert.equal(written.length,2);
  assert.match(written[1],/退出前最新岗位/);
  assert.doesNotMatch(written[1],/过时写入/);
  assert.equal(workbook.status().pending,false);
});

test('退出时对已暂存的占用工作簿只再尝试一次，保留旧文件',async t=>{
  let locked=false,attempts=0,generated=0;
  const {workbook,change}=quitWorkbook(t,{
    retryMs:800,
    generate(rows){generated++;return exportJobRows(rows,'xlsx');},
    async replace(from,to){attempts++;if(locked)throw Object.assign(Error('locked'),{code:'EPERM'});await rename(from,to);}
  });
  workbook.refresh();
  await until(()=>workbook.status().ready&&!workbook.status().pending);
  const previous=readFileSync(workbook.file);
  locked=true;
  change('被占用时的新岗位');
  await until(()=>workbook.status().state==='locked');
  assert.equal(attempts,2);
  await workbook.flushAndClose();
  assert.equal(attempts,3);
  assert.equal(generated,2,'退出补写复用已生成的内容');
  assert.equal(workbook.status().state,'locked');
  assert.deepEqual(readFileSync(workbook.file),previous);
});

test('退出限时结束后迟到的生成结果不会覆盖可用工作簿',{timeout:3000},async t=>{
  const release=Promise.withResolvers();
  let generating=false,writes=0;
  const {workbook,change}=quitWorkbook(t,{
    async generate(rows){
      if(rows[0].title==='迟到岗位'){generating=true;await release.promise;}
      return exportJobRows(rows,'xlsx');
    },
    async replace(from,to){writes++;await rename(from,to);}
  });
  workbook.refresh();
  await until(()=>workbook.status().ready&&!workbook.status().pending);
  const previous=readFileSync(workbook.file);
  change('迟到岗位');
  await until(()=>generating);
  await workbook.flushAndClose(30);
  assert.equal(workbook.status().pending,true);
  release.resolve();
  await new Promise(done=>setImmediate(done));
  assert.equal(writes,1);
  assert.deepEqual(readFileSync(workbook.file),previous);
});

test('岗位实时工作簿在 Excel 占用时保留旧文件，并补写最新变化', async t => {
  const directory = mkdtempSync(join(tmpdir(),'xiaojing-workbook-'));
  let title = sample.title;
  let locked = false;
  let writes = 0;
  const workbook = createJobWorkbook({
    directory,
    rows:()=>projectJobRows({jobs:{id:{...sample,title}}}),
    delayMs:5,
    retryMs:60,
    replace:async (...args)=>{
      if(locked)throw Object.assign(new Error('locked'),{code:'EPERM'});
      await rename(...args);
      writes++;
    }
  });
  t.after(()=>workbook.close());
  workbook.refresh();
  await until(()=>workbook.status().ready&&!workbook.status().pending);
  const previous = readFileSync(workbook.file);
  assert.equal(previous.subarray(0,2).toString(),'PK');
  workbook.refresh();
  await until(()=>!workbook.status().pending);
  assert.equal(writes,1,'相同资料不重写');
  locked = true;
  title = '版本二';
  workbook.refresh();
  await until(()=>workbook.status().state==='locked');
  assert.deepEqual(readFileSync(workbook.file),previous);
  assert.equal(workbook.status().ready,true);
  title = '版本三';
  workbook.refresh();
  locked = false;
  await until(()=>workbook.status().state==='ready'&&!workbook.status().pending);
  assert.notDeepEqual(readFileSync(workbook.file),previous);
  assert.equal(writes,2,'解锁后只保存最新版本');
});

test('零字节实时工作簿不会标为可打开，同一份岗位数据也能重新生成',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'xiaojing-empty-workbook-'));
  const file=join(directory,'岗位实时.xlsx');
  writeFileSync(file,'');
  const rows=projectJobRows({jobs:{id:sample}});
  let writes=0;
  const workbook=createJobWorkbook({directory,rows:()=>rows,delayMs:5,replace:async (...args)=>{
    await rename(...args);writes++;
  }});
  t.after(()=>workbook.close());
  assert.equal(workbook.status().ready,false);
  workbook.refresh();
  await until(()=>workbook.status().ready&&!workbook.status().pending);
  assert.match(workbookSheet(file),/测试岗位/);
  assert.equal(writes,1);
  truncateSync(file);
  assert.equal(workbook.status().ready,false);
  workbook.refresh();
  await until(()=>workbook.status().ready&&!workbook.status().pending);
  assert.match(workbookSheet(file),/测试岗位/);
  assert.equal(writes,2);
  workbook.refresh();
  await until(()=>!workbook.status().pending);
  assert.equal(writes,2,'可用文件仍跳过同一份内容');
});

test('工作簿路径同名目录不会被当成文件或在重试时删除',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'xiaojing-workbook-directory-'));
  const file=join(directory,'岗位实时.xlsx');
  mkdirSync(file);
  const marker=join(file,'preserve.txt');
  writeFileSync(marker,'keep');
  const workbook=createJobWorkbook({directory,rows:()=>[],delayMs:5});
  t.after(()=>workbook.close());
  assert.equal(workbook.status().ready,false);
  workbook.refresh();
  await until(()=>['locked','error'].includes(workbook.status().state));
  assert.equal(workbook.status().ready,false);
  assert.equal(readFileSync(marker,'utf8'),'keep');
});

test('实时工作簿被替换后显示外部更改，原子重建失败时保留可用副本',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'xiaojing-external-workbook-'));
  const rows=projectJobRows({jobs:{id:sample}});
  let locked=false,writes=0;
  const workbook=createJobWorkbook({directory,rows:()=>rows,delayMs:5,retryMs:60,replace:async (...args)=>{
    if(locked)throw Object.assign(new Error('locked'),{code:'EPERM'});
    await rename(...args);writes++;
  }});
  t.after(()=>workbook.close());
  workbook.refresh();
  await until(()=>workbook.status().ready&&!workbook.status().pending);
  const stale=exportJobRows(projectJobRows({jobs:{id:{...sample,title:'旧副本岗位'}}}),'xlsx').body;
  writeFileSync(workbook.file,stale);
  assert.equal(workbook.status().externallyChanged,true);assert.equal(workbook.status().pending,false);
  assert.equal(writes,1);assert.deepEqual(readFileSync(workbook.file),stale);
  locked=true;workbook.refresh();
  await until(()=>workbook.status().state==='locked');
  assert.equal(workbook.status().ready,true);assert.equal(workbook.status().externallyChanged,true);
  assert.deepEqual(readFileSync(workbook.file),stale);
  locked=false;
  await until(()=>workbook.status().ready&&!workbook.status().pending);
  assert.equal(workbook.status().externallyChanged,false);assert.equal(writes,2);
  const sheet=workbookSheet(workbook.file);
  assert.match(sheet,/测试岗位/);assert.doesNotMatch(sheet,/旧副本岗位/);
});

test('实时岗位与下载只对主人开放，且导出同一组筛选结果', async t => {
  const port = await testPort();
  const local = mkdtempSync(join(tmpdir(),'xiaojing-jobs-api-'));
  const app = createApplication({port,local,key:'',desktop:true});
  app.server.listen(port,'127.0.0.1');
  await once(app.server,'listening');
  t.after(()=>app.shutdown());
  const base='http://127.0.0.1:'+port;
  const {token} = await(await fetch(base+'/api/session')).json();
  const response = await fetch(base+'/api/jobs/observe',{
    method:'POST',
    headers:{'X-Boss-Token':app.embeddedToken,'Content-Type':'application/json'},
    body:JSON.stringify({jobs:[sample,{...sample,url:'https://www.zhipin.com/job_detail/fixture2.html',title:'另一份工作'}]})
  });
  assert.equal(response.status,200);
  assert.equal((await fetch(base+'/api/jobs/table')).status,401);
  assert.equal((await fetch(base+'/api/jobs/export',{headers:{'X-Boss-Token':app.embeddedToken}})).status,403);
  const headers={'X-Boss-Token':token};
  const tableResponse=await fetch(base+'/api/jobs/table',{headers});
  const etag=tableResponse.headers.get('etag');
  const table=await tableResponse.json();
  assert.equal(table.rows.length,2);
  assert.equal(Object.hasOwn(table.rows[0],'lease'),false);
  assert(etag);
  assert.equal((await fetch(base+'/api/jobs/table',{headers:{...headers,'If-None-Match':etag}})).status,304);
  const pagedResponse=await fetch(base+'/api/jobs/table?page=3&pageSize=25&q='+encodeURIComponent('测试岗位'),{headers:{...headers,'If-None-Match':etag}});
  const paged=await pagedResponse.json();
  assert.equal(paged.total,1);
  assert.equal(paged.counts.all,2);
  assert.equal(paged.page,1);
  assert.equal(paged.rows[0].title,'测试岗位');
  assert.equal(Object.hasOwn(paged.rows[0],'description'),false);
  const detailUrl=base+'/api/jobs/detail?'+new URLSearchParams({id:paged.rows[0].id});
  assert.equal((await fetch(detailUrl,{headers:{'X-Boss-Token':app.embeddedToken}})).status,403);
  const related=Array.from({length:11},(_,i)=>[`boss:job-related-${i}`,{
    job:{url:sample.url+'?from=chat#job'},header:i===10?'较长的头部信息':i===9?'招聘标题':'',
    domIdentity:i===10?{name:'招聘姓名'}:undefined,history:[{text:'原始私聊正文'}],
    ...(i===9?{lastSeenAt:109}:{updatedAt:100+i}),
  }]);
  app.state.memories=Object.fromEntries([...related,
    ['boss:wrong-job',{job:{title:sample.title,company:sample.company,url:'https://www.zhipin.com/job_detail/another.html'},updatedAt:999}],
    ['boss:wrong-origin',{job:{url:'https://not-zhipin.example/job_detail/fixture.html'},updatedAt:999}],
    ['boss:userinfo',{job:{url:'https://login@www.zhipin.com/job_detail/fixture.html'},updatedAt:999}],
    ['boss:archived-role',{job:{title:sample.title,company:sample.company},jobHistory:[{job:{url:sample.url}}],updatedAt:999}],
  ]);
  const detail=await (await fetch(detailUrl,{headers})).json();
  assert.equal(detail.description,table.rows.find(row=>row.id===paged.rows[0].id).description);
  assert.deepEqual(detail.relatedConversations,related.slice(1).reverse().map(([peerId,c])=>({peerId,label:c.domIdentity?.name||c.header||'HR 会话'})));
  assert.doesNotMatch(JSON.stringify(detail),/原始私聊正文|较长的头部信息/);
  const unlinked=await (await fetch(base+'/api/jobs/detail?'+new URLSearchParams({id:table.rows.find(row=>row.id!==detail.id).id}),{headers})).json();
  assert.deepEqual(unlinked.relatedConversations,[]);
  const cachedTable=await (await fetch(base+'/api/jobs/table',{headers})).json();
  assert.deepEqual(cachedTable.rows,table.rows);
  const jsonExport=await (await fetch(base+'/api/jobs/export?format=json',{headers})).json();
  assert.deepEqual(jsonExport.jobs,table.rows);
  const compact=await (await fetch(base+'/api/state?view=desktop',{headers})).json();
  assert.equal(compact.jobCount,2);
  assert.equal(Object.hasOwn(compact,'jobs'),false);
  assert.equal(Object.hasOwn(compact,'snapshots'),false);
  const csv=await fetch(base+'/api/jobs/export?format=csv&q='+encodeURIComponent('测试岗位'),{headers});
  assert.match(csv.headers.get('content-disposition'),/\.csv/);
  const csvText=await csv.text();assert.match(csvText,/测试岗位/);assert.doesNotMatch(csvText,/relatedConversations|boss:job-related|招聘姓名|招聘标题|原始私聊正文/);
  const xlsx=await fetch(base+'/api/jobs/export?format=xlsx',{headers});
  assert.equal(Buffer.from(await xlsx.arrayBuffer()).subarray(0,2).toString(),'PK');
  assert.equal((await fetch(base+'/api/jobs/export?format=exe',{headers})).status,400);
  const progressUrl=base+'/api/jobs/table?page=1&stage=pending';
  const before=await fetch(progressUrl,{headers});
  const beforeTag=before.headers.get('etag');
  assert.equal((await before.json()).total,0);
  app.state.tasks.unshift({id:'fixture-progress',kind:'greeting',action:'hold',status:'hold',job:{url:sample.url}});
  const reviewed=await fetch(base+'/api/review',{
    method:'POST',headers:{...headers,'Content-Type':'application/json'},
    body:JSON.stringify({id:'fixture-progress',approve:true,text:'合成测试草稿'})
  });
  assert.equal(reviewed.status,200);
  const after=await fetch(progressUrl,{headers:{...headers,'If-None-Match':beforeTag}});
  assert.equal(after.status,200);
  const pending=await after.json();
  assert.equal(pending.rows[0].progress.status,'pending');
  assert.equal(pending.rows[0].id,paged.rows[0].id);
  const exportProgress=await (await fetch(base+'/api/jobs/export?format=json&stage=pending',{headers})).json();
  assert.equal(exportProgress.total,1);
  assert.equal(exportProgress.jobs[0].progress.contact,'unknown');
  assert.doesNotMatch(JSON.stringify(exportProgress),/合成测试草稿/);
  const now=t.mock.method(Date,'now',()=>Date.UTC(2026,10,7,16,10));
  try{
    const midnight=await fetch(base+'/api/jobs/export?format=json',{headers});
    assert.match(midnight.headers.get('content-disposition'),/xiaojing-jobs-2026-11-08\.json/);
    assert.equal((await midnight.json()).generatedAt,'2026-11-07T16:10:00.000Z');
  }finally{now.mock.restore();}
});

test('实际收藏入口在岗位详情、JSON 和 Excel 中保持同一条安全链接',async t=>{
  const port=await testPort(),local=mkdtempSync(join(tmpdir(),'xiaojing-favorite-source-export-'));
  const app=createApplication({port,local,key:'',desktop:true});
  app.server.listen(port,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.shutdown());
  const base='http://127.0.0.1:'+port;
  const {token}=await(await fetch(base+'/api/session')).json(),headers={'X-Boss-Token':token};
  const collection='https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=1&tag=4';
  const response=await fetch(base+'/api/favorites/observe',{
    method:'POST',headers:{'X-Boss-Token':app.embeddedToken,'Content-Type':'application/json'},
    body:JSON.stringify({kind:'list',confirmedList:true,url:collection+'&securityId=fixture-private-source',evidence:'合成收藏页和可见卡片',jobs:[sample]}),
  });
  assert.equal(response.status,200);
  const {ids:[id]}=await response.json();
  const detail=await(await fetch(base+'/api/jobs/detail?'+new URLSearchParams({id}),{headers})).json();
  const json=await(await fetch(base+'/api/jobs/export?source=favorite&format=json',{headers})).json();
  assert.equal(detail.sourcePage,collection);assert.equal(json.jobs[0].sourcePage,collection);
  assert.doesNotMatch(JSON.stringify([detail,json]),/fixture-private-source/);
  const xlsx=await fetch(base+'/api/jobs/export?source=favorite&format=xlsx',{headers});assert.equal(xlsx.status,200);
  const relationships=workbookPart(Buffer.from(await xlsx.arrayBuffer()),'xl/worksheets/_rels/sheet1.xml.rels');
  assert(relationships.includes(`Target="${collection.replaceAll('&','&amp;')}" TargetMode="External"`));
  assert.doesNotMatch(relationships,/securityId|fixture-private-source/);
});

test('招呼队列识别详情租约超时后同步岗位表、ETag、JSON 导出和实时 Excel',async t=>{
  const port=await testPort(),local=mkdtempSync(join(tmpdir(),'xiaojing-job-lease-sync-'));
  const app=createApplication({port,local,desktop:true,key:'fixture',greetingIntervalMs:60000,autonomyIntervalMs:60000,
    inference:()=>{assert.fail('合成岗位超时无需调用模型');}});
  app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
  t.after(()=>app.shutdown());
  const base='http://127.0.0.1:'+port;
  const {token}=await(await fetch(base+'/api/session')).json();
  const request=(path,body,extension=false,headers={})=>fetch(base+path,{
    method:body===undefined?'GET':'POST',headers:{'X-Boss-Token':extension?app.embeddedToken:token,'Content-Type':'application/json',...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  const api=async (...args)=>{const response=await request(...args);const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
  app.state.config.profile={...app.state.config.profile,name:'合成主人',facts:'仅供测试的资料',titles:['游戏策划'],cities:['北京'],earlyCareerOnly:false};
  app.state.config.browserCalibrated=true;app.state.config.favoritesFirst=false;
  setChannelFlags(app.state.config,{jobSearch:true});
  await api('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/job',diagnostics:{extensionVersion:'0.32.0',adapter:'0.32.0'}},true);
  const fixture={...sample,title:'游戏策划实习',city:'北京',experience:'在校/应届'};
  const {ids:[id]}=await api('/api/jobs/observe',{jobs:[fixture]},true);
  await api('/api/greetings',{count:1,requestId:'fixture-job-timeout',instruction:'仅测试岗位详情租约',jobIds:[id]});
  const {job}=await api('/api/crawl/next',{},true);
  assert.equal(job.id,id);assert.equal(job.status,'reading');
  const table='/api/jobs/table?page=1';
  await until(()=>app.jobWorkbook.status().ready&&!app.jobWorkbook.status().pending);
  const before=await request(table),beforeTag=before.headers.get('etag');
  assert.equal((await before.json()).rows[0].status,'reading');
  assert.match(workbookSheet(app.jobWorkbook.file),/正在读取/);
  app.state.jobs[id].reservedAt=Date.now()-180001;
  assert.deepEqual(await api('/api/work',undefined,true),{task:null});
  const after=await request(table,undefined,false,{'If-None-Match':beforeTag});
  assert.equal(after.status,200);assert.notEqual(after.headers.get('etag'),beforeTag);
  assert.equal((await after.json()).rows[0].status,'needs_adaptation');
  assert.equal((await api('/api/jobs/export?format=json')).jobs[0].status,'needs_adaptation');
  assert.equal(JSON.parse(readFileSync(join(local,'state.json'))).jobs[id].status,'needs_adaptation');
  const index=join(local,'memory','jobs','index.json');
  assert.equal(JSON.parse(readFileSync(index)).jobs[0].status,'needs_adaptation');
  assert.equal(app.state.jobs[id].lease,undefined);
  assert.equal((await request('/api/crawl/complete',{id,lease:job.lease,url:job.url,success:true},true)).status,400);
  await until(()=>app.jobWorkbook.status().ready&&!app.jobWorkbook.status().pending);
  const sheet=workbookSheet(app.jobWorkbook.file);
  assert.match(sheet,/待校准/);assert.doesNotMatch(sheet,/正在读取/);
  const fileState=statSync(index,{bigint:true});
  const currentTag=(await request(table)).headers.get('etag');
  for(let i=0;i<3;i++)assert.deepEqual(await api('/api/work',undefined,true),{task:null});
  assert.equal(statSync(index,{bigint:true}).mtimeNs,fileState.mtimeNs);
  assert.equal((await request(table,undefined,false,{'If-None-Match':currentTag})).status,304);
  assert.equal(app.jobWorkbook.status().pending,false);
  assert.deepEqual(await api('/api/crawl/next',{},true),{job:null});
});
