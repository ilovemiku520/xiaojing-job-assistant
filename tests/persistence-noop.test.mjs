import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {defaults} from '../server/core.mjs';
import {testPort} from './port.mjs';

const profile={name:'模拟主人',facts:'虚构求职资料',titles:['游戏策划'],cities:['北京']};
const heartbeat={page:'https://www.zhipin.com/web/geek/job',diagnostics:{extensionVersion:'0.13.3',adapter:'0.13.3'}};
const reply={action:'send_text',text:'你好，小鲸可以介绍主人的游戏设计项目。',reason:'测试回复',score:95};
const job={url:'https://www.zhipin.com/job_detail/noop-fixture.html',title:'游戏策划实习',company:'合成游戏公司',city:'北京'};
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const fileSnapshot=path=>({content:readFileSync(path,'utf8'),modified:statSync(path,{bigint:true}).mtimeNs});
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));

async function start(t,local,extra={}){
  const port=await testPort();
  const app=createApplication({port,local,key:'fixture',greetingIntervalMs:60000,autonomyIntervalMs:60000,inference:async()=>reply,...extra});
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const stop=async()=>{
    if(!app.server.listening)return;
    const closed=once(app.server,'close');
    app.shutdown();
    app.server.closeAllConnections();
    await closed;
  };
  t.after(stop);
  const base='http://127.0.0.1:'+port,{token,extensionToken}=await(await fetch(base+'/api/session')).json();
  async function api(path,data,owner=false){
    const response=await fetch(base+path,{method:data?'POST':'GET',headers:{
      'Content-Type':'application/json','X-Boss-Token':owner?token:extensionToken
    },...(data?{body:JSON.stringify(data)}:{})});
    const value=await response.json();
    assert(response.ok,value.error);
    return value;
  }
  async function run(browserCalibrated=false){
    await api('/api/config',{profile,backend:'api',mode:'auto',browserCalibrated,learningEnabled:false,autoResume:false,
      autoSearchEnabled:false,favoritesFirst:false,limits:{hoursStart:0,hoursEnd:24,intervalSeconds:0}},true);
    await api('/api/run',{running:true},true);
    await api('/api/heartbeat',heartbeat);
  }
  return {app,api,run,stop};
}

test('空闲采集和心跳不重写相同状态，浏览器诊断实时可读，缺少状态文件时会补写',async t=>{
  const local=mkdtempSync(join(tmpdir(),'xiaojing-idle-persist-')),file=join(local,'state.json');
  writeFileSync(file,JSON.stringify({config:defaults,tasks:[],events:[],browserWorker:{at:123,phase:'旧会话'}}));
  const {api,run}=await start(t,local);
  assert.equal(read(file).browserWorker,undefined);
  await run();
  assert.equal((await api('/api/crawl/next',{})).job,null);
  const settled=fileSnapshot(file);
  for(let index=1;index<=3;index++){
    await tick();
    await api('/api/heartbeat',heartbeat);
    await api('/api/worker-health',{phase:'轮询 '+index,lastWorkAt:index,extensionVersion:'0.13.3'});
    assert.equal((await api('/api/crawl/next',{})).job,null);
    const state=await api('/api/state',undefined,true);
    assert.equal(state.workerHealth.lastWorkAt,index);
    assert.deepEqual(state.browserWorker,state.workerHealth);
    assert.deepEqual(fileSnapshot(file),settled);
  }
  unlinkSync(file);
  assert.equal((await api('/api/crawl/next',{})).job,null);
  assert.equal(fileSnapshot(file).content,settled.content);
});

test('招呼等待校准时轮询不改写文件，委托到期和长期目标变化仍同步保存',async t=>{
  const local=mkdtempSync(join(tmpdir(),'xiaojing-waiting-persist-')),file=join(local,'state.json');
  const checkpoint=join(local,'memory','project','latest.json'),journal=join(local,'control','events.jsonl');
  const {app,api,run}=await start(t,local);
  await run();
  const {plan}=await api('/api/greetings',{requestId:'waiting',instruction:'测试一条招呼',count:1},true);
  assert.equal((await api('/api/work')).task,null);
  assert.match(read(file).greetingPlans[0].waitingReason,/尚未校准/);
  const snapshots=[file,checkpoint,journal].map(fileSnapshot);
  for(let index=0;index<3;index++){
    await tick();
    assert.equal((await api('/api/work')).task,null);
    assert.equal((await api('/api/crawl/next',{})).job,null);
  }
  assert.deepEqual([file,checkpoint,journal].map(fileSnapshot),snapshots);
  app.state.greetingPlans[0].expiresAt=Date.now()-1;
  await api('/api/work');
  const expired=read(file).greetingPlans[0];
  assert.equal(expired.status,'expired');
  assert(expired.finishedAt);
  assert(!read(checkpoint).greetingPlans.some(row=>row.id===plan.id));
  const entries=readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert(entries.some(row=>row.kind==='greeting'&&row.id===plan.id&&row.status==='expired'));

  const goal='从已明确的城市寻找模拟游戏策划岗位';
  await api('/api/autonomy',{enabled:true,goal},true);
  assert.equal(read(file).autonomy.goal,goal);
  assert.equal(read(join(local,'memory','agent','goal.json')).goal,goal);
});

test('岗位租约与发送租约在返回前保存，岗位超时和服务重启保留已核对恢复状态',async t=>{
  const local=mkdtempSync(join(tmpdir(),'xiaojing-lease-persist-')),file=join(local,'state.json');
  const jobIndex=join(local,'memory','jobs','index.json');
  const checkpoint=join(local,'memory','project','latest.json');
  const first=await start(t,local);
  await first.run(true);
  const {ids}=await first.api('/api/jobs/observe',{jobs:[job]});
  const {job:reading}=await first.api('/api/crawl/next',{});
  assert(reading.lease);
  assert.equal(read(file).jobs[ids[0]].lease,reading.lease);
  assert.equal(read(jobIndex).jobs[0].status,'reading');
  assert.equal(read(jobIndex).jobs[0].lease,undefined);
  first.app.state.jobs[ids[0]].reservedAt=Date.now()-181000;
  assert.equal((await first.api('/api/crawl/next',{})).job,null);
  assert.equal(read(file).jobs[ids[0]].status,'needs_adaptation');
  assert.equal(read(file).jobs[ids[0]].lease,undefined);
  assert.equal(read(jobIndex).jobs[0].status,'needs_adaptation');

  const {task}=await first.api('/api/prepare',{kind:'reply',trigger:'new_hr_message',peerId:'boss:persistence-fixture',job,
    messages:[{id:'hr-fixture',role:'hr',text:'可以介绍一下项目经历吗？'}]});
  const {lease}=await first.api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint});
  assert(lease);
  assert.equal(read(file).tasks[0].status,'executing');
  assert.equal(read(file).tasks[0].lease,lease);
  await first.stop();

  const second=await start(t,local);
  const recovered=read(file);
  assert.equal(recovered.jobs[ids[0]].status,'needs_adaptation');
  assert.equal(recovered.tasks[0].status,'uncertain');
  assert.equal(recovered.tasks[0].lease,undefined);
  assert.equal(read(checkpoint).counts.unconfirmedSends,1);
  assert.equal((await second.api('/api/check',{id:task.id,lease})).allowed,false);
});
